#!/usr/bin/env node

// boss/boss-analyze.mjs — LLM 深度解析：cv.md + 岗位 JD → 标准 JSON（一次性全部解析并存库）
//
// 2026-10-30 用户要求：「简历 md 和岗位 JD 一起发给模型，给一个标准模板，一次性全部解析存下来」。
//
// 与 boss:score 的关系：
//   - boss:score      —— 规则评分（可复现、可调阈值），顺带用 LLM 写**一条招呼语**（轻量，便宜）；
//   - boss:analyze    —— 深度解析（贵、慢，单条实测 ~26–33s / ~0.7 credit），产出结构化字段：
//                        seniority / 外包判定 / 技术栈 / 职责 / 红线 / 匹配点 / 缺口 / 匹配分 / 招呼语。
//   本命令**不改** score 列：发送资格仍以规则分为准，LLM 分只存 llm_score 作参考（用户 2026-10-30 确认）。
//
// 默认只解析「本轮可发送」那批（score >= 阈值、未打招呼、未关闭、未人工暂缓），并跳过已解析过的岗位，
// 所以重复执行是安全的增量行为（--force 才重解析，--all 才放开到全部已评分岗位）。

import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import {
  loadCandidates,
  loadProfile,
  parseArgs,
  saveJobAnalysis,
  uniqueCompanyPlacementKey,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import { analyzeJobsChunked, isContacted, llmReadiness, resolveLlmConfig } from './boss-llm.mjs';
import { BATCH_SCHEMA_VERSION, withJobIdentity } from './boss-llm-schema.mjs';

const BOSS_CONTROL = await loadBossControl();
const CV_PATH = 'cv.md';
// 单条实测成本（cn:deepseek-v4.1-flash，cv.md 4k prompt + 6k completion）——只用于开工前报价，不参与决策
const EST_CREDIT_PER_JOB = 0.7;

function truthy(value) {
  return value === true || value === 'true';
}

function loadCv(path) {
  if (!existsSync(path)) throw new Error(`找不到简历文件：${path}（深解析必须读 cv.md，不做降级）`);
  const text = readFileSync(path, 'utf-8').trim();
  if (text.length < 200) throw new Error(`简历内容过短（${text.length} 字符），不像完整 cv.md：${path}`);
  return text;
}

// 选岗位：默认「本轮可发送」的增量批次
function selectJobs(jobs, cfg) {
  const threshold = Number(cfg.send_threshold) || 3;
  return jobs.filter((job) => {
    if (job.availability === 'closed' || job.status === 'closed') return false;
    if (job.manual_excluded) return false;
    // 已发送/已联系过的一律不再深解析（greeted 或 contact_state 命中）
    if (isContacted(job)) return false;
    if (job.score == null) return false;
    return Number(job.score) >= threshold;
  });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log([
      'Usage: node boss-analyze.mjs [--limit 20] [--city 上海] [--key-hash a,b] [--all] [--force] [--dry-run]',
      '',
      '  --limit N        本次最多解析多少条（默认 20，控制花费）',
      '  --city 城市      只解析该城市',
      '  --key-hash a,b   点名解析指定岗位（绕过「可发送」筛选）',
      '  --all            放开到「全部已评分岗位」，不再只看本轮可发送',
      '  --force          重解析已有解析结果的岗位（默认跳过 = 增量）',
      '  --cv path        简历路径（默认 cv.md）',
      '  --dry-run        只解析 1 条并打印结果，不写库',
      '  每批条数由控制台「每批岗位数」决定（默认 100，即一次请求带满 100 条）',
      '',
      `模板版本：${BATCH_SCHEMA_VERSION}　批量实测 ≈0.13–0.25 credit/条`,
    ].join('\n'));
    return;
  }

  const cfg = await loadBossControl();
  const llm = resolveLlmConfig(cfg);
  const ready = llmReadiness(llm);
  if (!ready.ok) {
    throw new Error(`LLM 未就绪，无法深解析：${ready.reason}（在控制台「LLM 招呼语」里配置后再试）`);
  }

  const cv = loadCv(String(args.cv || CV_PATH));
  const all = truthy(args.all);
  const force = truthy(args['force']);
  const dryRun = truthy(args['dry-run']);
  // 条数上限：--limit 优先；不传时用控制台配置（0 = 不限）。dry-run 固定只解析 1 条。
  const limitArg = args.limit != null ? Number(args.limit) : (dryRun ? 1 : 20);
  const unlimited = !dryRun && limitArg === 0;
  const limit = unlimited ? Infinity : Math.max(1, Number.isFinite(limitArg) ? limitArg : 20);
  const cityFilter = String(args.city || '').trim();
  const keyHashes = String(args['key-hash'] || '').split(',').map((s) => s.trim()).filter(Boolean);

  let jobs = await loadCandidates();
  if (keyHashes.length) {
    const wanted = new Set(keyHashes);
    jobs = jobs.filter((job) => wanted.has(String(job.key_hash || '')));
  } else {
    if (!all) jobs = selectJobs(jobs, cfg);
    if (cityFilter) jobs = jobs.filter((job) => String(job.city || '').split('·')[0] === cityFilter);
  }
  // 增量：默认跳过已有解析结果的岗位（raw.llm 有内容）
  if (!force && !keyHashes.length) {
    jobs = jobs.filter((job) => {
      const existing = job.llm;
      return !(existing && typeof existing === 'object' && existing.greeting && existing.match);
    });
  }
  // 同一批次里一家公司只留一条（解析结果对同公司的近似岗位高度重复，没必要重复付费）
  const seenCompany = new Set();
  jobs = jobs
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
    .filter((job) => {
      const key = uniqueCompanyPlacementKey(job);
      if (seenCompany.has(key)) return false;
      seenCompany.add(key);
      return true;
    })
    .slice(0, unlimited ? undefined : limit);

  if (!jobs.length) {
    console.log(JSON.stringify({
      ok: true,
      total: 0,
      message: all ? '没有待解析的岗位（可能都解析过了，加 --force 重解析）' : '本轮可发送里没有待解析的岗位（加 --all 或 --key-hash）',
    }, null, 2));
    return;
  }

  console.error(`[boss-analyze] ${llm.protocol} · ${llm.model} · 每批 ${llm.batchSize} 条（一次请求）· 模板 v${BATCH_SCHEMA_VERSION}`);
  console.error(`[boss-analyze] 待解析 ${jobs.length} 条，批量预估 ≈${(jobs.length * 0.15).toFixed(1)} credit（实测 0.13–0.25 credit/条）`);

  const failed = [];
  let okCount = 0;
  const batchResult = await analyzeJobsChunked({
    jobs,
    cv,
    cfg: llm,
    onItem: async ({ key_hash, analysis }) => {
      const job = jobs.find((item) => item.key_hash === key_hash);
      if (!job) return;
      okCount += 1;
      if (!dryRun) {
        try {
          await saveJobAnalysis(key_hash, withJobIdentity(analysis, job), { model: llm.model, protocol: llm.protocol, latencyMs: null, usage: null });
        } catch (err) {
          failed.push({ key: key_hash, company: job.company, title: job.title, error: `落库失败：${err.message}` });
          return;
        }
        console.error(`[boss-analyze] ✓ ${job.company} / ${job.title} → LLM ${analysis.match.score} 分（${analysis.match.level}） 规则 ${job.score} 分`);
      } else {
        console.error('\n[boss-analyze] 样例解析结果：');
        console.error(JSON.stringify(analysis, null, 2));
      }
    },
  });
  for (const item of batchResult.failed) failed.push({ key: item.job.key_hash, company: item.job.company, title: item.job.title, error: item.error });
  for (const line of batchResult.errors) console.error(`[boss-analyze] ${line}`);

  console.log(JSON.stringify({
    ok: true,
    model: llm.model,
    protocol: llm.protocol,
    schemaVersion: BATCH_SCHEMA_VERSION,
    dryRun,
    total: jobs.length,
    analyzed: okCount,
    requests: batchResult.requests,
    splits: batchResult.fallbackSplits,
    failed: failed.length,
    failedItems: failed.slice(0, 10),
    creditsSpent: Number(Number(batchResult.usage.credit || 0).toFixed(2)),
    note: dryRun ? 'dry-run：未写库' : '已写 boss_jobs.raw.llm（+ llm_score 列）；规则分未改动',
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

// 供测试直接校验筛选语义（不需要连库）
export { selectJobs as selectAnalyzeJobs, EST_CREDIT_PER_JOB };






