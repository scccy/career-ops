#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  CANDIDATES_PATH,
  countUniqueCompanies,
  mergeJobs,
  parseArgs,
  readJson,
  uniqueCompanyKey,
  uniqueCandidateKey,
  writeJson,
} from './boss-common.mjs';

const BASE_URL = 'https://www.zhipin.com';
const DEFAULT_SKIP = /外包|派遣|猎头|驻场|某[^\\n]{0,16}公司|催收|电催|贷后|信用卡逾期|纯销售|电话销售|不缴社保|无社保|大小周/;
const DETAIL_HEADING = /岗位职责|工作职责|职位描述|岗位描述|职责描述|任职要求|职位要求|岗位要求|工作内容/;
const SALARY_MAP = new Map([
  [String.fromCharCode(0xE031), '0'],
  [String.fromCharCode(0xE032), '1'],
  [String.fromCharCode(0xE033), '2'],
  [String.fromCharCode(0xE034), '3'],
  [String.fromCharCode(0xE035), '4'],
  [String.fromCharCode(0xE036), '5'],
  [String.fromCharCode(0xE037), '6'],
  [String.fromCharCode(0xE038), '7'],
  [String.fromCharCode(0xE039), '8'],
  [String.fromCharCode(0xE03a), '9'],
]);

function decodeBossText(text = '') {
  return [...String(text)]
    .map((ch) => SALARY_MAP.get(ch) || ch)
    .join('')
    .replace(/\uFFFC/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execJs(js) {
  const script = `tell application "Google Chrome" to execute active tab of front window javascript ${JSON.stringify(js)}`;
  return execFileSync('osascript', ['-e', script], {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function execJson(js, fallback = null) {
  const raw = execJs(js);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function absoluteUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//.test(url)) return url;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

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
    url: absoluteUrl(raw.url || ''),
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

function extractScript(index) {
  return `
(() => {
  const pickText = (root, selectors) => {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
    }
    return '';
  };
  const pickHref = (root, selectors) => {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el.getAttribute('href') || '';
    }
    return '';
  };
  const cards = [...document.querySelectorAll('.job-list-container .job-card-box')];
  const card = cards[${index}];
  if (!card) return JSON.stringify({ ok: false, reason: 'card_not_found', count: cards.length });
  card.scrollIntoView({ block: 'center' });
  card.click();
  return JSON.stringify({
    ok: true,
    count: cards.length,
    card_text: card.innerText || '',
    card_alt: [...card.querySelectorAll('img')].map((img) => img.alt || '').join(' '),
    card_title: pickText(card, ['.job-name', '.job-title', 'a']),
    card_salary: pickText(card, ['.salary', '.job-salary']),
    card_company: pickText(card, ['.boss-name', '.company-name', '.company-text']),
    card_city: pickText(card, ['.company-location']) || (card.innerText || '').match(/(深圳(?:·[\\u4e00-\\u9fa5A-Za-z0-9]+){0,2}|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)/)?.[0] || '',
    card_url: pickHref(card, ['.job-name', 'a[href*="/job_detail/"]']),
  });
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
      .map((el) => el.innerText || '')
      .join('\\n')
      .trim();
  const tags = [...detail.querySelectorAll('.job-tags span, .job-keyword-list span, .tag-list span')]
    .map((el) => el.innerText.trim())
    .filter(Boolean);
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

async function extractJobs({ targetCompanies, maxCards, clickGapMs }) {
  const jobs = [];
  const seenJobs = new Set();
  const seenCompanies = new Set();
  let index = 0;
  let stagnant = 0;

  while (index < maxCards && seenCompanies.size < targetCompanies) {
    const count = execJson('JSON.stringify(document.querySelectorAll(".job-list-container .job-card-box").length)', 0);
    if (!count || index >= count) {
      const before = count || 0;
      execJs('document.querySelector(".job-list-container")?.scrollBy(0, 900); window.scrollBy(0, 900); "ok"');
      await sleep(clickGapMs);
      const after = execJson('JSON.stringify(document.querySelectorAll(".job-list-container .job-card-box").length)', 0);
      stagnant = after <= before ? stagnant + 1 : 0;
      if (stagnant >= 4) break;
      continue;
    }

    const cardMeta = execJson(extractScript(index), { ok: false, reason: 'extract_failed' });
    index += 1;
    await sleep(clickGapMs);
    if (!cardMeta?.ok) continue;
    const cardText = decodeBossText(`${cardMeta.card_text || ''}\n${cardMeta.card_alt || ''}`);
    if (DEFAULT_SKIP.test(cardText)) continue;

    const raw = execJson(detailScript(cardMeta), {});
    const job = normalizeJob(raw);
    const fullText = `${job.company}\n${job.title}\n${job.desc}`;
    if (DEFAULT_SKIP.test(fullText)) continue;
    if (!hasCompleteJd(job)) continue;

    const jobKey = uniqueCandidateKey(job);
    const companyKey = uniqueCompanyKey(job);
    if (!companyKey || seenJobs.has(jobKey) || seenCompanies.has(companyKey)) continue;
    seenJobs.add(jobKey);
    seenCompanies.add(companyKey);
    jobs.push(job);
  }

  return { jobs, scannedCards: index };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-chrome-extract.mjs --company-limit 27 [--append]');
    return;
  }

  const companyLimit = Number(args['company-limit'] || args.limit || 27);
  const maxCards = Number(args['max-cards'] || Math.max(companyLimit * 5, 80));
  const clickGapMs = Number(args['click-gap-ms'] || 1400);
  const output = args.output || CANDIDATES_PATH;
  const { jobs, scannedCards } = await extractJobs({ targetCompanies: companyLimit, maxCards, clickGapMs });
  const finalJobs = args.append ? mergeJobs(readJson(output, []), jobs) : jobs;
  if (!args['dry-run']) writeJson(output, finalJobs);

  console.log(JSON.stringify({
    extracted: jobs.length,
    scannedCards,
    total: finalJobs.length,
    uniqueCompanies: countUniqueCompanies(finalJobs),
    appended: Boolean(args.append),
    dryRun: Boolean(args['dry-run']),
    output: args['dry-run'] ? null : output,
    preview: jobs.slice(0, 10).map((job) => ({
      company: job.company,
      title: job.title,
      salary: job.salary,
      city: job.city,
      hr_active: job.hr_active,
    })),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`boss-chrome-extract failed: ${err.message}`);
    process.exit(1);
  });
}
