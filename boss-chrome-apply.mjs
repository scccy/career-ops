#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  CANDIDATES_PATH,
  QUEUE_PATH,
  appendApplication,
  appendSentLog,
  countSentCompaniesToday,
  countSentCompaniesTodayByCity,
  loadProfile,
  loadSentCompanyKeys,
  loadSentKeys,
  loadCandidatesByKeyHashes,
  markCandidatesGreeted,
  parseArgs,
  readJson,
  uniqueCompanyKey,
  uniqueJobKey,
  urlPathname,
  isCandidatesPath,
  loadCandidates,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';

// 城市操作流程配置（阈值 / 每城配额）统一来自数据库；DB 不可用时退化到 profile.yml 默认值。
const BOSS_CONTROL = await loadBossControl().catch(() => ({}));

const RECENT_COMPANY_DEDUPE_DAYS = 30;
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';

// 本地适配：macOS 走 AppleScript；其他平台（或 BOSS_TRANSPORT=cdp）走 boss-cdp.mjs（Chrome CDP）
const CDP_TRANSPORT = process.env.BOSS_TRANSPORT
  ? process.env.BOSS_TRANSPORT === 'cdp'
  : process.platform !== 'darwin';

function execJs(js) {
  if (CDP_TRANSPORT) {
    return execFileSync(process.execPath, [fileURLToPath(new URL('./boss-cdp.mjs', import.meta.url)), '--eval', js], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  }
  const script = `tell application "Google Chrome" to execute active tab of front window javascript ${JSON.stringify(js)}`;
  return execFileSync('osascript', ['-e', script], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function execJson(js, fallback = null) {
  const raw = execJs(js);
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
      ok = execJson(predicateJs, false);
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

async function openMessageConversation(job) {
  execJs(`location.href = ${JSON.stringify(CHAT_URL)}; 'navigating'`);
  const loaded = await waitFor(
    `JSON.stringify(location.pathname.includes('/web/geek/chat') && document.readyState === 'complete')`,
    25000,
    500,
  );
  if (!loaded) throw new Error('BOSS消息页加载超时');

  const searchInfo = execJson(`
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
  if (!searchInfo?.ok) throw new Error(`消息页无法搜索联系人：${searchInfo?.reason || 'unknown'}`);

  const companyVisible = await waitFor(`
JSON.stringify((() => {
  const company = ${pageString(job.company)};
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('li[role="listitem"], .friend-content-warp')]
    .some((el) => vis(el) && (el.innerText || '').includes(company));
})())`, 10000, 300);
  if (!companyVisible) {
    throw new Error(`消息页未找到“${job.company}”对应会话`);
  }

  const conversationInfo = execJson(`
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
    throw new Error(`消息页会话在点击前消失：${conversationInfo?.reason || 'unknown'}`);
  }

  const inputReady = await waitFor(`
JSON.stringify((() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('.chat-conversation .chat-input, .chat-input')].some(vis);
})())`, 12000, 400);
  if (!inputReady) throw new Error(`已打开“${job.company}”会话，但未找到消息输入框`);
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
  if (!inputReady) throw new Error(`${context}未找到消息输入框`);

  const fillInfo = execJson(`
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
  if (!fillInfo?.ok) throw new Error(`未能填入${context}文案：${fillInfo?.reason || 'unknown'}`);

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
    const state = execJson(`
JSON.stringify((() => [...document.querySelectorAll('a,button,.send-message,.btn-send,[class*="send"]')].map((el) => {
  const rect = el.getBoundingClientRect();
  return {
    text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim(),
    cls: String(el.className || ''),
    disabled: Boolean(el.disabled) || /disable|disabled/.test(String(el.className || '')),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
}).filter((item) => /发送|send/.test(item.text + item.cls)).slice(0, 12))`, []);
    throw new Error(`${context}发送按钮未激活：${JSON.stringify(state)}`);
  }

  const sendInfo = execJson(`
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
  if (!sendInfo?.ok) throw new Error(`未找到可点击发送按钮：${JSON.stringify(sendInfo?.items || [])}`);

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
  if (!verified) throw new Error(`点击发送后未在${context}聊天记录中验证到自定义文案，未记为成功`);
}

function candidatesFromQueue(queue, { threshold, limit, limitIsExplicit = false, cityLimits = null, urlCity = new Map() }) {
  const sentJobs = loadSentKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const recentSentCompanies = loadSentCompanyKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const sentToday = countSentCompaniesToday();
  const sentTodayByCity = countSentCompaniesTodayByCity({ urlCity });
  // 城市配额（2026-09-22 用户要求：上海20/杭州20/南京20，配置于 profile.yml boss.daily_limit_per_city）
  const cityRemaining = new Map(
    Object.entries(cityLimits || {}).map(([city, cap]) => [city, Math.max(0, Number(cap) - (sentTodayByCity[city] || 0))]),
  );
  const globalRemaining = Math.max(0, limit - sentToday);
  const perCityTotal = [...cityRemaining.values()].reduce((sum, n) => sum + n, 0);
  const remainingToday = cityLimits
    ? (limitIsExplicit ? Math.min(globalRemaining, perCityTotal) : perCityTotal)
    : globalRemaining;
  const cityRemainingBefore = Object.fromEntries(cityRemaining);
  const seenCompanies = new Set();
  const stats = { total: queue.length, belowThreshold: 0, alreadySent: 0, recentCompany: 0, cityQuota: 0 };
  const jobs = queue
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .filter((job) => {
      if (Number(job.score) < threshold) { stats.belowThreshold++; return false; }
      if (sentJobs.has(uniqueJobKey(job))) { stats.alreadySent++; return false; }
      const key = uniqueCompanyKey(job);
      if (recentSentCompanies.has(key) || seenCompanies.has(key)) { stats.recentCompany++; return false; }
      if (cityLimits) {
        const city = String(job.city || '').split('·')[0];
        if (cityRemaining.has(city)) {
          const left = cityRemaining.get(city);
          if (left <= 0) { stats.cityQuota++; return false; }
          cityRemaining.set(city, left - 1);
        }
      }
      seenCompanies.add(key);
      return true;
    })
    .slice(0, remainingToday);
  stats.selected = jobs.length;
  return {
    jobs,
    sentToday,
    remainingToday,
    sentTodayByCity,
    cityRemaining: cityRemainingBefore,
    cityRemainingAfterSelection: Object.fromEntries(cityRemaining),
    cityLimits,
    stats,
  };
}

function printPostSendGuidance({ sentCount, quotaLine }) {
  if (sentCount <= 0) return;
  console.log('');
  console.log(`已投递成功：本轮已向 ${sentCount} 家公司发送 BOSS 打招呼。`);
  console.log(`如果对方要求发送简历，或者你自己投递的公司要求发送简历，请把公司名称或 BOSS 直聘岗位链接发给我。`);
  console.log(`我会根据该岗位 JD 和你的原始简历，定制一版匹配该岗位的 cv.md 和中文 PDF 简历；只优化表达和重点，不编造经历、技能、证书或薪资。`);
  console.log(quotaLine || '本轮发送完成。');
}

async function sendOne(job, { gapMs = 1200 } = {}) {
  const greeting = String(job.greeting || '').trim();
  if (!greeting) throw new Error('缺少打招呼文案');

  execJs(`location.href = ${JSON.stringify(job.url)}; 'navigating'`);
  const loaded = await waitFor(
    `JSON.stringify(document.readyState === 'complete' || (document.body?.innerText || '').includes(${JSON.stringify(job.title || '')}))`,
    25000,
    700,
  );
  if (!loaded) throw new Error('岗位页面加载超时');
  await sleep(gapMs);

  // 岗位已下线：BOSS 会重定向到无沟通按钮的 SEO 页（"职位已关闭"）——记 closed 并继续下一家，不算批次失败
  const jobClosed = execJson('JSON.stringify((document.body.innerText||"").includes("职位已关闭"))', false);
  if (jobClosed) throw new Error('JOB_CLOSED: 职位已关闭');

  const buttonInfo = execJson(`
JSON.stringify((() => {
  const items = [...document.querySelectorAll('a,button')].map((el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim(),
      cls: String(el.className || ''),
      href: el.getAttribute('href') || '',
      visible: rect.width > 0 && rect.height > 0
    };
  });
  // 只点可见按钮（页面上常藏有 0×0 的同名隐藏按钮，点了没反应）；
  // 返回 __CDP_CLICK__ 坐标标记，由 boss-cdp CLI 派发真实鼠标事件（部分按钮对合成 .click() 无响应）
  const hit = items.find((item) => item.visible && /立即沟通|继续沟通|聊一聊/.test(item.text));
  if (!hit) return { ok: false, reason: 'no_chat_button', items: items.filter((item) => /沟通|聊天|发送|继续/.test(item.text)).slice(0, 10) };
  const el = [...document.querySelectorAll('a,button')][hit.index];
  const rect = el.getBoundingClientRect();
  return { ok: true, button: hit, __CDP_CLICK__: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
  })())`, {});
  if (!buttonInfo?.ok) throw new Error(`未找到“立即沟通”按钮：${JSON.stringify(buttonInfo?.items || [])}`);

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
    const state = execJson(`
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
      execJson(`
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
    const inputStill = execJson(`
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
        throw new Error(`AUTO_GREETED: BOSS已自动发送默认打招呼语，但消息页补发自定义话术失败：${err.message}`);
      }
    }
  }
  await sendCurrentChat(greeting, { context: '岗位页' });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-chrome-apply.mjs [--key-hash <h1,h2,...> | --threshold 3.0 --daily-limit 20] --confirmed-review [--dry-run]');
    return;
  }
  if (!args['dry-run'] && !args['confirmed-review']) {
    throw new Error('真实发送前必须先向用户展示岗位清单/打招呼文案，并在用户明确确认后加 --confirmed-review。');
  }

  const profile = loadProfile();
  const threshold = Number(args.threshold ?? BOSS_CONTROL.send_threshold ?? profile?.boss?.send_threshold ?? 4.0);
  const cityLimits = BOSS_CONTROL.daily_limit_per_city || profile?.boss?.daily_limit_per_city || null;
  const limitIsExplicit = args['daily-limit'] != null;
  const limit = Number(args['daily-limit'] ?? profile?.boss?.daily_limit ?? 20);

  let jobs = [];
  let sentToday = 0;
  let remainingToday = 0;
  let selection = null;
  let urlCity = new Map(); // URL(pathname)→城市，供发送后打印各城配额；queue 模式下填充

  if (args['key-hash']) {
    // 点名单发模式：--key-hash 直取 MySQL 岗位（支持逗号/空格分隔多个），绕过队列/城市配额/30天去重
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
    const queue = readJson(args.input || QUEUE_PATH, []);
    // URL→城市映射：城市配额需要反查发送日志里的岗位属于哪个城市。
    // 键用 pathname（job_detail/<id>.html）——securityId 每次扫描都变，
    // 完整 URL 匹配会让重扫后历史发送记录对不上城市、配额扣减失灵。
    urlCity = new Map(
      cityLimits ? (await loadCandidates()).map((job) => [urlPathname(job.url), job.city || '']) : [],
    );
    selection = candidatesFromQueue(queue, {
      threshold,
      limit,
      limitIsExplicit,
      cityLimits,
      urlCity,
    });
    jobs = selection.jobs;
    sentToday = selection.sentToday;
    remainingToday = selection.remainingToday;
    const st = selection.stats;
    console.log(
      `[过滤统计] 队列 ${st.total} 条：低于阈值 ${st.belowThreshold}，30天内已发同岗位 ${st.alreadySent}，` +
      `30天内已发同公司 ${st.recentCompany}，城市配额满 ${st.cityQuota} → 待发 ${st.selected} 条`,
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

  const results = [];
  for (const job of jobs) {
    try {
      await sendOne(job, { gapMs: Number(args['gap-ms'] || 1400) });
      appendSentLog({ job, status: 'sent', message: job.greeting });
      appendApplication({ job, score: `${job.score}/5`, status: 'Applied', report: job.report || '—', notes: 'BOSS Chrome 自动打招呼' });
      console.log(`sent: ${job.company} - ${job.title}`);
      results.push({ company: job.company, title: job.title, status: 'sent' });
    } catch (err) {
      const closed = /^JOB_CLOSED/.test(err.message || '');
      const autoGreeted = /^AUTO_GREETED/.test(err.message || '');
      // closed = 岗位下线；auto_greeted = 默认语已自动发送但自定义话术未验证——不把它冒充成 sent
      if (autoGreeted) {
        const detail = err.message || '自定义话术未验证';
        appendSentLog({
          job,
          status: 'auto_sent',
          message: '希望和你聊聊这个职位，是否有时间呢？（BOSS自动默认打招呼语，非自定义文案）',
          error: detail,
        });
        appendApplication({
          job,
          score: `${job.score}/5`,
          status: 'Applied',
          report: job.report || '—',
          notes: `BOSS 继续沟通场景：默认打招呼语已发送；自定义话术未验证（${detail}）`,
        });
        console.log(`auto_sent_custom_unverified: ${job.company} - ${job.title}: ${detail}`);
        results.push({ company: job.company, title: job.title, status: 'auto_sent', customVerified: false, error: detail });
        continue;
      }
      appendSentLog({ job, status: closed ? 'closed' : 'failed', message: job.greeting, error: err.message });
      console.error(`${closed ? 'closed' : 'failed'}: ${job.company} - ${job.title}: ${err.message}`);
      results.push({ company: job.company, title: job.title, status: closed ? 'closed' : 'failed', error: err.message });
      if (!closed) break;
    }
  }

  // 发送成功（sent/auto_sent）的岗位在职位池里打 greeted 标记
  const greetedUrls = jobs
    .filter((job, i) => results[i] && (results[i].status === 'sent' || results[i].status === 'auto_sent') && job.url)
    .map((job) => job.url);
  if (greetedUrls.length) {
    try {
      const marked = await markCandidatesGreeted(greetedUrls);
      console.log(`[boss-db] 已标记 ${marked} 条 greeted`);
    } catch (err) {
      console.error(`[boss-db] greeted 标记失败（不影响发送结果）: ${err.message}`);
    }
  }
  const sentCount = results.filter((r) => r.status === 'sent').length;
  console.log(JSON.stringify({ sent: sentCount, results }, null, 2));
  // 打印真实生效的城市配额（已发/上限），而不是误导性的全局兜底值
  let quotaLine = '';
  if (cityLimits) {
    const sentByCity = countSentCompaniesTodayByCity({ urlCity });
    quotaLine = '今日各城配额（已发/上限）：' + Object.entries(cityLimits)
      .map(([city, cap]) => `${city} ${sentByCity[city] || 0}/${Number(cap)}`)
      .join('，');
  } else {
    quotaLine = `今日发送上限：${limit} 家。`;
  }
  printPostSendGuidance({ sentCount, quotaLine });
  if (sentCount > 0) console.log('📤 追踪表新增已写入 batch/tracker-additions/，运行 node merge-tracker.mjs 合并进 data/applications.md');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`boss-chrome-apply failed: ${err.message}`);
    process.exit(1);
  });
}
