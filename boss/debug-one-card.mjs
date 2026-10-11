#!/usr/bin/env node
// debug-one-card.mjs — BOSS 抽取链路单卡片调试（临时脚本）
//
// 目的：验证「CDP 连接 → peek 第 0 卡片 → 点击展开 → 读详情 → 规范化」整条链路，
//       只跑 1 张卡片，不滚动、不写 MySQL、不写文件、不触发任何配额/去重。
// 前置：Chrome 已带 --remote-debugging-port=9222 启动，且当前标签页停在 BOSS 搜索结果页（已登录）。
//
// 用法：
//   node boss/debug-one-card.mjs              # 处理当前 BOSS 标签页的第 0 张卡片
//   node boss/debug-one-card.mjs --goto <url> # 先导航到搜索页（如 https://www.zhipin.com/web/geek/job?...）再处理
//   node boss/debug-one-card.mjs --index 2    # 处理第 N 张卡片（默认 0）
//   node boss/debug-one-card.mjs --probe       # 只打印当前 CDP 标签页清单，不抽取
//
// 退出码：0=成功打印 1 张卡片；非 0=链路异常（CDP 不可用 / 不在搜索页 / 卡片缺失 / 风控页）。

import { pathToFileURL } from 'url';
import { cdpExecJs, cdpExecJson, resolveTarget, gotoUrl, probe, assertAvailable, closeAllConnections } from './boss-cdp.mjs';

const BASE_URL = 'https://www.zhipin.com';
const DEFAULT_SKIP = /外包|派遣|猎头|驻场|某[^\\n]{0,16}公司|催收|电催|贷后|信用卡逾期|纯销售|电话销售|不缴社保|无社保|大小周/;
const DETAIL_HEADING = /岗位职责|工作职责|职位描述|岗位描述|职责描述|任职要求|职位要求|岗位要求|工作内容/;

const SALARY_MAP = new Map([
  ['', '0'], ['', '1'], ['', '2'], ['', '3'], ['', '4'],
  ['', '5'], ['', '6'], ['', '7'], ['', '8'], ['', '9'],
]);

function decodeBossText(text = '') {
  return [...String(text)]
    .map((ch) => SALARY_MAP.get(ch) || ch)
    .join('')
    .replace(/￼/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
}

const CARD_SEL = '.job-list-container .job-card-box';

function hasCompleteJd(job) {
  const desc = String(job.desc || '').replace(/\s+/g, '');
  return desc.length >= 180 && DETAIL_HEADING.test(desc);
}

function normalizeJob(raw) {
  const job = {
    source: 'boss-chrome',
    company: decodeBossText(raw.company || ''),
    title: decodeBossText(raw.title || ''),
    salary: decodeBossText(raw.salary || ''),
    city: decodeBossText(raw.city || ''),
    desc: decodeBossText(raw.desc || ''),
    hr_active: decodeBossText(raw.hr_active || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(decodeBossText).filter(Boolean) : [],
    url: raw.url ? (raw.url.startsWith('http') ? raw.url : `${BASE_URL}${raw.url.startsWith('/') ? '' : '/'}${raw.url}`) : '',
    can_chat: raw.can_chat !== false,
    already_contacted: Boolean(raw.already_contacted),
    scanned_at: new Date().toISOString(),
  };
  job.jd_detail = {
    ok: hasCompleteJd(job),
    reason: hasCompleteJd(job) ? '已包含右侧完整岗位详情' : '岗位描述过短或未识别到职责/要求结构',
  };
  return job;
}

function peekScript(index) {
  return `
(() => {
  const pickText = (root, selectors) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
    }
    return '';
  };
  const pickHref = (root, selectors) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el.getAttribute('href') || '';
    }
    return '';
  };
  const cards = [...document.querySelectorAll('.job-list-container .job-card-box')];
  const card = cards[${index}];
  if (!card) return JSON.stringify({ ok: false, reason: 'card_not_found', count: cards.length });
  card.dataset.bossExtracted = '1';
  return JSON.stringify({
    ok: true,
    count: cards.length,
    card_text: card.innerText || '',
    card_alt: [...card.querySelectorAll('img')].map((img) => img.alt || '').join(' '),
    card_title: pickText(card, ['.job-name', '.job-title', 'a']),
    card_salary: pickText(card, ['.salary', '.job-salary']),
    card_company: pickText(card, ['.company-name', '.company-text']),
    card_city: pickText(card, ['.company-location']) || (card.innerText || '').match(/(深圳(?:·[\\u4e00-\\u9fa5A-Za-z0-9]+){0,2}|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)/)?.[0] || '',
    card_url: pickHref(card, ['.job-name', 'a[href*="/job_detail/"]']),
  });
})()
`;
}

function clickScript(index) {
  return `
(() => {
  const cards = [...document.querySelectorAll('.job-list-container .job-card-box')];
  const card = cards[${index}];
  if (!card) return JSON.stringify({ ok: false });
  card.scrollIntoView({ block: 'center' });
  card.click();
  return JSON.stringify({ ok: true });
})()
`;
}

function detailScript(cardMeta) {
  return `
(() => {
  const text = (selector) => document.querySelector(selector)?.innerText?.trim() || '';
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || '';
  const detail = document.querySelector('.job-detail-box') || document;
  const desc = detail.querySelector('.desc')?.innerText?.trim()
    || [...detail.querySelectorAll('h3, .job-sec-text, .text, .job-detail-section')]
      .map((el) => el.innerText || '').join('\\n').trim();
  const tags = [...detail.querySelectorAll('.job-tags span, .job-keyword-list span, .tag-list span')]
    .map((el) => el.innerText.trim()).filter(Boolean);
  return JSON.stringify({
    title: text('.job-detail-box .job-name') || ${JSON.stringify(cardMeta.card_title || '')},
    salary: text('.job-detail-box .job-salary') || ${JSON.stringify(cardMeta.card_salary || '')},
    company: text('.job-detail-box .company-name') || text('.job-detail-box .boss-name') || ${JSON.stringify(cardMeta.card_company || '')},
    city: ${JSON.stringify(cardMeta.card_city || '')},
    desc,
    hr_active: text('.job-detail-box .boss-active-time') || text('.boss-active-time'),
    tags,
    url: attr('.job-detail-box a[href*="/job_detail/"]', 'href') || ${JSON.stringify(cardMeta.card_url || '')},
    can_chat: /立即沟通/.test(document.body.innerText || ''),
    already_contacted: /已沟通/.test(${JSON.stringify(cardMeta.card_text || '')}),
  });
})()
`;
}

function assertNotBlocked() {
  const state = cdpExecJson(
    'JSON.stringify({ url: location.href, title: document.title, body: (document.body.innerText || "").slice(0, 200) })',
    {},
  );
  const txt = `${state.url || ''} ${state.title || ''} ${state.body || ''}`;
  if (/verify\.html|安全验证|访问受限|403\.html|异常行为|暂时被限制访问/.test(txt)) {
    throw new Error(`BOSS 风控拦截：页面停在「${state.title || state.url}」。请到 Chrome 窗口手动验证后再试。`);
  }
  return state;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--probe') args.probe = true;
    else if (argv[i] === '--goto') args.goto = argv[++i];
    else if (argv[i] === '--index') args.index = Number(argv[++i]);
  }
  const index = Number.isFinite(args.index) ? args.index : 0;

  await assertAvailable();

  if (args.probe) {
    console.log(await probe());
    return;
  }

  if (args.goto) {
    const out = await gotoUrl(args.goto);
    console.error(`[goto] ${JSON.stringify(out)}`);
    if (!out.ok) throw new Error(`导航失败：${out.reason || out.url}`);
  }

  const target = await resolveTarget();
  console.error(`[target] ${target.title || ''} | ${target.url || ''}`);
  if (!/(^|\.)zhipin\.com/i.test(new URL(target.url, 'https://x').hostname || '')) {
    throw new Error('当前标签页不是 BOSS 直聘页面。请先在 Chrome 窗导航到搜索结果页（已登录），或加 --goto <搜索页URL>。');
  }

  assertNotBlocked();

  // 1) peek 第 index 张卡片（不点击）
  const cardMeta = cdpExecJson(peekScript(index), { ok: false, reason: 'peek_failed' });
  if (!cardMeta?.ok) {
    throw new Error(`第 ${index} 张卡片 peek 失败：${JSON.stringify(cardMeta)}（可能不在搜索结果页或卡片未加载）`);
  }
  console.error(`[peek] DOM 共 ${cardMeta.count} 张卡片，处理第 ${index} 张：${cardMeta.card_company} / ${cardMeta.card_title}`);

  // 2) 点击展开详情面板
  const clicked = cdpExecJson(clickScript(index), { ok: false });
  if (!clicked?.ok) throw new Error('点击卡片失败');
  await sleep(2500); // 给右侧详情面板渲染时间

  // 3) 读详情
  const raw = cdpExecJson(detailScript(cardMeta), {});
  const job = normalizeJob(raw);
  const cardText = decodeBossText(`${cardMeta.card_text || ''}\n${cardMeta.card_alt || ''}`);

  // 4) 打印调试结果（不写库、不写文件）
  const skipped = DEFAULT_SKIP.test(`${job.company}\n${job.title}\n${job.desc}`) || DEFAULT_SKIP.test(cardText);
  console.log(JSON.stringify({
    index,
    peek: cardMeta,
    normalized: job,
    default_skip_matched: skipped,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => { closeAllConnections(); })
    .catch((err) => {
      console.error(`debug-one-card failed: ${err.message}`);
      closeAllConnections();
      process.exit(1);
    });
}
