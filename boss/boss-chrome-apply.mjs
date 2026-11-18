#!/usr/bin/env node

import { isMainModule } from '../lib/is-main-module.mjs';
import {
  CANDIDATES_PATH,
  appendApplication,
  appendSentLog,
  countSentCompaniesToday,
  countSentCompaniesTodayByCity,
  hydrateQueueJob,
  loadProfile,
  loadCandidatesByKeyHashes,
  loadQueue,
  markCandidatesGreeted,
  markJobsClosed,
  parseArgs,
  readJson,
  urlPathname,
  isCandidatesPath,
  loadCandidates,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import { cdpExecJs, closeAllConnections } from './boss-cdp.mjs';
import { selectSendableJobs, readSendHistory } from './boss-send-eligibility.mjs';
import { applyError, resolveMaxConsecutiveSkips, RISK_CONTROL_SOURCE, summarizeApplyResults } from './boss-apply-failure.mjs';
import { runApplyBatch } from './boss-apply-loop.mjs';

// 城市操作流程配置（阈值 / 每城配额）统一来自 PostgreSQL（boss_config.boss_city_control，唯一配置基准）；
// 连库失败直接抛错，不回落 profile.yml（发送端 fail-closed：宁可不跑，也不按过期配额发）。
// 参数放在连库之前校验：否则 PG 连不上时，用户看到的是数据库错误而不是自己写错的参数。
// main-guard 走 lib/is-main-module.mjs（#3170）：手抄 `import.meta.url === pathToFileURL(argv[1])`
// 在符号链接路径下永远不相等，CLI 尾巴会被静默跳过、进程 exit 0 却什么都没做。
const IS_MAIN = isMainModule(import.meta.url);
const RAW_ARGS = parseArgs();
if (IS_MAIN) {
  try {
    resolveMaxConsecutiveSkips(RAW_ARGS);
  } catch (err) {
    console.error(`boss-chrome-apply failed: ${err.message}`);
    process.exit(1);
  }
}
const BOSS_CONTROL = await loadBossControl();

const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';

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
      // 页面导航间隙 CDP evaluate 可能瞬时失败：视为未就绪，继续轮询
      ok = false;
    }
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

function pageString(value) {
  return JSON.stringify(String(value || ''));
}

function trackerScore(value) {
  const score = typeof value === 'number' ? value : (String(value ?? '').trim() ? Number(value) : NaN);
  return Number.isFinite(score) ? `${score.toFixed(1)}/5` : 'N/A';
}

// 失败现场快照：把「未找到按钮」时页面上到底有什么记下来（原日志只有 `[]`，
// 事后无法判断是页面没渲染完、结构变了，还是风控把页面换成了登录/验证页），
// 同时交给 classifyApplyFailure 判断该跳过这一家还是停整批。
//
// 风控判定只看**限定范围**的文本（弹窗/标题/URL，以及正文很短时的整页）：
// 整页扫「验证码/风控」会让一个「风控算法工程师，处理验证码」的岗位 JD 自己被判成风控，
// 那等于把用户这次的投诉（一条岗位拖垮整批）换个原因再犯一次。
// 风控判定只看**有限几种证据**，避免把岗位内容误判成风控墙：
//   1. 可见弹窗/验证容器里的风控字样；
//   2. URL 路径本身是登录/验证/风控路径；
//   3. 正文很短（阻塞型页面）时的整页文本。
// 不扫岗位页正文和 <title>——「风控算法工程师（验证码）」这种 JD 会把整批拖下水，
// 那正是用户这次投诉的同一个后果（一条岗位拖垮整批），只是换了原因。
const URL_RISK_RE_SOURCE = '\\/web\\/user\\/|\\/login|\\/verify|\\/captcha|\\/safe\\/|passport';
async function capturePageState(extra = {}) {
  let state = null;
  try {
    state = await execJson(`
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const re = new RegExp(${JSON.stringify(RISK_CONTROL_SOURCE)});
  const urlRe = new RegExp(${JSON.stringify(URL_RISK_RE_SOURCE)}, 'i');
  const body = (document.body?.innerText || '').replace(/\\s+/g, ' ');
  const dialogText = [...document.querySelectorAll('[role="dialog"], .dialog, .dialog-wrap, .greet-pop, .boss-pop, .verify-wrap, iframe')]
    .filter(vis)
    .map((el) => (el.innerText || ''))
    .join(' ');
  let riskText = dialogText.match(re)?.[0] || '';
  if (!riskText) {
    const urlHit = (location.pathname + location.search).match(urlRe);
    if (urlHit) riskText = 'URL:' + urlHit[0];
  }
  if (!riskText && body.length < 300) riskText = body.match(re)?.[0] || '';
  return {
    href: location.href,
    title: document.title,
    bodyHint: body.slice(0, 200),
    bodyLength: body.length,
    riskText,
    hasLoginButton: [...document.querySelectorAll('a,button')]
      .some((el) => vis(el) && /^(登录|登录\\s*\\/\\s*注册|立即登录)$/.test((el.innerText || '').trim())),
  };
})())`, null);
  } catch {
    // CDP 断开时连快照都取不到——交给上层按 UNKNOWN/CDP_DISCONNECTED 处理，别用快照错误盖掉原始错误
    state = null;
  }
  return { ...(state || {}), ...extra };
}

async function openMessageConversation(job) {
  await execJs(`location.href = ${JSON.stringify(CHAT_URL)}; 'navigating'`);
  const loaded = await waitFor(
    `JSON.stringify(location.pathname.includes('/web/geek/chat') && document.readyState === 'complete')`,
    25000,
    500,
  );
  if (!loaded) {
    const state = await capturePageState();
    throw applyError('MESSAGE_PAGE_TIMEOUT', `BOSS消息页加载超时；页面状态=${JSON.stringify(state)}`, { pageState: state });
  }

  const searchInfo = await execJson(`
JSON.stringify((() => {
  const company = ${pageString(job.company)};
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const el = [...document.querySelectorAll('.boss-search-input, input[placeholder*="联系人"]')].find(vis);
  if (!el) return { ok: false, reason: 'no_contact_search' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, company);
  else el.value = company;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: company }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
  return { ok: true };
})())`, {});
  if (!searchInfo?.ok) throw applyError('CONVERSATION_NOT_FOUND', `消息页无法搜索联系人：${searchInfo?.reason || 'unknown'}`);

  const companyVisible = await waitFor(`
JSON.stringify((() => {
  const company = ${pageString(job.company)};
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('li[role="listitem"], .friend-content-warp')]
    .some((el) => vis(el) && (el.innerText || '').includes(company));
})())`, 10000, 300);
  if (!companyVisible) {
    const state = await capturePageState();
    throw applyError('CONVERSATION_NOT_FOUND', `消息页未找到“${job.company}”对应会话；页面状态=${JSON.stringify(state)}`, { pageState: state });
  }

  const conversationInfo = await execJson(`
JSON.stringify((() => {
  const company = ${pageString(job.company)};
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const candidates = [...document.querySelectorAll('li[role="listitem"]')]
    .filter((el) => vis(el) && (el.innerText || '').includes(company));
  const el = candidates[0];
  if (!el) return { ok: false, reason: 'conversation_disappeared' };
  const r = el.getBoundingClientRect();
  return { ok: true, __CDP_CLICK__: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
})())`, {});
  if (!conversationInfo?.ok) {
    throw applyError('CONVERSATION_NOT_FOUND', `消息页会话在点击前消失：${conversationInfo?.reason || 'unknown'}`);
  }

  const inputReady = await waitFor(`
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('.chat-conversation .chat-input, .chat-input')].some(vis);
})())`, 12000, 400);
  if (!inputReady) throw applyError('NO_CHAT_INPUT', `已打开“${job.company}”会话，但未找到消息输入框`);
}

async function sendCurrentChat(greeting, { context = '聊天页' } = {}) {
  const inputReady = await waitFor(`
JSON.stringify((() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], .input-area, .chat-input, .input-box')];
  return nodes.some((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
})())`, 20000, 500);
  if (!inputReady) {
    const state = await execJson(`
JSON.stringify({
  href: location.pathname,
  title: document.title,
  hasFocus: document.hasFocus(),
  startChatVisible: [...document.querySelectorAll('.btn-startchat')].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }),
  bodyHint: (document.body?.innerText || '').slice(0, 180).replace(/\\s+/g, ' ')
})`, {});
    throw applyError('NO_CHAT_INPUT', `${context}未找到消息输入框；页面状态=${JSON.stringify(state)}`, { pageState: state });
  }

  const fillInfo = await execJson(`
JSON.stringify((() => {
  const message = ${pageString(greeting)};
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], .input-area, .chat-input textarea, .input-box textarea')];
  const el = nodes.find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!el) return { ok: false, reason: 'no_input' };
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, message);
    else el.value = message;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
  } else {
    el.innerText = message;
    el.textContent = message;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }
  return { ok: true, tag: el.tagName, cls: String(el.className || ''), valueLength: (el.value || el.innerText || '').length };
})())`, {});
  if (!fillInfo?.ok) throw applyError('FILL_INPUT_FAILED', `未能填入${context}文案：${fillInfo?.reason || 'unknown'}`);

  const sendReady = await waitFor(`
JSON.stringify((() => {
  const items = [...document.querySelectorAll('a,button,.send-message,.btn-send,[class*="send"]')].map((el) => {
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
    const cls = String(el.className || '');
    return {
      visible: rect.width > 0 && rect.height > 0,
      text,
      cls,
      disabled: Boolean(el.disabled) || /disable|disabled/.test(cls),
    };
  });
  return items.some((item) =>
    item.visible &&
    !item.disabled &&
    !/sendimg/.test(item.cls) &&
    (/发送/.test(item.text) || /send-message|btn-send\\b/.test(item.cls))
  );
})())`, 8000, 300);
  if (!sendReady) {
    const state = await execJson(`
JSON.stringify((() => [...document.querySelectorAll('a,button,.send-message,.btn-send,[class*="send"]')].map((el) => {
  const rect = el.getBoundingClientRect();
  return {
    text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim(),
    cls: String(el.className || ''),
    disabled: Boolean(el.disabled) || /disable|disabled/.test(String(el.className || '')),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
}).filter((item) => /发送|send/.test(item.text + item.cls)).slice(0, 12))`, []);
    throw applyError('NO_SEND_BUTTON', `${context}发送按钮未激活：${JSON.stringify(state)}`);
  }

  const sendInfo = await execJson(`
JSON.stringify((() => {
  const nodes = [...document.querySelectorAll('a,button,.send-message,.btn-send,[class*="send"]')];
  const items = nodes.map((el, index) => ({
    index,
    text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim(),
    cls: String(el.className || ''),
    disabled: Boolean(el.disabled) || /disable|disabled/.test(String(el.className || '')),
    visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
  }));
  const candidates = items.filter((item) =>
    item.visible &&
    !item.disabled &&
    !/sendimg/.test(item.cls) &&
    (/发送/.test(item.text) || /send-message|btn-send\\b/.test(item.cls))
  );
  const hit = candidates.find((item) => /发送/.test(item.text)) || candidates[0];
  if (!hit) return { ok: false, reason: 'no_send_button', items: items.filter((item) => /发送|send/.test(item.text + item.cls)).slice(0, 10) };
  const el = nodes[hit.index];
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  el.click();
  return { ok: true, button: hit };
})())`, {});
  if (!sendInfo?.ok) throw applyError('NO_SEND_BUTTON', `未找到可点击发送按钮：${JSON.stringify(sendInfo?.items || [])}`);

  const verified = await waitFor(`
JSON.stringify((() => {
  const message = ${pageString(greeting)};
  const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
  const wanted = normalize(message);
  const sentTextVisible = [...document.querySelectorAll('body *')]
    .filter((el) => !['TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE'].includes(el.tagName))
    .some((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return normalize(el.innerText || el.textContent).includes(wanted);
    });
  const stillInInput = [...document.querySelectorAll('textarea,input,[contenteditable="true"]')]
    .some((el) => normalize(el.value || el.innerText || el.textContent) === wanted);
  return sentTextVisible && !stillInInput;
})())`, 12000, 500);
  // 这一步点了「发送」，可能真的发出去了——必须停批次，不能让「状态未知」的岗位接着往前推。
  if (!verified) throw applyError('UNVERIFIED_SEND', `点击发送后未在${context}聊天记录中验证到自定义文案，未记为成功`);
}

function printPostSendGuidance({ sentCount, quotaLine, skippedCount = 0, abortInfo = null, effectErrors = [] }) {
  if (abortInfo) {
    console.log('');
    console.log(`⚠️ 本轮提前停止（${abortInfo.code}）：${abortInfo.reason}`);
    if (abortInfo.pending) {
      console.log(`剩余 ${abortInfo.pending} 家本轮没有尝试，下一轮会重新进队列；本轮失败/跳过的岗位都不计当日额度、不计 30 天去重。`);
    }
    if (abortInfo.code === 'UNVERIFIED_SEND') {
      // 这条可能已经发出去了，而它没进 30 天去重：重跑前必须先人工确认，否则会给同一个 HR 发两次。
      console.log('⚠️ 上一条「点击发送但未验证到文案」的岗位可能已经真的发出去了：重跑前先看一眼 BOSS 聊天记录，别重复打招呼。');
    } else {
      console.log('先看 Chrome 里 BOSS 是不是停在登录页/安全验证页；确认正常后再跑 `npm run boss:chrome:apply -- --confirmed-review`。');
    }
  }
  if (skippedCount > 0) {
    console.log('');
    console.log(`本轮跳过 ${skippedCount} 家（岗位页/沟通按钮异常）：不计当日额度、不计 30 天去重，下一轮会重试。`);
  }
  if (effectErrors.length) {
    // 消息发出去了但写库失败：不能当成没发，也不该悄悄过去——直接点名，让用户去补记录。
    console.log('');
    console.log(`⚠️ 有 ${effectErrors.length} 条岗位的结果没写进数据库（发送日志/追踪表），请手动核对并补记录：`);
    for (const item of effectErrors) console.log(`  - [${item.kind}] ${item.company} - ${item.title}: ${item.error}`);
  }
  if (sentCount <= 0) return;
  console.log('');
  console.log(`已投递成功：本轮已向 ${sentCount} 家公司发送 BOSS 打招呼。`);
  console.log(`如果对方要求发送简历，或者你自己投递的公司要求发送简历，请把公司名称或 BOSS 直聘岗位链接发给我。`);
  console.log(`我会根据该岗位 JD 和你的原始简历，定制一版匹配该岗位的 cv.md 和中文 PDF 简历；只优化表达和重点，不编造经历、技能、证书或薪资。`);
  console.log(quotaLine || '本轮发送完成。');
}

async function sendOne(job, { gapMs = 1200 } = {}) {
  const greeting = String(job.greeting || '').trim();
  if (!greeting) throw applyError('MISSING_GREETING', '缺少打招呼文案');

  await execJs(`location.href = ${JSON.stringify(job.url)}; 'navigating'`);
  const loaded = await waitFor(
    `JSON.stringify(document.readyState === 'complete' || (document.body?.innerText || '').includes(${JSON.stringify(job.title || '')}))`,
    25000,
    700,
  );
  if (!loaded) {
    const state = await capturePageState();
    throw applyError('JOB_PAGE_TIMEOUT', `岗位页面加载超时；页面状态=${JSON.stringify(state)}`, { pageState: state });
  }
  await sleep(gapMs);

  // 岗位已下线：BOSS 会重定向到无沟通按钮的 SEO 页（"职位已关闭"）——记 closed 并继续下一家，不算批次失败
  const jobClosed = await execJson('JSON.stringify((document.body.innerText||"").includes("职位已关闭"))', false);
  if (jobClosed) throw applyError('JOB_CLOSED', '职位已关闭');

  // 定位「立即沟通」并真实鼠标点击（部分按钮对合成 .click() 无响应，返回 __CDP_CLICK__
  // 坐标标记由 boss-cdp 派发真实鼠标事件）。scrollIntoView 防止坐标因滚动偏移。
  const findChatButton = `
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const hit = [...document.querySelectorAll('a,button')]
    .map((el) => ({ el, text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim() }))
    .find((item) => vis(item.el) && /立即沟通|继续沟通|聊一聊/.test(item.text));
  if (!hit) {
    const items = [...document.querySelectorAll('a,button')]
      .filter((el) => vis(el) && /沟通|聊天|发送|继续/.test(el.innerText || ''))
      .map((el) => (el.innerText || '').trim()).slice(0, 10);
    return { ok: false, reason: 'no_chat_button', items };
  }
  hit.el.scrollIntoView({ block: 'center' });
  const rect = hit.el.getBoundingClientRect();
  return { ok: true, button: { text: hit.text }, __CDP_CLICK__: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
})())`;

  // 2026-10-11 新增点击重试：页面刚完成导航时 React 事件可能尚未挂上，真实点击
  // 会无声失败——表现为 3s 内既无消息输入框、也无「已向BOSS发送消息」默认语弹窗，
  // 按钮原样留在页面（生产实测：报「岗位页未找到消息输入框」且按钮仍是「立即沟通」）。
  // 处理：重新定位坐标（scrollIntoView）再点，最多 3 次；仍无反应才报错。
  let clicked = false;
  let buttonInfo = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    buttonInfo = await execJson(findChatButton, {});
    if (!buttonInfo?.ok) {
      const state = await capturePageState({ chatButtonCandidates: buttonInfo?.items || [] });
      throw applyError(
        'NO_CHAT_BUTTON',
        `未找到“立即沟通”按钮；页面状态=${JSON.stringify(state)}`,
        { pageState: state },
      );
    }
    const reacted = await waitFor(
      `JSON.stringify((() => {
         const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
         return Boolean([...document.querySelectorAll('.chat-input, textarea, [contenteditable="true"]')].find(vis))
           || /已向BOSS发送消息/.test(document.body.innerText || '');
       })())`,
      3000,
      150,
    );
    if (reacted) { clicked = true; break; }
    console.error(`[retry] 第 ${attempt} 次点击「${buttonInfo.button?.text || '立即沟通'}」无反应，重新定位坐标再点`);
    await sleep(800);
  }
  if (!clicked) {
    const extra = await execJson(
      `JSON.stringify((() => {
         const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
         return { startChatVisible: [...document.querySelectorAll('.btn-startchat')].some(vis) };
       })())`,
      {},
    );
    const state = await capturePageState(extra || {});
    throw applyError('CLICK_NO_RESPONSE', `点击「立即沟通」3 次均无反应；页面状态=${JSON.stringify(state)}`, { pageState: state });
  }

  // 继续沟通场景：BOSS 会先自动发送默认语，再弹出确认框。
  // 真实 DOM 会把“留在此页”和“继续沟通”拆成两个 span，不能按完整文案找叶子节点。
  // 先立刻点击弹窗内的“继续沟通”，避免等到弹窗节点变成失效的旧 DOM。
  let autoGreeted = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const appeared = await waitFor(`
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const input = [...document.querySelectorAll('.chat-input, textarea, [contenteditable="true"]')].find(vis);
  return Boolean(input) || /已向BOSS发送消息/.test(document.body.innerText || '');
})())`, 3000, 150);
    if (!appeared) break;
    const state = await execJson(`
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  if ([...document.querySelectorAll('.chat-input, textarea, [contenteditable="true"]')].some(vis)) return { state: 'input' };
  if (/已向BOSS发送消息/.test(document.body.innerText || '')) return { state: 'auto_greeted_popup' };
  return { state: 'none' };
})())`, {});
    if (state?.state === 'input') break;
    if (state?.state === 'auto_greeted_popup') {
      autoGreeted = true;
      // 点击“继续沟通”：优先使用 BOSS 弹窗的稳定类名，兼容按钮文案被拆成两个 span 的 DOM。
      await execJson(`
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const popup = [...document.querySelectorAll('.greet-pop.greet-boss-pop, [role="dialog"]')]
    .find((el) => vis(el) && /已向BOSS发送消息/.test(el.innerText || ''));
  const candidates = popup
    ? [...popup.querySelectorAll('.btn-sure, .btn, button, [role="button"]')]
      .filter((el) => vis(el) && /^继续沟通$/.test((el.innerText || '').trim()))
    : [];
  if (!candidates.length) return { state: 'popup_gone' };
  const button = candidates.sort((a, b) =>
    (a.getBoundingClientRect().width * a.getBoundingClientRect().height) -
    (b.getBoundingClientRect().width * b.getBoundingClientRect().height))[0];
  const r = button.getBoundingClientRect();
  return { state: 'popup', __CDP_CLICK__: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
})())`, {});
      await sleep(800);
      continue;
    }
    break;
  }

  // 岗位页弹窗节点失效时，改走常驻消息页，定位该公司会话后补发自定义文案。
  if (autoGreeted) {
    const inputStill = await execJson(`
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('.chat-input, textarea, [contenteditable="true"]')].some(vis);
  })())`, false);
    if (!inputStill) {
      try {
        await openMessageConversation(job);
        await sendCurrentChat(greeting, { context: '消息页' });
        return;
      } catch (err) {
        throw applyError(
          'AUTO_GREETED',
          `AUTO_GREETED: BOSS已自动发送默认打招呼语，但消息页补发自定义话术失败：${err.message}`,
          { pageState: err.pageState, cause: err },
        );
      }
    }
    // 弹窗已经出现过（默认语已发），这条岗位的联系已经建立：后面补发自定义文案
    // 失败必须记 auto_sent，不能按岗位级失败 skip——否则下一轮会再给同一个 HR 打一次招呼。
    try {
      await sendCurrentChat(greeting, { context: '岗位页' });
      return;
    } catch (err) {
      throw applyError(
        'AUTO_GREETED',
        `AUTO_GREETED: BOSS已自动发送默认打招呼语，但岗位页补发自定义话术失败：${err.message}`,
        { pageState: err.pageState, cause: err },
      );
    }
  }
  await sendCurrentChat(greeting, { context: '岗位页' });
}

async function main() {
  const args = RAW_ARGS;
  if (args.help) {
    console.log('Usage: node boss-chrome-apply.mjs [--key-hash <h1,h2,...> | --threshold 3.0 --daily-limit 20] --confirmed-review [--dry-run]');
    console.log('      单条岗位失败默认跳过继续下一家（skip）；连续失败达到上限或遇到环境级故障（风控/掉登录/发送未验证）才停批次。');
    console.log('      --max-consecutive-failures <N>  连续 N 条岗位级失败即停批次（默认 3，0 = 不因连续失败停止）');
    console.log('      --stop-on-first-failure         恢复旧行为：任何一条失败就停批次（等价 --max-consecutive-failures 1）');
    return;
  }
  if (!args['dry-run'] && !args['confirmed-review']) {
    throw new Error('真实发送前必须先向用户展示岗位清单/打招呼文案，并在用户明确确认后加 --confirmed-review。');
  }
  const { maxConsecutiveSkips, notes: failureFlagNotes } = resolveMaxConsecutiveSkips(args);
  for (const note of failureFlagNotes) console.error(`[参数] ${note}`);

  const profile = loadProfile();
  const threshold = Number(args.threshold ?? BOSS_CONTROL.send_threshold ?? 4.0);
  const cityLimits = BOSS_CONTROL.daily_limit_per_city || null;
  const limitIsExplicit = args['daily-limit'] != null;
  const limit = Number(args['daily-limit'] ?? 20);

  let jobs = [];
  let sentToday = 0;
  let remainingToday = 0;
  let selection = null;
  let urlCity = new Map(); // URL(pathname)→城市，供发送后打印各城配额；queue 模式下填充

  if (args['key-hash']) {
    // 点名单发模式：--key-hash 直取 PostgreSQL 岗位（支持逗号/空格分隔多个），绕过队列/城市配额/30天同岗位去重
    const hashes = String(args['key-hash'] === true ? '' : args['key-hash']).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!hashes.length) throw new Error('--key-hash 需要至少一个 key_hash 值（多个用逗号分隔）');
    const found = await loadCandidatesByKeyHashes(hashes);
    const missing = hashes.filter((h) => !found.some((job) => job.key_hash === h));
    if (missing.length) throw new Error(`key_hash 未命中 ${missing.length} 个: ${missing.join(', ')}`);
    const greetedJobs = found.filter((job) => job.greeted);
    if (greetedJobs.length && !args['force-greeted']) {
      throw new Error(
        `以下 ${greetedJobs.length} 个岗位已打过招呼（greeted=1），确认重发请加 --force-greeted:\n` +
        greetedJobs.map((j) => `- ${j.company} - ${j.title}`).join('\n'),
      );
    }
    const noGreeting = found.filter((job) => !String(job.greeting || '').trim());
    if (noGreeting.length) {
      throw new Error(`以下岗位无 greeting 文案，先跑 npm run boss:score 生成:\n` +
        noGreeting.map((j) => `- ${j.company} - ${j.title}`).join('\n'));
    }
    jobs = found;
  } else {
    const queue = args.input ? readJson(args.input, []) : await loadQueue(args.queue || 'all');
    // Queue JSON may contain only the raw job payload from boss_jobs; score in
    // the DB column is authoritative and must be restored by stable key_hash.
    const storedCandidates = await loadCandidates();
    const currentByHash = new Map(storedCandidates.filter((job) => job.key_hash).map((job) => [job.key_hash, job]));
    // 队列只是「发哪些、什么顺序」的快照；文案/分数/状态一律以库里的行为准
    // （2026-10-30 修：这里原来漏刷 greeting —— LLM 在入队后写库，发送时却用了老模板文案）
    const hydratedQueue = queue.map((job) => hydrateQueueJob(job, currentByHash.get(job.key_hash)));
    // URL→城市映射：城市配额需要反查发送日志里的岗位属于哪个城市。
    // 键用 pathname（job_detail/<id>.html）——securityId 每次扫描都变，
    // 完整 URL 匹配会让重扫后历史发送记录对不上城市、配额扣减失灵。
    urlCity = new Map(
      cityLimits ? storedCandidates.map((job) => [urlPathname(job.url), job.city || '']) : [],
    );
    const history = await readSendHistory(urlCity);
    selection = selectSendableJobs(hydratedQueue, {
      threshold,
      limit,
      limitIsExplicit,
      cityLimits,
      platformLimit: Number(BOSS_CONTROL.platform_daily_limit ?? 0),
      // 标题排除硬闸（2026-10-15）：校招/应届/实习…无论怎么进的池子，都不进发送候选
      titleExclude: BOSS_CONTROL.title_exclude,
      urlCity,
      history,
    });
    jobs = selection.jobs;
    sentToday = selection.sentToday;
    remainingToday = selection.remainingToday;
    const st = selection.stats;
    console.error(
      `[过滤统计] 队列 ${st.total} 条：缺少分数 ${st.missingScore}，低于阈值 ${st.belowThreshold}，` +
      `标题排除 ${st.titleExcluded}，` +
      `30天内已发同岗位 ${st.alreadySent}，` +
      `同批次已有该公司 ${st.duplicateCompanyInBatch}，城市配额满 ${st.cityQuota} → 待发 ${st.selected} 条`,
    );
  }

  if (args['dry-run']) {
    if (args['key-hash']) {
      console.log(JSON.stringify({
        dryRun: true,
        singleMode: true,
        keyHash: args['key-hash'],
        total: jobs.length,
        willSend: jobs.map((job) => ({
          keyHash: job.key_hash,
          company: job.company,
          title: job.title,
          salary: job.salary,
          city: job.city,
          score: job.score,
          url: job.url,
          greeted: Boolean(job.greeted),
          greeting: job.greeting,
        })),
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({
      dryRun: true,
      threshold,
      dailyLimit: limit,
      cityLimits,
      sentCompaniesToday: sentToday,
      sentByCityToday: selection.sentTodayByCity,
      remainingByCity: selection.cityRemaining,
      remainingToday,
      willSend: jobs.map((job) => ({
        company: job.company,
        title: job.title,
        score: job.score,
        city: job.city,
        greeting: job.greeting,
      })),
    }, null, 2));
    return;
  }

  // 单条岗位发不出去 ≠ 整批环境坏了。以前任何非 closed 失败都 break，于是一条
  // 「未找到立即沟通按钮」就把后面 19 家全作废（2026-11-18 用户反馈）。
  // 现在按分类走：skip 继续下一家，fatal 停批次，连续 N 条 skip 升级为 fatal。
  // 控制流在 boss-apply-loop.mjs（可测试），这里只提供浏览器/数据库副作用。
  const {
    results,
    sentJobs,
    autoSentJobs,
    closedHashes,
    skippedJobs,
    abortInfo,
    effectErrors,
  } = await runApplyBatch({
    jobs,
    maxConsecutiveSkips,
    send: (job) => sendOne(job, { gapMs: Number(args['gap-ms'] || 1400) }),
    onSent: async (job) => {
      await appendSentLog({ job, status: 'sent', message: job.greeting });
      appendApplication({
        job,
        score: trackerScore(job.score),
        status: 'Applied',
        report: job.report || '—',
        notes: 'BOSS Chrome 自动打招呼',
      });
    },
    onAutoSent: async (job, verdict) => {
      // auto_sent = 默认语已自动发送但自定义话术未验证——不把它冒充成 sent
      const detail = verdict.message || '自定义话术未验证';
      await appendSentLog({
        job,
        status: 'auto_sent',
        message: '希望和你聊聊这个职位，是否有时间呢？（BOSS自动默认打招呼语，非自定义文案）',
        error: detail,
      });
      appendApplication({
        job,
        score: trackerScore(job.score),
        status: 'Applied',
        report: job.report || '—',
        notes: `BOSS 继续沟通场景：默认打招呼语已发送；自定义话术未验证（${detail}）`,
      });
    },
    onClosed: async (job, verdict) => {
      await appendSentLog({ job, status: 'closed', message: job.greeting, error: verdict.message });
    },
    onSkipped: async (job, verdict) => {
      // 岗位级失败：不计当日额度、不计 30 天同岗位去重（sent_log 里 status='skipped'，
      // 配额与去重只认 'sent'/'auto_sent'），下一轮还能再试。
      await appendSentLog({ job, status: 'skipped', message: job.greeting, error: `${verdict.code}: ${verdict.message}` });
    },
    onFatal: async (job, verdict) => {
      await appendSentLog({ job, status: 'failed', message: job.greeting, error: `${verdict.code}: ${verdict.message}` });
    },
    onResult: (result) => {
      const label = `${result.company} - ${result.title}`;
      if (result.status === 'sent') console.log(`sent: ${label}`);
      else if (result.status === 'auto_sent') console.log(`auto_sent_custom_unverified: ${label}: ${result.error}`);
      else if (result.status === 'closed') console.error(`closed: ${label}: ${result.error}`);
      else if (result.status === 'skipped') console.error(`skipped(${result.code}): ${label}: ${result.error}`);
      else console.error(`failed(${result.code}): ${label}: ${result.error}`);
    },
  });

  // 职位已关闭的岗位标记出局（status='closed'），发送队列 SQL 会排除，
  // 避免每次运行都反复重试、白占一个配额名额
  if (closedHashes.length) {
    try {
      const marked = await markJobsClosed(closedHashes);
      console.log(`[boss-db] 已标记 ${marked} 条职位关闭（closed），后续队列不再收录`);
    } catch (err) {
      console.error(`[boss-db] closed 标记失败（不影响发送结果）: ${err.message}`);
    }
  }

  // 联系事实区分自定义文案验证发送与 BOSS 自动默认招呼。
  // 按记录下来的 job 对象取 URL，不再用 results 的下标去反查 jobs——跳过/中断时下标会错位。
  const sentUrls = sentJobs.map((job) => job.url).filter(Boolean);
  const autoSentUrls = autoSentJobs.map((job) => job.url).filter(Boolean);
  if (sentUrls.length || autoSentUrls.length) {
    try {
      const sentMarked = sentUrls.length ? await markCandidatesGreeted(sentUrls, 'custom_sent') : 0;
      const autoMarked = autoSentUrls.length ? await markCandidatesGreeted(autoSentUrls, 'auto_greeted_unverified') : 0;
      console.log(`[boss-db] 已更新联系状态：自定义消息 ${sentMarked} 条，平台默认招呼 ${autoMarked} 条`);
    } catch (err) {
      console.error(`[boss-db] 联系状态标记失败（不影响发送结果）: ${err.message}`);
    }
  }
  const sentCount = sentJobs.length;
  const counts = summarizeApplyResults(results);
  console.log(JSON.stringify({
    sent: sentCount,
    autoSentCustomUnverified: counts.auto_sent,
    closed: counts.closed,
    skipped: counts.skipped,
    failed: counts.failed,
    pending: abortInfo ? jobs.length - results.length : 0,
    aborted: abortInfo,
    effectErrors,
    results,
  }, null, 2));
  // 打印真实生效的城市配额（已发/上限），而不是误导性的全局兜底值
  let quotaLine = '';
  if (cityLimits) {
    const sentByCity = await countSentCompaniesTodayByCity({ urlCity });
    quotaLine = '今日各城配额（已发/上限）：' + Object.entries(cityLimits)
      .map(([city, cap]) => `${city} ${sentByCity[city] || 0}/${Number(cap)}`)
      .join('，');
    // 平台级上限仅在显式配置 >0 时展示与生效（默认不管理）
    const platformLimit = Number(BOSS_CONTROL.platform_daily_limit ?? 0);
    if (platformLimit > 0) {
      quotaLine += `；平台剩余 ${Math.max(0, platformLimit - await countSentCompaniesToday())}/${platformLimit}`;
    }
  } else {
    quotaLine = `今日发送上限：${limit} 家。`;
  }
  printPostSendGuidance({ sentCount, quotaLine, skippedCount: skippedJobs.length, abortInfo, effectErrors });
  if (sentCount > 0) console.log('📤 追踪表新增已写入 batch/tracker-additions/，运行 node merge-tracker.mjs 合并进 data/applications.md');
}

if (IS_MAIN) {
  main()
    .catch((err) => { console.error(`boss-chrome-apply failed: ${err.message}`); process.exitCode = 1; })
    .finally(closeAllConnections);
}
