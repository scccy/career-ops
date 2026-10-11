#!/usr/bin/env node
// boss-cdp.mjs — 跨平台 CDP 传输层（所有平台共用用户启动的 Chrome）
// 【恢复副本 2026-09-22】原文件随项目目录被误删，内容从会话重建
//
// 语义对齐 AppleScript `execute active tab of front window javascript`：
//   - 在目标标签页执行 JS，把结果字符串打印到 stdout（空结果打印空）
//   - 页面内异常 / CDP 不可用 → stderr + exit 1
//   - 非字符串结果按 String() 打印
//
// CLI:
//   node boss-cdp.mjs --eval '<js>'     执行 JS 并打印结果（boss-chrome-*.mjs 调用入口）
//   node boss-cdp.mjs --probe           打印标签页清单与焦点状态（JSON，诊断用）
//   node boss-cdp.mjs --goto <url>      在 zhipin 标签页（或新标签页）打开 URL 并等加载完成
//
// 环境变量：BOSS_CDP_PORT（默认 9222）、BOSS_CDP_TIMEOUT（默认 30 秒）

import { pathToFileURL } from 'url';

const PORT = Number(process.env.BOSS_CDP_PORT || process.env.CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;
const CALL_TIMEOUT_MS = Number(process.env.BOSS_CDP_TIMEOUT || 30000);
const WS = globalThis.WebSocket || (await import('ws')).default;

if (process.env.BOSS_TRANSPORT && process.env.BOSS_TRANSPORT !== 'cdp') {
  throw new Error('BOSS_TRANSPORT=osascript 已弃用；BOSS Chrome 控制现统一使用 CDP。');
}

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
    const ws = new WS(url);
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
  if (cached && cached.readyState === WS.OPEN) return cached;
  if (cached) { try { cached.close(); } catch {} wsCache.delete(target.id); }
  const ws = await connect(target.webSocketDebuggerUrl);
  ws.addEventListener('close', () => {
    wsCache.delete(target.id);
    if (cachedTarget?.id === target.id) cachedTarget = null;
  });
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
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
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

// 真实鼠标点击（CDP Input 域，等效真人操作）：部分 BOSS 按钮对合成 .click() 无响应，
// 页面 JS 返回 { __CDP_CLICK__: { x, y } } 坐标标记时，由 CLI 派发 mousePressed/Released
async function realClick(target, x, y) {
  const ws = await getWs(target);
  // Page.bringToFront alone did not activate the user's background Chrome
  // target reliably. Activate through the browser's CDP HTTP endpoint first.
  const activation = await fetch(`${BASE}/json/activate/${encodeURIComponent(target.id)}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!activation.ok) throw new Error(`CDP 标签激活失败：HTTP ${activation.status}`);
  await call(ws, 'Page.bringToFront');
  await new Promise((r) => setTimeout(r, 150));
  if ((await evaluateIn(target, 'document.hasFocus()')) !== 'true') {
    throw new Error('Chrome 标签未取得焦点，已取消点击；请将 Chrome 窗口切到前台后重试。');
  }
  await call(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await new Promise((r) => setTimeout(r, 60));
  await call(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 60));
  await call(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function evaluateMaybeClick(target, expression) {
  const raw = await evaluateIn(target, expression);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  if (parsed && typeof parsed === 'object' && parsed.__CDP_CLICK__) {
    const { x, y } = parsed.__CDP_CLICK__;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`__CDP_CLICK__ 坐标无效: ${JSON.stringify(parsed.__CDP_CLICK__)}`);
    }
    await realClick(target, Math.round(x), Math.round(y));
    const { __CDP_CLICK__, ...rest } = parsed;
    return JSON.stringify(rest);
  }
  return raw;
}

async function hasFocus(target) {
  try {
    return (await evaluateIn(target, 'document.hasFocus()')) === 'true';
  } catch {
    return false;
  }
}

// 只允许控制 BOSS 标签页，避免焦点落在邮件/其他工作页时误导航或误操作。
async function resolveTarget() {
  // Reuse the live target during a run. Re-listing all Chrome targets and
  // probing /json/version for every DOM query made polling needlessly chatty.
  if (cachedTarget && wsCache.get(cachedTarget.id)?.readyState === WS.OPEN) return cachedTarget;
  cachedTarget = null;
  await assertAvailable();
  const pages = await listPages();
  if (!pages.length) throw new Error('CDP 无可用标签页（Chrome 已打开？）');
  const bossPages = pages.filter((page) => {
    try { return /(^|\.)zhipin\.com$/i.test(new URL(page.url).hostname); } catch { return false; }
  });
  if (!bossPages.length) {
    // 自动新建一个 BOSS 标签页（首页，复用已登录会话），无需用户手动打开网站。
    // apply/scan 流程随后会用 location.href 自行导航到具体岗位/会话 URL。
    const res = await fetch(`${BASE}/json/new?${encodeURIComponent('https://www.zhipin.com/')}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`CDP 自动新建 BOSS 标签页失败 HTTP ${res.status}`);
    const page = await res.json();
    const started = Date.now();
    while (Date.now() - started < 25000) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const raw = await evaluateIn(page, `JSON.stringify({ready: document.readyState})`);
        const state = raw ? JSON.parse(raw) : {};
        if (state.ready === 'complete') break;
      } catch {
        // 导航中 evaluate 可能瞬时失败，继续轮询
      }
    }
    cachedTarget = page;
    return page;
  }
  for (const page of bossPages) {
    if (await hasFocus(page)) { cachedTarget = page; return page; }
  }
  cachedTarget = bossPages[0];
  return bossPages[0];
}

async function cdpExecJs(js) {
  const target = await resolveTarget();
  return evaluateMaybeClick(target, js);
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
    const target = await resolveTarget();
    const out = await evaluateMaybeClick(target, js);
    if (out !== '') console.log(out);
    return;
  }
  console.error('Usage: node boss-cdp.mjs --eval \'<js>\' | --probe | --goto <url>');
  process.exit(2);
}

// 关闭所有缓存的 CDP WebSocket（否则事件循环挂起，脚本不退出）。
// 供被 import 的调用方（如 debug-one-card.mjs，其自身是入口、不会触发本文件 main 的保底退出）显式调用。
export function closeAllConnections() {
  for (const ws of wsCache.values()) { try { ws.close(); } catch {} }
  wsCache.clear();
}

export { assertAvailable, cdpExecJs, cdpExecJson, evaluateMaybeClick, gotoUrl, listPages, probe, realClick, resolveTarget };

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
