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
import { cdpExecJs, closeAllConnections, bringToFront } from './boss-cdp.mjs';
import { createCardBudget, createCardLoader, createKnownCardStreak, createYieldStreak, ensureTabVisible, CARD_SEL } from './boss-card-loader.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import { buildWordRegex, NEVER_MATCH, resolveExtractSkipWords } from './skip-rules.mjs';

const BASE_URL = 'https://www.zhipin.com';
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

// JD 完整性门禁开关（2026-10-14）：BOSS_REQUIRE_FULL_JD=false 时不在抽取阶段丢弃
// 「<180 字或无职责/要求结构」的岗位——它们照常入库，jd_detail 仍如实记录原始判定，
// 由后续评分/人工审阅把关。默认关闭（false，用户指令 2026-10-14），
// BOSS_REQUIRE_FULL_JD=true 或控制台勾选「JD完整性过滤」可重新开启。
const REQUIRE_FULL_JD = process.env.BOSS_REQUIRE_FULL_JD === 'true'
  || String(process.env.BOSS_REQUIRE_FULL_JD).toLowerCase() === 'true';

// 单关键词 DOM 卡片上限（2026-10-15 用户要求，默认 135 张）。
// 为什么不能只靠 --max-cards：那个上限数的是「点击」，而已入库岗位在点击前就被跳过
// （不消耗点击额度）。所以「整页都是上次扫过的岗位」时，点击上限与产出止损都不会触发，
// 唯一兜底是滚到真页底——每个关键词都要把同一条列表从头重走一遍。这里给每个关键词一个
// 硬预算：DOM 里累计加载到这么多张就不再往下加载（手里那批照常处理完）。
// BOSS_MAX_DOM_CARDS=0 关闭；非法值回落 135。
const MAX_DOM_CARDS = (() => {
  const raw = process.env.BOSS_MAX_DOM_CARDS;
  if (raw === undefined || String(raw).trim() === '') return 135;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 135;
})();

// 连续多少张卡片都是「已入库岗位」就结束本词扫描（2026-10-15 用户提出，默认 60）。
// 本词列表前半段通常全是上几次扫过的岗位；连续命中说明剩余列表对本次扫描没有产出，
// 继续往下滚只是白跑。中间出现任何一张非「已入库」卡片即清零。
// BOSS_KNOWN_STREAK_LIMIT=0 关闭；非法值回落 60。
const KNOWN_STREAK_LIMIT = (() => {
  const raw = process.env.BOSS_KNOWN_STREAK_LIMIT;
  if (raw === undefined || String(raw).trim() === '') return 60;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60;
})();

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
  const cards = [...document.querySelectorAll("${CARD_SEL}")];
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
  const cards = [...document.querySelectorAll("${CARD_SEL}")];
  const card = cards[${index}];
  if (!card) return JSON.stringify({ ok: false });
  card.scrollIntoView({ block: 'center' });
  card.click();
  return JSON.stringify({ ok: true });
})()
`;
}

function detailScript(cardMeta, scanCity = '') {
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
    city: ${JSON.stringify(cardMeta.card_city || scanCity || '')},
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
//
// 载入方式（2026-10-14 用户要求）：不再开局把整页卡片一次性滚出来，改为「手里的卡片不够了再往下滚
// 一小段补一批」。滚动/补货的判定在 boss-card-loader.mjs，这里只解析环境变量并注入。
// `--click-gap-ms` 历史上控制的就是「滚动加载时的停顿」（卡片之间的停顿一直由 BOSS_CARD_GAP_*_MS 管），
// 现在沿用为「每滚一步之间的停顿」基准；要精确控制区间可用 BOSS_SCROLL_STEP_GAP_MIN/MAX_MS。
function cardLoaderConfig(clickGapMs = 0) {
  const pace = Number(clickGapMs) > 0 ? Number(clickGapMs) : 500;
  const gapMin = Number(process.env.BOSS_SCROLL_STEP_GAP_MIN_MS || 0) || pace;
  const gapMax = Number(process.env.BOSS_SCROLL_STEP_GAP_MAX_MS || 0) || Math.max(gapMin, Math.round(pace * 1.6));
  return {
    low: Number(process.env.BOSS_CARD_BUFFER_LOW || 3),
    high: Number(process.env.BOSS_CARD_BUFFER_HIGH || 8),
    maxTotalCards: MAX_DOM_CARDS,
    maxLoadSteps: Number(process.env.BOSS_LOAD_MAX_STEPS || 60),
    stagnantLimit: Number(process.env.BOSS_STAGNANT_LIMIT || 8),
    stepMinRatio: Number(process.env.BOSS_SCROLL_STEP_MIN_RATIO || 0.55),
    stepMaxRatio: Number(process.env.BOSS_SCROLL_STEP_MAX_RATIO || 0.95),
    stepGapMinMs: gapMin,
    stepGapMaxMs: gapMax,
    bottomSettleMs: Number(process.env.BOSS_BOTTOM_SETTLE_MS || 0) || Math.max(1200, pace),
    initialTimeoutMs: Number(process.env.BOSS_INITIAL_CARDS_TIMEOUT_MS || 20000),
  };
}

// 每张卡片之间随机休息，降低风控压力。
// 用户要求（2026-10-08）：原 1~3 秒偏快，加长到 3~6 秒；可用 BOSS_CARD_GAP_MIN_MS / BOSS_CARD_GAP_MAX_MS 覆盖。
const CARD_GAP_MIN_MS = Number(process.env.BOSS_CARD_GAP_MIN_MS || 3000);
const CARD_GAP_MAX_MS = Number(process.env.BOSS_CARD_GAP_MAX_MS || 6000);
// 点击产出止损（2026-10-14 用户确认）：连续这么多次点击都没有带来新公司，就结束本词扫描。
// 过滤率高的词（整页外包/猎头/已入库岗位）否则会一路点到 --max-cards 上限才收手，白跑十几分钟。
// BOSS_NO_YIELD_CLICKS=0 关闭（只靠点击上限兜底）。
const NO_YIELD_CLICKS = (() => {
  const raw = process.env.BOSS_NO_YIELD_CLICKS;
  if (raw === undefined || String(raw).trim() === '') return 40;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 40;
})();
// 扫描前把 BOSS 标签页切到前台（2026-10-14）：后台标签页不会触发 BOSS 的无限滚动，
// 会让每个关键词只看到首屏 15 张、并误判「列表已到底」。BOSS_FORCE_FRONT=0 可关闭。
const FORCE_FRONT = !(process.env.BOSS_FORCE_FRONT === '0'
  || String(process.env.BOSS_FORCE_FRONT).toLowerCase() === 'false');
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

// 载入/补货的判定都在 boss-card-loader.mjs；这里只把它接到当前 CDP 通道上。

async function extractJobs({ targetCompanies, maxCards, clickGapMs, scanCity = '' }) {
  const jobs = [];
  const seenJobs = new Set();
  const seenCompanies = new Set();
  let skippedKnown = 0;
  // 每张被点击卡片最终去向的计数（2026-10-11：extracted=0 时不再抓瞎）
  const dropReasons = { skipWord: 0, incompleteJd: 0, dupOrNoCompany: 0, peekFailed: 0, emptyDetail: 0 };

  // 跳词规则（控制台可配，2026-10-14 统一到 DB boss_config）：
  // 优先级 BOSS_SKIP_WORDS 环境变量 > DB 配置 > 内置默认；命中即丢弃，连详情都不读。
  const { words: skipWords, source: skipSource, error: skipError } = await resolveExtractSkipWords({
    envValue: process.env.BOSS_SKIP_WORDS,
    loadControl: loadBossControl,
  });
  if (skipError) console.error(`[跳词] 读取 DB 配置失败，改用内置默认：${skipError}`);
  const skipRe = buildWordRegex(skipWords) || NEVER_MATCH;
  const skipPreview = skipWords.join(' | ');
  console.error(`[跳词] 生效 ${skipWords.length} 条（${skipSource}）：${skipPreview.length > 140 ? `${skipPreview.slice(0, 140)}…` : skipPreview || '（空=不跳词）'}`);

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

  // 载入策略（2026-10-14 用户要求）：不预载整页卡片。先等首屏渲染出来即开始逐张采集，
  // 之后「待处理卡片不够了再往下滚一小段补一批」，和真人边看边加载一致。
  const loader = createCardLoader({
    execJs,
    execJson,
    assertNotBlocked,
    log: (msg) => console.error(msg),
    config: cardLoaderConfig(clickGapMs),
  });

  // 后台标签页不会触发 BOSS 的无限滚动（2026-10-14 实测：页面 hidden 时滚到底也只有首屏 15 张），
  // 先确保标签页可见，否则后面的「列表已到底」全是假的。
  if (FORCE_FRONT) {
    await ensureTabVisible({ execJson, bringToFront, log: (m) => console.error(m) });
  }

  const first = await loader.waitForFirstCards();
  if (!first.total) {
    console.error('[载入] 首屏没有出现任何岗位卡片，结束本次扫描');
    return { jobs, scannedCards: 0, skippedKnown, dropReasons };
  }
  if (first.hidden) {
    console.error('[载入] ⚠ BOSS 标签页在后台：无限滚动不会追加卡片，本次可能只有首屏这些卡片');
  }
  console.error(`[载入] 首屏 ${first.total} 张卡片（待处理 ${first.pending}），之后按需增量加载`);

  let scanned = 0;
  let consecutivePeekFailures = 0;
  // 点击产出止损（2026-10-14 用户确认）：连续 N 次点击都没带来新公司就结束本词扫描
  const yieldStreak = createYieldStreak(NO_YIELD_CLICKS);
  // 「连续 N 张都是已入库岗位」止损（2026-10-15 用户提出）：整页都是上次扫过的岗位时，
  // 点击上限与产出止损都不会触发，只靠它和 DOM 上限收手。
  const knownStreak = createKnownCardStreak(KNOWN_STREAK_LIMIT);
  // 单关键词卡片预算（2026-10-15 用户实测修正）：按「处理过的卡片数」封顶，不按 DOM 卡片数。
  // 点击卡片会 scrollIntoView → 触发 BOSS 自己追加卡片，DOM 会超出任何"加载上限"；
  // 只有按处理量计数，才能保证"每个关键词最多 135 张"真的成立。
  const cardBudget = createCardBudget(MAX_DOM_CARDS);
  // 是否已撞到 DOM 加载上限（撞上后只是不再加载新卡片，手里的照常处理完）
  let domCapped = false;
  let stopReason = '';
  // 先窥视（不点击）→ 与库内已有岗位比对 → 新岗位才点击展开抽取。
  while (scanned < maxCards && seenCompanies.size < targetCompanies) {
    if (yieldStreak.exhausted) {
      stopReason = `连续 ${yieldStreak.limit} 次点击都没有带来新公司（本词产出已枯竭）`;
      break;
    }
    // 卡片预算用满即收工（在窥视之前判，保证处理量正好是 limit 张）
    if (cardBudget.exhausted) {
      stopReason = `达到单关键词卡片上限 ${cardBudget.limit} 张（已处理 ${cardBudget.used} 张卡片）`;
      break;
    }
    let state = await loader.cardState();

    // 手里的卡片不多了（或已用完）→ 才往下滚加载新卡片；确认到底后 loader 不再滚动。
    if (state.pending <= loader.config.low) {
      const filled = await loader.fillCardBuffer(
        state.pending === 0 ? '当前卡片已处理完' : `待处理不足 ${loader.config.low} 张`,
      );
      state = filled.state;
      if (filled.capped) domCapped = true;
    }
    if (state.pending === 0) {
      stopReason = domCapped
        ? `达到单关键词卡片上限 ${MAX_DOM_CARDS} 张（DOM 累计加载），本词剩余列表未扫描`
        : '列表已到底，没有可继续处理的卡片';
      break;
    }
    const pos = state.pos;

    // 窥视：只读卡片文本/公司/岗位名，不点击
    const cardMeta = await execJson(peekScript(pos), { ok: false, reason: 'peek_failed' });
    if (!cardMeta?.ok) {
      dropReasons.peekFailed += 1;
      // 卡片在窥视前被重渲染/移除时不能原地打转：连续失败到阈值就收工
      consecutivePeekFailures += 1;
      if (consecutivePeekFailures >= loader.config.stagnantLimit) {
        stopReason = `连续 ${consecutivePeekFailures} 次窥视失败（列表可能已重渲染）`;
        break;
      }
      await sleep(300);
      continue;
    }
    consecutivePeekFailures = 0;
    cardBudget.spend(); // 窥视成功 = 这张卡片已被处理（无论随后跳过还是点击）
    // 新增环节（用户要求 2026-10-08）：点击前与库内已有岗位比对，已入库则跳过
    const preKey = uniqueCandidateKey({
      company: cardMeta.card_company,
      title: cardMeta.card_title,
      city: cardMeta.card_city || scanCity,
    });
    if (existingJobKeys && preKey && existingJobKeys.has(preKey)) {
      skippedKnown += 1;
      knownStreak.recordKnown();
      if (knownStreak.exhausted) {
        stopReason = `连续 ${knownStreak.limit} 张卡片都是已入库岗位（本词剩余列表对本次扫描无产出）`;
        break;
      }
      continue;
    }
    knownStreak.recordOther(); // 出现非「已入库」卡片：连续计数清零
    // 新岗位：点击展开详情面板
    await execJs(clickScript(pos));
    scanned += 1;
    yieldStreak.recordClick(); // 先按「这次点击没产出新公司」记；下面真的入库时再清零
    // 卡片间随机 3~6 秒（用户要求 2026-10-08 加长），同时给右侧详情面板留渲染时间
    await sleep(CARD_GAP_MIN_MS + Math.floor(Math.random() * (CARD_GAP_MAX_MS - CARD_GAP_MIN_MS)));
    const cardText = decodeBossText(`${cardMeta.card_text || ''}\n${cardMeta.card_alt || ''}`);
    if (skipRe.test(cardText)) { dropReasons.skipWord += 1; continue; }

    const raw = await execJson(detailScript(cardMeta, scanCity), {});
    const job = normalizeJob(raw);
    if (!String(job.desc || '').trim()) { dropReasons.emptyDetail += 1; }
    const fullText = `${job.company}\n${job.title}\n${job.desc}`;
    if (skipRe.test(fullText)) { dropReasons.skipWord += 1; continue; }
    if (REQUIRE_FULL_JD && !hasCompleteJd(job)) { dropReasons.incompleteJd += 1; continue; }

    const jobKey = uniqueCandidateKey(job);
    const companyKey = uniqueCompanyKey(job);
    if (!companyKey || seenJobs.has(jobKey) || seenCompanies.has(companyKey)) { dropReasons.dupOrNoCompany += 1; continue; }
    seenJobs.add(jobKey);
    seenCompanies.add(companyKey);
    yieldStreak.recordCompany(); // 拿到新公司：连续零产出计数清零
    jobs.push(job);
  }

  // 收尾：把「为什么停」写清楚，省得再从数字反推（用户 2026-10-14 提问）
  if (!stopReason) {
    if (seenCompanies.size >= targetCompanies) stopReason = `已凑够 ${targetCompanies} 家不同公司`;
    else if (scanned >= maxCards) stopReason = `达到点击上限 ${maxCards} 张`;
    else if (cardBudget.exhausted) stopReason = `达到单关键词卡片上限 ${cardBudget.limit} 张（已处理 ${cardBudget.used} 张卡片）`;
    else if (domCapped) stopReason = `达到单关键词卡片上限 ${MAX_DOM_CARDS} 张；不再加载新卡片`;
    else stopReason = '没有可继续处理的卡片';
  }
  let domTotal = null;
  try { domTotal = (await loader.cardState()).total; } catch { /* 读不到就不带这个数 */ }
  console.error(
    `[结束] ${stopReason}；处理 ${cardBudget.used} 张卡片（上限 ${cardBudget.limit || '不限'}），`
    + `点击 ${scanned} 张（上限 ${maxCards}），入库 ${jobs.length} 条 / ${seenCompanies.size} 家公司`
    + `${skippedKnown ? `，跳过已入库 ${skippedKnown} 张` : ''}`
    + `${domTotal === null ? '' : `，DOM 累计加载 ${domTotal} 张`}`,
  );

  return { jobs, scannedCards: scanned, skippedKnown, dropReasons, stopReason, domCapped, processedCards: cardBudget.used, cardBudget: cardBudget.limit };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-chrome-extract.mjs --city 上海 --company-limit 27 [--append]');
    console.log('  卡片按需加载：待处理卡片 ≤ BOSS_CARD_BUFFER_LOW（默认 3）时才向下滚一小段补货，');
    console.log('  补到 ≥ BOSS_CARD_BUFFER_HIGH（默认 8）或确认列表到底即停；不再开局预载整页卡片。');
    console.log('  产出止损：连续 BOSS_NO_YIELD_CLICKS（默认 40）次点击没带来新公司就结束本词扫描。');
    console.log('  卡片上限：单关键词最多处理 BOSS_MAX_DOM_CARDS（默认 135）张卡片就收工——');
    console.log('            按「处理过的卡片数」计（含被跳过/被点击的），因为点击会滚动页面、');
    console.log('            BOSS 自己还会追加卡片，DOM 总数封不住。');
    console.log('  重复止损：连续 BOSS_KNOWN_STREAK_LIMIT（默认 60）张卡片都是已入库岗位就结束本词扫描。');
    console.log('  （两者都设 0 可关闭；后者针对「整页都是上次扫过的岗位」时不占点击额度的白跑。）');
    return;
  }

  const companyLimit = Number(args['company-limit'] || args.limit || 27);
  const maxCards = Number(args['max-cards'] || Math.max(companyLimit * 5, 80));
  const clickGapMs = Number(args['click-gap-ms'] || 1400);
  const scanCity = String(args.city || '').trim();
  const output = args.output || CANDIDATES_PATH;
  const { jobs, scannedCards, skippedKnown, dropReasons, stopReason, domCapped, processedCards, cardBudget } = await extractJobs({
    targetCompanies: companyLimit,
    maxCards,
    clickGapMs,
    scanCity,
  });
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

  console.error(`[去向统计] 点击 ${scannedCards} 张：入库 ${jobs.length}，跳词 ${dropReasons.skipWord}，JD不完整 ${dropReasons.incompleteJd}（其中详情空白 ${dropReasons.emptyDetail}），本轮重复 ${dropReasons.dupOrNoCompany}，peek失败 ${dropReasons.peekFailed}`);
  console.log(JSON.stringify({
    extracted: jobs.length,
    scannedCards,
    stopReason,
    skippedKnown: skippedKnown || 0,
    processedCards: processedCards || 0,
    cardBudgetCards: cardBudget || null,
    domCapReached: Boolean(domCapped),
    domCapCards: MAX_DOM_CARDS || null,
    dropReasons,
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
