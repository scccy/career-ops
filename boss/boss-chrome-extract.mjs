#!/usr/bin/env node

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
  isCandidatesPath,
  loadCandidates,
  mergeIntoCandidates,
  saveCandidates,
} from './boss-common.mjs';
import { cdpExecJs, closeAllConnections } from './boss-cdp.mjs';

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

async function execJs(js) {
  return cdpExecJs(js);
}

async function execJson(js, fallback = null) {
  const raw = await execJs(js);
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

// 窥视：只读卡片文本/公司/岗位名，不点击（用于点击前与库内已知岗位比对）
function peekScript(index) {
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
  card.dataset.bossExtracted = '1'; // 先打标，避免重渲染后重复处理
  return JSON.stringify({
    ok: true,
    count: cards.length,
    card_text: card.innerText || '',
    card_alt: [...card.querySelectorAll('img')].map((img) => img.alt || '').join(' '),
    card_title: pickText(card, ['.job-name', '.job-title', 'a']),
    card_salary: pickText(card, ['.salary', '.job-salary']),
    card_company: pickText(card, ['.company-name', '.company-text', '.boss-name']),
    card_city: pickText(card, ['.company-location']) || (card.innerText || '').match(/(深圳(?:·[\\u4e00-\\u9fa5A-Za-z0-9]+){0,2}|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)/)?.[0] || '',
    card_url: pickHref(card, ['.job-name', 'a[href*="/job_detail/"]']),
  });
})()
`;
}

// 仅点击展开详情面板（确认是新岗位后才调用，避免对已知岗位无谓点击）
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

// BOSS 搜索页是**无限滚动**（没有「下一页」按钮），且真正的滚动容器是 window/body——
// `.job-list-container` 自身 overflow:visible、clientHeight === scrollHeight，对它 scrollBy 是空操作。
// 新一批卡片要滚动到位后 2~3 次（约 4~6 秒）才追加进 DOM，所以「连续几次无进展」必须容忍。
// 2026-09-30 实测：只滚 window 时卡片 90 → 105 → 120 稳定增长；旧逻辑因滚错容器 + 边滚边点导致
// 列表位置被反复重置，永远停在第一屏 15 张就 break。
const CARD_SEL = '.job-list-container .job-card-box';
const STAGNANT_LIMIT = 8; // 连续 8 次滚动（约 15 秒）无新卡片才判定到底
// 每张卡片之间随机休息，降低风控压力。
// 用户要求（2026-10-08）：原 1~3 秒偏快，加长到 3~6 秒；可用 BOSS_CARD_GAP_MIN_MS / BOSS_CARD_GAP_MAX_MS 覆盖。
const CARD_GAP_MIN_MS = Number(process.env.BOSS_CARD_GAP_MIN_MS || 3000);
const CARD_GAP_MAX_MS = Number(process.env.BOSS_CARD_GAP_MAX_MS || 6000);
// 点击前比对库内已有岗位：已入库则跳过（不点卡片、不计入名额）。默认开启；
// BOSS_SKIP_KNOWN=0/false 关闭；DB 不可用时自动降级为不跳过。
const SKIP_KNOWN = !(process.env.BOSS_SKIP_KNOWN === '0' || String(process.env.BOSS_SKIP_KNOWN).toLowerCase() === 'false');

// BOSS 风控拦截检测：命中即中止。否则页面被踢到验证/403 页时只会「静默返回 extracted: 0」，
// 看起来像正常空结果，极容易误判成入库或代码故障（2026-09-30 实际踩过一次）。
async function assertNotBlocked() {
  const state = await execJson(
    'JSON.stringify({ url: location.href, title: document.title, body: (document.body.innerText || "").slice(0, 200) })',
    {},
  );
  const text = `${state.url || ''} ${state.title || ''} ${state.body || ''}`;
  if (/verify\.html|安全验证|访问受限|403\.html|异常行为|暂时被限制访问/.test(text)) {
    throw new Error(
      `BOSS 风控拦截：页面已停在「${state.title || state.url}」。\n`
      + '  请到 BOSS Chrome 窗口手动完成验证/等待解封，确认能正常搜索后再重试。\n'
      + '  不要连续重试——会加重限制甚至延长封禁。',
    );
  }
  return state;
}

async function cardMetrics() {
  return execJson(
    `JSON.stringify({ n: document.querySelectorAll("${CARD_SEL}").length, y: scrollY, sh: document.body.scrollHeight })`,
    { n: 0, y: 0, sh: 0 },
  );
}

// 阶段一：只滚动、不点击，把卡片载入 DOM（点击会重置列表滚动位置，故此阶段不点）。
async function loadCards({ targetCards, maxCards, clickGapMs }) {
  let last = await cardMetrics();
  let stagnant = 0;
  while (last.n < Math.min(targetCards, maxCards)) {
    await execJs('window.scrollTo(0, document.body.scrollHeight); "ok"');
    await sleep(Math.max(clickGapMs, 1200));
    const now = await cardMetrics();
    const grew = now.n > last.n || now.sh > last.sh;
    if (grew) console.error(`[载入] 卡片 ${now.n} 张 / 列表高 ${now.sh}px`);
    stagnant = grew ? 0 : stagnant + 1;
    if (stagnant >= STAGNANT_LIMIT) break;
    last = now;
  }
  return last.n;
}

async function extractJobs({ targetCompanies, maxCards, clickGapMs }) {
  const jobs = [];
  const seenJobs = new Set();
  const seenCompanies = new Set();
  let skippedKnown = 0;

  await assertNotBlocked(); // 开局先确认不在风控页

  // 点击前比对：加载库内已有候选键，已入库的岗位直接跳过（不点卡片、不计入名额）
  let existingJobKeys = null;
  if (SKIP_KNOWN) {
    try {
      const all = await loadCandidates();
      existingJobKeys = new Set(all.map((j) => uniqueCandidateKey(j)).filter(Boolean));
      console.error(`[已知岗位] 已从库加载 ${existingJobKeys.size} 条候选键，点击前比对跳过`);
    } catch (e) {
      console.error(`[已知岗位] 加载失败，降级为不跳过：${e.message}`);
      existingJobKeys = null;
    }
  }

  // 先载入约 2 倍目标公司数的卡片（每张卡≈1 家公司，且含重复/被跳过项）
  const loaded = await loadCards({
    targetCards: Math.max(targetCompanies * 2, 30),
    maxCards,
    clickGapMs,
  });
  console.error(`[载入] 完成，DOM 内 ${loaded} 张卡片，开始逐张采集`);

  let scanned = 0;
  let stagnant = 0;
  // 阶段二：先窥视（不点击）→ 与库内已有岗位比对 → 新岗位才点击展开抽取。
  while (scanned < maxCards && seenCompanies.size < targetCompanies) {
    const pos = await execJson(
      `(() => {
        const cards = [...document.querySelectorAll("${CARD_SEL}")];
        return JSON.stringify(cards.findIndex((c) => !c.dataset.bossExtracted));
      })()`,
      -1,
    );

    if (pos < 0) {
      // 当前已载入的卡片都处理完了：再滚一段继续载入
      await assertNotBlocked(); // 长时间运行时风控可能中途介入
      const before = await cardMetrics();
      await execJs('window.scrollTo(0, document.body.scrollHeight); "ok"');
      await sleep(Math.max(clickGapMs, 1200));
      const after = await cardMetrics();
      const grew = after.n > before.n || after.sh > before.sh;
      stagnant = grew ? 0 : stagnant + 1;
      if (stagnant >= STAGNANT_LIMIT) break;
      continue;
    }

    // 窥视：只读卡片文本/公司/岗位名，不点击
    const cardMeta = await execJson(peekScript(pos), { ok: false, reason: 'peek_failed' });
    if (!cardMeta?.ok) continue;
    // 新增环节（用户要求 2026-10-08）：点击前与库内已有岗位比对，已入库则跳过
    const preKey = uniqueCandidateKey({ company: cardMeta.card_company, title: cardMeta.card_title });
    if (existingJobKeys && preKey && existingJobKeys.has(preKey)) {
      skippedKnown += 1;
      continue;
    }
    // 新岗位：点击展开详情面板
    await execJs(clickScript(pos));
    scanned += 1;
    // 卡片间随机 3~6 秒（用户要求 2026-10-08 加长），同时给右侧详情面板留渲染时间
    await sleep(CARD_GAP_MIN_MS + Math.floor(Math.random() * (CARD_GAP_MAX_MS - CARD_GAP_MIN_MS)));
    const cardText = decodeBossText(`${cardMeta.card_text || ''}\n${cardMeta.card_alt || ''}`);
    if (DEFAULT_SKIP.test(cardText)) continue;

    const raw = await execJson(detailScript(cardMeta), {});
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

  return { jobs, scannedCards: scanned, skippedKnown };
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
  const { jobs, scannedCards, skippedKnown } = await extractJobs({ targetCompanies: companyLimit, maxCards, clickGapMs });
  let finalJobs;
  if (isCandidatesPath(output)) {
    // 职位池走 MySQL（2026-09-23 用户确认）：dry-run 只读不写；append 库内合并，非 append 整池重写；saveCandidates 落 JSON 备份镜像
    finalJobs = args['dry-run']
      ? (args.append ? mergeJobs(await loadCandidates(), jobs) : jobs)
      : (args.append ? await mergeIntoCandidates(jobs) : await saveCandidates(jobs));
  } else {
    finalJobs = args.append ? mergeJobs(readJson(output, []), jobs) : jobs;
    if (!args['dry-run']) writeJson(output, finalJobs);
  }

  console.log(JSON.stringify({
    extracted: jobs.length,
    scannedCards,
    skippedKnown: skippedKnown || 0,
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
  main()
    .catch((err) => { console.error(`boss-chrome-extract failed: ${err.message}`); process.exitCode = 1; })
    .finally(closeAllConnections);
}
