#!/usr/bin/env node
// boss-cdp.mjs — Linux CDP 传输层（boss-chrome-*.mjs 的本地适配，替代 macOS osascript）
// 【恢复副本 2026-09-22】原文件随项目目录被误删，内容从会话重建
//
// 语义对齐 AppleScript `execute active tab of front window javascript`：
//   - 在目标标签页执行 JS，把结果字符串打印到 stdout（空结果打印空）
//   - 页面内异常 / CDP 不可用 → stderr + exit 1（等价 osascript 非零退出）
//   - 非字符串结果按 String() 打印（等价 AppleScript 的字符串化行为）
//
// CLI:
//   node boss-cdp.mjs --eval '<js>'     执行 JS 并打印结果（boss-chrome-*.mjs 调用入口）
//   node boss-cdp.mjs --probe           打印标签页清单与焦点状态（JSON，诊断用）
//   node boss-cdp.mjs --goto <url>      在 zhipin 标签页（或新标签页）打开 URL 并等加载完成
//
// 环境变量：BOSS_CDP_PORT（默认 9222）、BOSS_TRANSPORT=cdp|osascript（脚本侧开关）

import { pathToFileURL } from 'url';

const PORT = Number(process.env.BOSS_CDP_PORT || process.env.CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;
const CALL_TIMEOUT_MS = Number(process.env.BOSS_CDP_TIMEOUT || 30000);

const wsCache = new Map(); // targetId -> WebSocket
let cachedTarget = null;
let seq = 0;

function assertAvailable() {
  return fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) })
    .then((r) => {
      if (!r.ok) throw new Error(`CDP /json/version HTTP ${r.status}`);
      return r.json();
    });
}

async function listPages() {
  const res = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  const targets = await res.json();
  return targets.filter(
    (t) => t.type === 'page'
      && t.webSocketDebuggerUrl
      && !/^devtools:|^chrome-extension:|^chrome-error:/i.test(t.url || ''),
  );
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP WebSocket 连接超时'));
    }, 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket 连接失败（${url.replace(/^ws:\/\/[^/]+/, 'ws://<host>')}）`));
    }, { once: true });
  });
}

async function getWs(target) {
  const cached = wsCache.get(target.id);
  if (cached && cached.readyState === WebSocket.OPEN) return cached;
  if (cached) { try { cached.close(); } catch {} wsCache.delete(target.id); }
  const ws = await connect(target.webSocketDebuggerUrl);
  ws.addEventListener('close', () => wsCache.delete(target.id));
  wsCache.set(target.id, ws);
  return ws;
}

function call(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`CDP ${method} 超时（${CALL_TIMEOUT_MS}ms）`));
    }, CALL_TIMEOUT_MS);
    const onMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluateIn(target, expression) {
  const ws = await getWs(target);
  const { result, exceptionDetails } = await call(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    userGesture: true,
  });
  if (exceptionDetails) {
    const text = exceptionDetails.exception?.description
      || exceptionDetails.text
      || '页面 JS 执行失败';
    throw new Error(`页面 JS 执行失败: ${String(text).split('\n')[0]}`);
  }
  const value = result?.value;
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

async function hasFocus(target) {
  try {
    return (await evaluateIn(target, 'document.hasFocus()')) === 'true';
  } catch {
    return false;
  }
}

// 焦点标签页 → zhipin 标签页 → 首个标签页（等价"前台窗口的活动标签"回退链）
async function resolveTarget() {
  await assertAvailable();
  if (cachedTarget) {
    const pages = await listPages();
    if (pages.some((p) => p.id === cachedTarget.id)) return cachedTarget;
    cachedTarget = null;
  }
  const pages = await listPages();
  if (!pages.length) throw new Error('CDP 无可用标签页（Chrome 已打开？）');
  for (const page of pages) {
    if (await hasFocus(page)) { cachedTarget = page; return page; }
  }
  const boss = pages.find((p) => /(^|\.)zhipin\.com/i.test(new URL(p.url, 'https://x').hostname || ''));
  if (boss) { cachedTarget = boss; return boss; }
  cachedTarget = pages[0];
  return pages[0];
}

async function cdpExecJs(js) {
  const target = await resolveTarget();
  return evaluateIn(target, js);
}

async function cdpExecJson(js, fallback = null) {
  const raw = await cdpExecJs(js);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

async function gotoUrl(url, { waitMs = 25000 } = {}) {
  const pages = await listPages();
  let target = pages.find((p) => /(^|\.)zhipin\.com/i.test(new URL(p.url, 'https://x').hostname || ''));
  if (!target) {
    const blankish = pages.find((p) => /^about:blank$|^chrome:\/\/newtab/.test(p.url || ''));
    target = blankish || null;
  }
  if (!target) {
    const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`CDP 新建标签页失败 HTTP ${res.status}`);
    target = await res.json();
  } else {
    const ws = await getWs(target);
    await call(ws, 'Page.navigate', { url });
  }
  cachedTarget = target;

  const started = Date.now();
  let lastUrl = url;
  while (Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const state = await cdpExecJson(
        `JSON.stringify({ready: document.readyState, url: location.href, title: document.title})`,
        null,
      );
      if (state) {
        lastUrl = state.url || lastUrl;
        if (state.ready === 'complete') {
          await new Promise((r) => setTimeout(r, 600)); // 留给 SPA 首屏渲染
          return { ok: true, url: lastUrl, title: state.title || '' };
        }
      }
    } catch {
      // 导航中 evaluate 可能瞬时失败，继续轮询
    }
  }
  return { ok: false, url: lastUrl, reason: '加载超时' };
}

async function probe() {
  let version = null;
  try { version = await assertAvailable(); } catch (err) {
    return JSON.stringify({ available: false, port: PORT, error: err.message }, null, 2);
  }
  const pages = await listPages();
  const tabs = [];
  for (const p of pages) {
    tabs.push({
      id: p.id,
      title: p.title || '',
      url: p.url || '',
      hasFocus: await hasFocus(p).catch(() => false),
    });
  }
  return JSON.stringify({
    available: true,
    port: PORT,
    browser: version.Browser,
    tabs,
    active: tabs.find((t) => t.hasFocus) || null,
  }, null, 2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--probe') {
    console.log(await probe());
    return;
  }
  if (argv[0] === '--goto') {
    const url = argv[1];
    if (!url) throw new Error('--goto 需要 URL 参数');
    const out = await gotoUrl(url);
    console.log(JSON.stringify(out));
    return;
  }
  if (argv[0] === '--eval') {
    const js = argv[1];
    if (js === undefined) throw new Error('--eval 需要 JS 表达式参数');
    const out = await cdpExecJs(js);
    if (out !== '') console.log(out);
    return;
  }
  console.error('Usage: node boss-cdp.mjs --eval \'<js>\' | --probe | --goto <url>');
  process.exit(2);
}

export { assertAvailable, cdpExecJs, cdpExecJson, gotoUrl, listPages, probe, resolveTarget };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => {
    // 关闭缓存的 WebSocket，让事件循环自然排空；保底定时器防挂起
    for (const ws of wsCache.values()) { try { ws.close(); } catch {} }
    wsCache.clear();
    setTimeout(() => process.exit(0), 300).unref();
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
