#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  QUEUE_PATH,
  appendApplication,
  appendSentLog,
  countSentCompaniesToday,
  loadProfile,
  loadSentCompanyKeys,
  loadSentKeys,
  parseArgs,
  readJson,
  uniqueCompanyKey,
  uniqueJobKey,
} from './boss-common.mjs';

const RECENT_COMPANY_DEDUPE_DAYS = 30;

function execJs(js) {
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
    const ok = execJson(predicateJs, false);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

function pageString(value) {
  return JSON.stringify(String(value || ''));
}

function candidatesFromQueue(queue, { threshold, limit }) {
  const sentJobs = loadSentKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const recentSentCompanies = loadSentCompanyKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const sentToday = countSentCompaniesToday();
  const remainingToday = Math.max(0, limit - sentToday);
  const seenCompanies = new Set();
  const jobs = queue
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .filter((job) => Number(job.score) >= threshold)
    .filter((job) => !sentJobs.has(uniqueJobKey(job)))
    .filter((job) => {
      const key = uniqueCompanyKey(job);
      if (recentSentCompanies.has(key) || seenCompanies.has(key)) return false;
      seenCompanies.add(key);
      return true;
    })
    .slice(0, remainingToday);
  return { jobs, sentToday, remainingToday };
}

function printPostSendGuidance({ sentCount, dailyLimit }) {
  if (sentCount <= 0) return;
  console.log('');
  console.log(`已投递成功：本轮已向 ${sentCount} 家公司发送 BOSS 打招呼。`);
  console.log(`如果对方要求发送简历，或者你自己投递的公司要求发送简历，请把公司名称或 BOSS 直聘岗位链接发给我。`);
  console.log(`我会根据该岗位 JD 和你的原始简历，定制一版匹配该岗位的 cv.md 和中文 PDF 简历；只优化表达和重点，不编造经历、技能、证书或薪资。`);
  console.log(`今日发送上限：${dailyLimit} 家。`);
}

async function sendOne(job, { gapMs = 1200 } = {}) {
  const greeting = String(job.greeting || '').trim();
  if (!greeting) throw new Error('缺少打招呼文案');

  execJs(`location.href = ${JSON.stringify(job.url)}; 'navigating'`);
  const loaded = await waitFor(
    `JSON.stringify(document.readyState === 'complete' || document.body.innerText.includes(${JSON.stringify(job.title || '')}))`,
    25000,
    700,
  );
  if (!loaded) throw new Error('岗位页面加载超时');
  await sleep(gapMs);

  const buttonInfo = execJson(`
JSON.stringify((() => {
  const items = [...document.querySelectorAll('a,button')].map((el, index) => ({
    index,
    text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim(),
    cls: String(el.className || ''),
    href: el.getAttribute('href') || ''
  }));
  const hit = items.find((item) => /立即沟通|继续沟通|聊一聊/.test(item.text));
  if (!hit) return { ok: false, reason: 'no_chat_button', items: items.filter((item) => /沟通|聊天|发送|继续/.test(item.text)).slice(0, 10) };
  [...document.querySelectorAll('a,button')][hit.index].click();
  return { ok: true, button: hit };
})())`, {});
  if (!buttonInfo?.ok) throw new Error(`未找到“立即沟通”按钮：${JSON.stringify(buttonInfo?.items || [])}`);
  await sleep(gapMs);

  const inputReady = await waitFor(`
JSON.stringify((() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], .input-area, .chat-input, .input-box')];
  return nodes.some((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
})())`, 12000, 500);
  if (!inputReady) throw new Error('点击立即沟通后未找到消息输入框');

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
  if (!fillInfo?.ok) throw new Error(`未能填入打招呼文案：${fillInfo?.reason || 'unknown'}`);

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
    throw new Error(`发送按钮未激活：${JSON.stringify(state)}`);
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
  if (!verified) throw new Error('点击发送后未在聊天记录中验证到自定义打招呼文案，未记为成功');
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-chrome-apply.mjs --threshold 4.0 --daily-limit 20 --confirmed-review [--dry-run]');
    return;
  }
  if (!args['dry-run'] && !args['confirmed-review']) {
    throw new Error('真实发送前必须先向用户展示 data/boss-review.md 的前 20 家确认清单，并在用户明确确认后加 --confirmed-review。');
  }

  const profile = loadProfile();
  const queue = readJson(args.input || QUEUE_PATH, []);
  const threshold = Number(args.threshold ?? profile?.boss?.send_threshold ?? 4.0);
  const limit = Number(args['daily-limit'] ?? profile?.boss?.daily_limit ?? 20);
  const { jobs, sentToday, remainingToday } = candidatesFromQueue(queue, { threshold, limit });

  if (args['dry-run']) {
    console.log(JSON.stringify({
      dryRun: true,
      threshold,
      dailyLimit: limit,
      sentCompaniesToday: sentToday,
      remainingToday,
      willSend: jobs.map((job) => ({
        company: job.company,
        title: job.title,
        score: job.score,
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
      appendSentLog({ job, status: 'failed', message: job.greeting, error: err.message });
      console.error(`failed: ${job.company} - ${job.title}: ${err.message}`);
      results.push({ company: job.company, title: job.title, status: 'failed', error: err.message });
      break;
    }
  }

  const sentCount = results.filter((r) => r.status === 'sent').length;
  console.log(JSON.stringify({ sent: sentCount, results }, null, 2));
  printPostSendGuidance({ sentCount, dailyLimit: limit });
  if (sentCount > 0) console.log('📤 追踪表新增已写入 batch/tracker-additions/，运行 node merge-tracker.mjs 合并进 data/applications.md');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`boss-chrome-apply failed: ${err.message}`);
    process.exit(1);
  });
}
