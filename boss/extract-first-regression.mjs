#!/usr/bin/env node
// extract-first-regression.mjs — BOSS「抓取第一张卡片并持久化到 MySQL」回归脚本
//
// 与 debug-one-card.mjs（仅打印、不落库）不同，本脚本走完整持久化链路：
//   CDP 连接 → 抽第 0 张卡片（peek→点击→读详情）→ 规范化 → 单条 upsert 入 career_ops.boss_jobs
//   → 回读该行验证 → 打印落库结果。
// 已落库的同 key_hash 岗位会被覆盖更新（ON DUPLICATE KEY UPDATE），不会清空整张表。
//
// 前置：Chrome 已带 --remote-debugging-port=9222 启动，且当前标签页停在 BOSS 搜索结果页（已登录）。
// 环境变量：MYSQL_PASSWORD（默认走 boss-common 的 root123456 覆盖）、BOSS_CDP_PORT（默认 9222）、
//           BOSS_INDEX（处理第 N 张卡片，默认 0）。
//
// 用法：
//   node boss/extract-first-regression.mjs                 # 抓第 0 张并落库
//   node boss/extract-first-regression.mjs --probe         # 只列 CDP 标签页，不抽
//   node boss/extract-first-regression.mjs --index 2       # 抓第 2 张
//   node boss/extract-first-regression.mjs --dry-run       # 抽但不落库（打印）
//   MYSQL_PASSWORD=root123456 node boss/extract-first-regression.mjs

import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import mysql from 'mysql2/promise';
import {
  candidateKeyHash,
  uniqueCandidateKey,
  uniqueCompanyKey,
  resolveBossCityCode,
} from './boss-common.mjs';
import { assertAvailable, cdpExecJs, cdpExecJson, resolveTarget, gotoUrl, probe, closeAllConnections } from './boss-cdp.mjs';

// boss-common.mjs 的 BOSS_JOBS_TABLE/DB_NAME/DB_CONFIG 是未导出的文件内常量，这里按相同值重建，
// 保证回归脚本独立连库（不耦合内部实现）。连接参数同样可用环境变量覆盖。
const DB_NAME = process.env.MYSQL_DB || 'career_ops';
const BOSS_JOBS_TABLE = `\`${DB_NAME}\`.\`boss_jobs\``;
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'asdsc88-+Q12',
  connectionLimit: 5,
  waitForConnections: true,
};

// —— 以下抽取/规范化逻辑与 boss-chrome-extract.mjs 保持一致（单卡片版）——
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
  const pickText = (root, selectors) => { for (const s of selectors) { const el = root.querySelector(s); if (el && el.innerText && el.innerText.trim()) return el.innerText.trim(); } return ''; };
  const pickHref = (root, selectors) => { for (const s of selectors) { const el = root.querySelector(s); if (el) return el.getAttribute('href') || ''; } return ''; };
  const cards = [...document.querySelectorAll('.job-list-container .job-card-box')];
  const card = cards[${index}];
  if (!card) return JSON.stringify({ ok: false, reason: 'card_not_found', count: cards.length });
  card.dataset.bossExtracted = '1';
  return JSON.stringify({
    ok: true, count: cards.length,
    card_text: card.innerText || '',
    card_alt: [...card.querySelectorAll('img')].map((img) => img.alt || '').join(' '),
    card_title: pickText(card, ['.job-name', '.job-title', 'a']),
    card_salary: pickText(card, ['.salary', '.job-salary']),
    card_company: pickText(card, ['.company-name', '.company-text', '.boss-name']),
    card_city: pickText(card, ['.company-location']) || (card.innerText || '').match(/(深圳(?:·[\\u4e00-\\u9fa5A-Za-z0-9]+){0,2}|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)/)?.[0] || '',
    card_url: pickHref(card, ['.job-name', 'a[href*="/job_detail/"]']),
  });
})()`;
}
function clickScript(index) {
  return `
(() => { const cards = [...document.querySelectorAll('.job-list-container .job-card-box')]; const card = cards[${index}]; if (!card) return JSON.stringify({ ok: false }); card.scrollIntoView({ block: 'center' }); card.click(); return JSON.stringify({ ok: true }); })()`;
}
function detailScript(cardMeta) {
  return `
(() => {
  const text = (s) => document.querySelector(s)?.innerText?.trim() || '';
  const attr = (s, n) => document.querySelector(s)?.getAttribute(n) || '';
  const detail = document.querySelector('.job-detail-box') || document;
  const desc = detail.querySelector('.desc')?.innerText?.trim() || [...detail.querySelectorAll('h3, .job-sec-text, .text, .job-detail-section')].map((el) => el.innerText || '').join('\\n').trim();
  const tags = [...detail.querySelectorAll('.job-tags span, .job-keyword-list span, .tag-list span')].map((el) => el.innerText.trim()).filter(Boolean);
  return JSON.stringify({
    title: text('.job-detail-box .job-name') || ${JSON.stringify(cardMeta.card_title || '')},
    salary: text('.job-detail-box .job-salary') || ${JSON.stringify(cardMeta.card_salary || '')},
    company: text('.job-detail-box .company-name') || text('.job-detail-box .boss-name') || ${JSON.stringify(cardMeta.card_company || '')},
    city: ${JSON.stringify(cardMeta.card_city || '')},
    desc, hr_active: text('.job-detail-box .boss-active-time') || text('.boss-active-time'),
    tags,
    url: attr('.job-detail-box a[href*="/job_detail/"]', 'href') || ${JSON.stringify(cardMeta.card_url || '')},
    can_chat: /立即沟通/.test(document.body.innerText || ''),
    already_contacted: /已沟通/.test(${JSON.stringify(cardMeta.card_text || '')}),
  });
})()`;
}
// 自己封装 JSON 求值（直接走 cdpExecJs + JSON.parse，避免 cdpExecJson 的缓存/串台问题）
async function evalJson(js, fallback = null) {
  const raw = await cdpExecJs(js);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function assertNotBlocked() {
  const state = await evalJson('JSON.stringify({ url: location.href, title: document.title, body: (document.body.innerText || "").slice(0, 200) })', {});
  const txt = `${state.url || ''} ${state.title || ''} ${state.body || ''}`;
  if (/verify\.html|安全验证|访问受限|403\.html|异常行为|暂时被限制访问/.test(txt)) {
    throw new Error(`BOSS 风控拦截：页面停在「${state.title || state.url}」。请手动验证后再试。`);
  }
}
function parseSalaryMinMax(salary) {
  const text = String(salary || '');
  if (/元\/(天|时|月)/.test(text) || /面议/.test(text)) return { min: null, max: null };
  const m = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i) || text.match(/(\d+(?:\.\d+)?)\s*K/i);
  if (!m) return { min: null, max: null };
  const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}
function jobRow(job) {
  const scanned = job.scanned_at ? new Date(job.scanned_at) : null;
  const cityPrefix = String(job.city || '').split('·')[0].slice(0, 120);
  const { min, max } = parseSalaryMinMax(job.salary);
  return [
    candidateKeyHash(job),
    String(job.company || '').slice(0, 190),
    String(job.title || '').slice(0, 250),
    String(job.salary || '').slice(0, 120),
    cityPrefix,
    String(job.url || '').slice(0, 760),
    job.greeted ? 1 : 0,
    min, max,
    null, // score：抽取阶段不评分
    String(job.status || '').slice(0, 30),
    scanned && !Number.isNaN(scanned.getTime()) ? scanned : null,
    JSON.stringify(job),
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 自动构造 BOSS 搜索页 URL：取 profile.yml 首个城市 + 首个查询词（与 boss-extract-3cities.sh 同源）
function autoSearchUrl() {
  const profile = yaml.load(readFileSync('config/profile.yml', 'utf-8')) || {};
  const boss = profile.boss || {};
  const city = (boss.daily_extract_cities && boss.daily_extract_cities[0]) || '杭州';
  const query = (boss.daily_extract_queries && boss.daily_extract_queries[0]) || '数据开发';
  const code = resolveBossCityCode(city) || '101210100';
  const enc = encodeURIComponent(query);
  return `https://www.zhipin.com/web/geek/jobs?query=${enc}&city=${code}`;
}

async function upsertJob(pool, job) {
  const cols = ['key_hash','company','title','salary','city','url','greeted','salary_min','salary_max','score','status','scanned_at','raw'];
  const row = jobRow(job);
  const place = cols.map((c) => '?').join(', ');
  const updates = cols.filter((c) => c !== 'key_hash').map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  const sql = `INSERT INTO ${BOSS_JOBS_TABLE} (${cols.map((c) => '`' + c + '`').join(', ')}) VALUES (${place}) ON DUPLICATE KEY UPDATE ${updates}`;
  const [ret] = await pool.query(sql, row);
  return ret;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--probe') args.probe = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--goto') args.goto = argv[++i];
    else if (argv[i] === '--index') args.index = Number(argv[++i]);
  }
  const index = Number.isFinite(args.index) ? args.index : (Number(process.env.BOSS_INDEX) || 0);

  await assertAvailable();
  if (args.probe) { console.log(await probe()); return; }

  let targetUrl = args.goto;
  if (!targetUrl) {
    // 自动打开 BOSS 搜索页：读 profile.yml 的首个城市 + 首个查询词
    targetUrl = autoSearchUrl();
    console.error(`[auto] 未指定 --goto，自动打开 BOSS 搜索页：${targetUrl}`);
  }
  const out = await gotoUrl(targetUrl);
  console.error(`[goto] ${JSON.stringify(out)}`);
  if (!out.ok) throw new Error(`导航失败：${out.reason || out.url}`);

  const target = await resolveTarget();
  console.error(`[target] ${target.title || ''} | ${target.url || ''}`);
  if (!/(^|\.)zhipin\.com/i.test(new URL(target.url, 'https://x').hostname || '')) {
    throw new Error('当前标签页不是 BOSS 直聘页面。请先导航到搜索结果页（已登录），或加 --goto <URL>。');
  }

  // 轮询等待卡片渲染（BOSS 搜索结果是异步加载），并检测风控/登录页
  let cardMeta = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    assertNotBlocked(); // 若被重置到登录/安全验证页，立即抛错停止
    const m = await evalJson(peekScript(index), { ok: false, reason: 'peek_failed', count: 0 });
    if (m?.ok) { cardMeta = m; break; }
    await sleep(1500);
  }
  if (!cardMeta || !cardMeta.ok) throw new Error(`第 ${index} 张卡片 peek 失败（25s 内未渲染卡片，可能登录态失效或被风控重置）。请确认 Chrome 停留在 BOSS 搜索结果页。`);
  console.error(`[peek] DOM 共 ${cardMeta.count} 张，处理第 ${index} 张：${cardMeta.card_company} / ${cardMeta.card_title}`);

  const clicked = await evalJson(clickScript(index), { ok: false });
  if (!clicked?.ok) throw new Error('点击卡片失败');
  await sleep(2500);

  const raw = await evalJson(detailScript(cardMeta), {});
  const job = normalizeJob(raw);
  const cardText = decodeBossText(`${cardMeta.card_text || ''}\n${cardMeta.card_alt || ''}`);
  const matched = `${job.company}\n${job.title}\n${job.desc}\n${cardText}`.match(DEFAULT_SKIP);
  const skippedByRule = Boolean(matched);

  if (args.dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', index, skippedByRule, matchedRule: matched?.[0] || null, normalized: job }, null, 2));
    return;
  }
  if (skippedByRule) {
    // 回归脚本以验证「抽→落库」链路为目的，不照搬生产风控硬拦截：标记后照常落库
    console.error(`[warn] 命中 DEFAULT_SKIP 规则 "${matched[0]}"，仍按回归链路落库（生产扫描会跳过）`);
  }
  if (!hasCompleteJd(job)) {
    console.log(JSON.stringify({ mode: 'skipped-no-jd', index, reason: 'JD 不完整（<180 字或无职责/要求结构）', peek_company: cardMeta.card_company, title: job.title }, null, 2));
    return;
  }

  // 持久化：单条 upsert 入 MySQL
  const pool = mysql.createPool({ ...DB_CONFIG });
  try {
    await pool.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const ret = await upsertJob(pool, job);
    const keyHash = candidateKeyHash(job);
    const [rows] = await pool.query(`SELECT id, key_hash, company, title, salary, city, greeted, score, scanned_at FROM ${BOSS_JOBS_TABLE} WHERE key_hash = ?`, [keyHash]);
    console.log(JSON.stringify({
      mode: 'persisted',
      index,
      affectedRows: ret.affectedRows,
      key_hash: keyHash,
      company_key: uniqueCompanyKey(job),
      stored: rows[0] || null,
      note: '数据已落 career_ops.boss_jobs；JSON 备份镜像(data/boss-candidates.json)由正式 extract 脚本维护，本回归脚本只写库。',
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => closeAllConnections())
    .catch((err) => { console.error(`extract-first-regression failed: ${err.message}`); closeAllConnections(); process.exit(1); });
}
