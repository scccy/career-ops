#!/usr/bin/env node
// boss-check-closed.mjs — 批量检查池中待发岗位是否已在 BOSS 下线（职位已关闭）
//
// 检查范围：greeted=0 且 score≥阈值 的岗位（即将进入发送队列的那批），
// 可选 --city 单城、--limit 限本轮检查条数。已标记 closed 的自动跳过。
// 检测方式与 boss-chrome-apply 完全一致：CDP 打开岗位页，
// 页面文本含「职位已关闭」即判定下线 → 标记 status='closed' 出局。
//
// 用法：node boss-check-closed.mjs [--city 上海] [--limit 100] [--gap-ms 1500] [--threshold 3]
// 前置：BOSS Chrome 已启动（9222 调试端口）

import { pathToFileURL } from 'url';
import {
  parseArgs,
  loadCandidates,
  markJobsClosed,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import { assertAvailable, cdpExecJs, closeAllConnections } from './boss-cdp.mjs';

const BOSS_CONTROL = await loadBossControl().catch(() => ({}));

async function execJs(js) {
  return cdpExecJs(js);
}

async function execJson(js, fallback = null) {
  const raw = await execJs(js);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicateJs, timeoutMs = 15000, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let ok = false;
    try {
      ok = await execJson(predicateJs, false);
    } catch {
      ok = false; // 页面导航间隙 CDP evaluate 可能瞬时失败：视为未就绪
    }
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function main() {
  const args = parseArgs();
  const threshold = Number(args.threshold ?? BOSS_CONTROL.send_threshold ?? 3.0);
  const limit = Number(args.limit ?? 100);
  const gapMs = Number(args['gap-ms'] ?? 1500);
  const city = args.city ? String(args.city) : '';

  // 用 Node fetch 检查 CDP，避免 Windows 缺 curl 或 curl 参数不同。
  try {
    await assertAvailable();
  } catch {
    throw new Error('CDP 9222 不通：请先启动 BOSS Chrome（npm run boss:chrome:start）');
  }

  const all = await loadCandidates();
  let targets = all.filter((job) =>
    !job.greeted
    && !job.manualExcluded
    && job.key_hash
    && Number(job.score) >= threshold
    && String(job.status || '') !== 'closed',
  );
  if (city) targets = targets.filter((j) => String(j.city || '').split('·')[0] === city);
  targets.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const capped = targets.slice(0, limit);
  console.log(`待检查 ${targets.length} 条（本轮 ${capped.length} 条，score≥${threshold}${city ? '，城市=' + city : ''}）`);
  if (!capped.length) {
    console.log(JSON.stringify({ checked: 0, closed: 0, errors: 0, unchecked: 0 }, null, 2));
    return;
  }

  const closedKeys = [];
  let checked = 0, closedCount = 0, errCount = 0;
  const flush = async () => {
    if (!closedKeys.length) return;
    try {
      const marked = await markJobsClosed(closedKeys.splice(0));
      console.log(`[boss-db] 已标记 ${marked} 条 closed 出局（增量）`);
    } catch (err) {
      console.error(`[boss-db] closed 标记失败: ${err.message}`);
    }
  };
  for (const job of capped) {
    try {
      await execJs(`location.href = ${JSON.stringify(job.url)}; 'navigating'`);
      const loaded = await waitFor(
        `JSON.stringify(document.readyState === 'complete' || (document.body?.innerText || '').includes(${JSON.stringify(job.title || '')}))`,
        25000,
        700,
      );
      if (!loaded) { errCount++; console.log(`error: ${job.company} - ${job.title}: 页面加载超时`); continue; }
      await sleep(gapMs);
      const closed = await execJson('JSON.stringify((document.body.innerText||"").includes("职位已关闭"))', false);
      checked++;
      if (closed) {
        closedCount++;
        closedKeys.push(job.key_hash);
        console.log(`closed: ${job.company} - ${job.title}`);
        if (closedKeys.length >= 10) await flush(); // 增量入库：中途终止/崩溃不丢发现
      } else {
        console.log(`ok: ${job.company} - ${job.title} (score=${job.score})`);
      }
    } catch (err) {
      errCount++;
      console.log(`error: ${job.company} - ${job.title}: ${err.message}`);
    }
  }
  await flush();
  const summary = { checked, closed: closedCount, errors: errCount, unchecked: targets.length - capped.length };
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(closeAllConnections);
}
