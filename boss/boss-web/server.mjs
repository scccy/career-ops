// boss-web/server.mjs — BOSS 直聘流程操作控制台：实时概览 + 候选池检索 + 白名单命令执行
// 复用项目 node_modules 的 mysql2 / js-yaml；连接参数与 boss-common.mjs 保持一致（MYSQL_* 可覆盖）。
// 用法：node boss/boss-web/server.mjs  →  浏览器打开 http://127.0.0.1:4173

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter as PATH_DELIMITER } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import * as yaml from 'js-yaml';
import { loadBossControl, saveBossControl } from '../boss-config-db.mjs';
import { splitWordList, validateWordRegex } from '../skip-rules.mjs';
import { ensureCandidatesSchemaReady, urlPathname as sharedUrlPathname } from '../boss-common.mjs';
import { readSendHistory as readSharedSendHistory, selectSendableJobs } from '../boss-send-eligibility.mjs';

const IS_WIN = process.platform === 'win32';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BOSS_DASHBOARD_PORT || 4173);
const ROOT = join(__dirname, '..', '..');
const PROFILE = join(ROOT, 'config', 'profile.yml');
const HTML_PATH = join(__dirname, 'index.html');
const LAST_SCAN_FILE = join(ROOT, 'data', 'last-scan.txt');

// 读取「最近一次扫描」的起始时间戳（由扫描任务启动时写入），用于「发送新扫描的」范围界定。
function getLastScanAt() {
  try { const t = readFileSync(LAST_SCAN_FILE, 'utf-8').trim(); return t || null; } catch { return null; }
}

// ---- 读取 boss 配置（阈值 / 每城配额 / 关键词），统一来自数据库 boss_config 表 ----
async function loadBossConfig() {
  const c = (await loadBossControl().catch(() => null)) || {};
  const fallback = {
    threshold: 3.0,
    dailyLimitPerCity: { 上海: 20, 杭州: 40, 南京: 20, 无锡: 20, 常州: 20 },
  };
  return {
    threshold: Number(c.send_threshold) > 0 ? Number(c.send_threshold) : fallback.threshold,
    dailyLimitPerCity:
      c.daily_limit_per_city && typeof c.daily_limit_per_city === 'object'
        ? c.daily_limit_per_city
        : fallback.dailyLimitPerCity,
    greetingStyle: '',
    dailyExtractQueries: Array.isArray(c.daily_extract_queries) ? c.daily_extract_queries : [],
    dailyExtractKeywordsByCity:
      c.daily_extract_keywords_by_city && typeof c.daily_extract_keywords_by_city === 'object'
        ? c.daily_extract_keywords_by_city
        : {},
    platformDailyLimit:
      Number(c.platform_daily_limit) > 0 ? Number(c.platform_daily_limit) : 0,
    // 扫描节奏（DB boss_config，控制台可调；任务启动时注入子进程环境变量）
    keywordGapSeconds: Number.isFinite(Number(c.keyword_gap_seconds)) ? Number(c.keyword_gap_seconds) : 300,
    cityGapSeconds: Number.isFinite(Number(c.city_gap_seconds)) ? Number(c.city_gap_seconds) : 600,
    cardGapMinMs: Number.isFinite(Number(c.card_gap_min_ms)) ? Number(c.card_gap_min_ms) : 3000,
    cardGapMaxMs: Number.isFinite(Number(c.card_gap_max_ms)) ? Number(c.card_gap_max_ms) : 6000,
    scanBudgetFactor:
      Number.isFinite(Number(c.scan_budget_factor)) && Number(c.scan_budget_factor) > 0
        ? Number(c.scan_budget_factor)
        : 1.3,
    // 单关键词扫描预算（2026-10-15）：卡片上限 / 连续重复止损，0 = 关闭（合法值，不做 >0 过滤）
    maxDomCards: Number.isFinite(Number(c.max_dom_cards)) ? Number(c.max_dom_cards) : 135,
    knownStreakLimit: Number.isFinite(Number(c.known_streak_limit)) ? Number(c.known_streak_limit) : 60,
    // JD 完整性门禁（true=抽取时丢弃 <180 字/无结构词的岗位；false=不过滤，照常入库评分）
    requireFullJd: c.require_full_jd === false ? false : true,
    // 跳词 / 排除规则（DB boss_config，控制台可编辑；默认表见 boss/skip-rules.mjs）
    skipWords: Array.isArray(c.skip_words) ? c.skip_words : [],
    riskKeywords: Array.isArray(c.risk_keywords) ? c.risk_keywords : [],
    titleExclude: Array.isArray(c.title_exclude) ? c.title_exclude : [],
    companyExclude: Array.isArray(c.company_exclude) ? c.company_exclude : [],
  };
}

// ---- 写回 boss 配置到数据库（阈值 / 每城配额 / 关键词）----
// 前端每次提交完整的 daily_limit_per_city 映射，与 DB 现有值合并后整体覆盖，天然支持「移除城市」。
async function saveBossConfig(body = {}) {
  const {
    send_threshold, daily_limit_per_city, daily_extract_queries, daily_extract_keywords_by_city,
    platform_daily_limit,
    keyword_gap_seconds, city_gap_seconds, card_gap_min_ms, card_gap_max_ms, scan_budget_factor,
    require_full_jd,
  } = body;
  const partial = {};
  if (send_threshold != null) {
    const n = Number(send_threshold);
    if (!Number.isFinite(n) || n <= 0) throw new Error('评分阈值非法：必须为正数');
    partial.send_threshold = n;
  }
  if (platform_daily_limit != null) {
    const n = Number(platform_daily_limit);
    if (!Number.isFinite(n) || n <= 0) throw new Error('平台每日上限非法：必须为正数');
    partial.platform_daily_limit = n;
  }
  if (daily_limit_per_city && typeof daily_limit_per_city === 'object') partial.daily_limit_per_city = daily_limit_per_city;
  if (Array.isArray(daily_extract_queries)) partial.daily_extract_queries = daily_extract_queries;
  if (daily_extract_keywords_by_city && typeof daily_extract_keywords_by_city === 'object') {
    partial.daily_extract_keywords_by_city = daily_extract_keywords_by_city;
  }
  // 扫描节奏字段（秒/毫秒/系数）：数字校验交给 boss-config-db 的 normalize 兜底，
  // 这里只把显式传入的键透传，未传的键保持 DB 现值不变。
  for (const k of ['keyword_gap_seconds', 'city_gap_seconds', 'card_gap_min_ms', 'card_gap_max_ms', 'scan_budget_factor', 'max_dom_cards', 'known_streak_limit']) {
    if (body[k] != null) {
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < 0) throw new Error('节奏参数非法：必须为 ≥ 0 的数字');
      partial[k] = n;
    }
  }
  // JD 完整性门禁开关：布尔透传，未传保持现值
  if (require_full_jd != null) partial.require_full_jd = Boolean(require_full_jd);
  // 跳词 / 排除规则：接受数组或分隔符字符串；正则类字段在保存时就校验，
  // 非法正则直接报错，而不是等到扫描时静默回落默认词表（2026-10-14）
  for (const key of ['skip_words', 'risk_keywords', 'title_exclude', 'company_exclude']) {
    if (body[key] == null) continue;
    const words = splitWordList(body[key]);
    if (words === null) throw new Error(`${key} 非法：需要数组或「逗号/换行分隔」的字符串`);
    if (key !== 'risk_keywords') {
      const bad = validateWordRegex(words);
      if (bad) throw new Error(`${key} 正则非法：${bad}`);
    }
    partial[key] = words;
  }
  if (partial.card_gap_min_ms != null && partial.card_gap_max_ms != null
      && partial.card_gap_max_ms < partial.card_gap_min_ms) {
    throw new Error('卡片间隔非法：最大值不能小于最小值');
  }
  await saveBossControl(partial);
  return loadBossConfig();
}

const DB = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || 'career_ops',
  connectionLimit: 5,
  connectTimeout: 4000,
};
const pool = mysql.createPool(DB);

async function q(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

let stateSchemaReady = false;
async function ensureJobStateSchema() {
  if (stateSchemaReady) return;
  await ensureCandidatesSchemaReady();
  stateSchemaReady = true;
}

async function getSendabilitySnapshot(cfg) {
  await ensureJobStateSchema();
  const rows = await q(
    `SELECT key_hash, company, title, score, city, url, greeted, contact_state,
            status, availability, manual_excluded, manual_exclusion_reason, scanned_at, raw
       FROM boss_jobs ORDER BY score IS NULL, score DESC, key_hash ASC`,
  );
  const urlCity = new Map(rows.filter((r) => r.url).map((r) => [sharedUrlPathname(r.url), String(r.city || '').split('·')[0]]));
  const history = readSharedSendHistory(urlCity);
  const candidates = rows.map((r) => ({
    ...(typeof r.raw === 'string' ? JSON.parse(r.raw) : (r.raw || {})),
    key_hash: r.key_hash, company: r.company, title: r.title,
    score: r.score == null ? null : Number(r.score), city: r.city, url: r.url,
    greeted: Boolean(r.greeted), contactState: r.contact_state,
    status: r.status, availability: r.availability,
    manualExcluded: Boolean(r.manual_excluded), manualExclusionReason: r.manual_exclusion_reason || '',
    scanned_at: r.scanned_at,
  }));
  const selection = selectSendableJobs(candidates, {
    threshold: cfg.threshold,
    cityLimits: cfg.dailyLimitPerCity,
    platformLimit: cfg.platformDailyLimit,
    history,
  });
  return { rows: candidates, urlCity, history, selection };
}

async function getOverview() {
  const cfg = await loadBossConfig();
  await ensureJobStateSchema();
  const thr = cfg.threshold;
  const totalRows = await q('SELECT COUNT(*) AS n FROM boss_jobs');
  const greetedRows = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE greeted=1');
  const scoredRows = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE score IS NOT NULL');
  const pendingRows = await q(`SELECT COUNT(*) AS n FROM boss_jobs
    WHERE greeted=0 AND score>=?
      AND (availability <> 'closed' AND (status IS NULL OR status <> 'closed'))`, [thr]);
  const total = Number(totalRows[0].n);
  const greeted = Number(greetedRows[0].n);
  const scored = Number(scoredRows[0].n);
  const pending = Number(pendingRows[0].n);

  const citiesAll = await q(
    `SELECT city,
            COUNT(*) AS total,
            SUM(greeted=1) AS greeted,
            SUM(greeted=0 AND score>=? AND availability <> 'closed' AND (status IS NULL OR status <> 'closed')) AS pending
     FROM boss_jobs GROUP BY city`,
    [thr],
  );
  // 城市下拉只显示控制台配置中的城市（被删除城市的遗留岗位不在下拉出现）
  const configuredSet = new Set(Object.keys(cfg.dailyLimitPerCity));
  const cities = citiesAll.filter((r) => configuredSet.has(String(r.city).split('·')[0]));

  const snapshot = await getSendabilitySnapshot(cfg);
  const sendableByCity = {};
  for (const city of Object.keys(cfg.dailyLimitPerCity)) {
    const cityRows = snapshot.rows.filter((job) => String(job.city || '').split('·')[0] === city);
    sendableByCity[city] = selectSendableJobs(cityRows, {
      threshold: cfg.threshold,
      cityLimits: cfg.dailyLimitPerCity,
      platformLimit: cfg.platformDailyLimit,
      history: snapshot.history,
    }).jobs.length;
  }
  const byCity = snapshot.history.todayByCity;
  const todayInfo = { todaySent: snapshot.history.todaySent };

  const quotaData = Object.entries(cfg.dailyLimitPerCity).map(([city, quota]) => {
    const row = cities.find((c) => String(c.city).split('·')[0] === city) || { total: 0, greeted: 0, pending: 0 };
    const sentToday = byCity[city] || 0;
    // keywordsCustom = 该城显式覆盖的词表（空=未覆盖，跟随统一词表）；keywords = 实际生效词表
    const keywordsCustom = Array.isArray(cfg.dailyExtractKeywordsByCity[city]) ? cfg.dailyExtractKeywordsByCity[city] : [];
    const perCityKw = keywordsCustom.length ? keywordsCustom : cfg.dailyExtractQueries;
    return {
      city,
      quota,
      sentToday,
      remaining: Math.max(0, quota - sentToday),
      poolTotal: Number(row.total || 0),
      poolPending: Number(row.pending || 0),
      sendable: Number(sendableByCity[city] || 0),
      keywordsCustom,
      keywords: perCityKw,
    };
  });

  const unknownCitySent = (byCity['未知'] || 0);
  const cityRows = await q('SELECT city, COUNT(*) AS n FROM boss_jobs GROUP BY city ORDER BY n DESC');
  const salRows = await q('SELECT MIN(salary_min) AS lo, MAX(salary_max) AS hi FROM boss_jobs');

  // BOSS 平台级每日上限：可选开关（0=不启用，用户自行用城市配额管理/会员解除）
  const platformLimit = cfg.platformDailyLimit || 0;
  const platformSentToday = snapshot.history.todaySent;
  const platform = {
    enabled: platformLimit > 0,
    limit: platformLimit,
    sentToday: platformSentToday,
    remaining: platformLimit > 0 ? Math.max(0, platformLimit - platformSentToday) : null,
  };

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    threshold: thr,
    greetingStyle: cfg.greetingStyle,
    dailyExtractQueries: cfg.dailyExtractQueries,
    pacing: {
      keywordGapSeconds: cfg.keywordGapSeconds,
      cityGapSeconds: cfg.cityGapSeconds,
      cardGapMinMs: cfg.cardGapMinMs,
      cardGapMaxMs: cfg.cardGapMaxMs,
      scanBudgetFactor: cfg.scanBudgetFactor,
      requireFullJd: cfg.requireFullJd,
      maxDomCards: cfg.maxDomCards,
      knownStreakLimit: cfg.knownStreakLimit,
    },
    rules: {
      skipWords: cfg.skipWords,
      riskKeywords: cfg.riskKeywords,
      titleExclude: cfg.titleExclude,
      companyExclude: cfg.companyExclude,
    },
    total: total,
    greeted: greeted,
    notGreeted: total - greeted,
    scored: scored,
    unscored: total - scored,
    pending: pending,
    sendable: snapshot.selection.jobs.length,
    todaySent: todayInfo.todaySent,
    unknownCitySent,
    platform,
    lastScanAt: getLastScanAt(),
    quota: quotaData,
    cities: cityRows.map((r) => ({ city: String(r.city || '未知'), n: Number(r.n) })),
    salaryBounds: {
      lo: salRows[0].lo == null ? null : Number(salRows[0].lo),
      hi: salRows[0].hi == null ? null : Number(salRows[0].hi),
    },
  };
}

// ---- 候选池分页查询（城市 / 薪资 / 状态 / 分数 / 关键词 过滤） ----
// 统一的过滤条件构造，供 getJobs 与批量操作(/api/jobs/bulk) 复用。
function buildJobFilter(f, { threshold } = {}) {
  const where = [];
  const args = [];
  // 已关闭岗位（发送时发现 JOB_CLOSED 并标记）默认从检索中排除——它们是死岗位
  if (!f.includeClosed && f.availability !== 'closed') { where.push("availability<>'closed' AND (status IS NULL OR status <> 'closed')"); }
  if (f.availability === 'closed') where.push("(availability='closed' OR status='closed')");
  else if (f.availability === 'open') where.push("availability<>'closed' AND (status IS NULL OR status<>'closed')");
  if (f.manualExclusion === 'excluded') where.push('manual_excluded=1');
  else if (f.manualExclusion !== 'all') where.push('manual_excluded=0');
  if (f.contactState === 'contacted') where.push("contact_state IN ('custom_sent','auto_greeted_unverified','manual_contact_confirmed','legacy_contact_unknown')");
  else if (f.contactState === 'never_contacted') where.push("contact_state='never_contacted' AND greeted=0");
  else if (f.contactState) { where.push('contact_state=?'); args.push(f.contactState); }
  // `pending` is retained for old links; it means raw qualified candidates, not sendability.
  if (f.greeted === 'pending') {
    where.push('greeted = 0');
    if (Number(threshold) > 0) { where.push('score >= ?'); args.push(Number(threshold)); }
  } else if (f.greeted === 'unscored') {
    where.push('score IS NULL');
  } else if (f.greeted === '0' || f.greeted === '1') { where.push('greeted = ?'); args.push(Number(f.greeted)); }
  if (f.city) { where.push('city = ?'); args.push(f.city); }
  // 岗位类型快捷筛选：与批量剔除按钮同一套词表（title/raw 匹配）
  // clean = 排除校招/应届/实习/校园/毕业生（社招正向池）
  const typePatterns = {
    intern: ['实习'],
    campus: ['校招', '应届', '校园', '毕业生'],
  };
  if (f.jobType === 'clean') {
    const kws = ['实习', '校招', '应届', '校园', '毕业生'];
    const likes = kws.map(() => '(title LIKE ? OR raw LIKE ?)').join(' OR ');
    kws.forEach((kw) => args.push(`%${kw}%`, `%${kw}%`));
    where.push('NOT (' + likes + ')');
  } else if (typePatterns[f.jobType]) {
    const likes = typePatterns[f.jobType].map(() => '(title LIKE ? OR raw LIKE ?)').join(' OR ');
    typePatterns[f.jobType].forEach((kw) => args.push(`%${kw}%`, `%${kw}%`));
    where.push('(' + likes + ')');
  }
  // 薪资区间按"重叠"匹配：岗位最高薪 ≥ 下限 且 最低薪 ≤ 上限
  if (f.salaryMin !== '' && f.salaryMin != null && Number.isFinite(Number(f.salaryMin))) {
    where.push('salary_max >= ?'); args.push(Number(f.salaryMin));
  }
  if (f.salaryMax !== '' && f.salaryMax != null && Number.isFinite(Number(f.salaryMax))) {
    where.push('salary_min <= ?'); args.push(Number(f.salaryMax));
  }
  if (f.scored === '1') where.push('score IS NOT NULL');
  if (f.scored === '0') where.push('score IS NULL');
  if (f.minScore !== '' && f.minScore != null && Number.isFinite(Number(f.minScore))) {
    where.push('score >= ?'); args.push(Number(f.minScore));
  }
  if (f.keyword) {
    const terms = String(f.keyword).split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (terms.length) {
      const ors = terms.map(() => '(title LIKE ? OR raw LIKE ?)');
      where.push('(' + ors.join(' OR ') + ')');
      terms.forEach((t) => { args.push('%' + t + '%', '%' + t + '%'); });
    }
  }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

async function getJobs(sp) {
  const cfg = await loadBossConfig();
  await ensureJobStateSchema();
  const page = Math.max(1, Number(sp.get('page') || 1));
  const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') || 20)));
  const f = {
    city: String(sp.get('city') || '').trim(),
    salaryMin: sp.get('salaryMin'),
    salaryMax: sp.get('salaryMax'),
    greeted: String(sp.get('greeted') || ''),
    contactState: String(sp.get('contactState') || ''),
    availability: String(sp.get('availability') || ''),
    manualExclusion: String(sp.get('manualExclusion') || 'active'),
    eligibility: String(sp.get('eligibility') || ''),
    scored: String(sp.get('scored') || ''),
    minScore: sp.get('minScore'),
    keyword: String(sp.get('keyword') || '').trim(),
    jobType: String(sp.get('jobType') || ''),
  };
  const sort = String(sp.get('sort') || 'score_desc');

  const { whereSql: baseWhere, args } = buildJobFilter(f, { threshold: cfg.threshold });
  const snapshot = await getSendabilitySnapshot(cfg);
  const scopedSelection = f.city
    ? selectSendableJobs(snapshot.rows.filter((job) => String(job.city || '').split('·')[0] === f.city), {
      threshold: cfg.threshold,
      cityLimits: cfg.dailyLimitPerCity,
      platformLimit: cfg.platformDailyLimit,
      history: snapshot.history,
    })
    : snapshot.selection;
  let whereSql = baseWhere;
  if (f.eligibility === 'sendable') {
    const keys = [...scopedSelection.selectedKeys];
    if (!keys.length) whereSql += (whereSql ? ' AND ' : 'WHERE ') + '1=0';
    else {
      whereSql += (whereSql ? ' AND ' : 'WHERE ') + `key_hash IN (${keys.map(() => '?').join(',')})`;
      args.push(...keys);
    }
  }
  const countRows = await q(`SELECT COUNT(*) AS n FROM boss_jobs ${whereSql}`, args);
  const total = Number(countRows[0].n);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const orderMap = {
    score_desc: 'score IS NULL, score DESC, salary_max DESC',
    salary_desc: 'salary_max IS NULL, salary_max DESC, score DESC',
    recent: 'scanned_at IS NULL, scanned_at DESC',
    company: 'company ASC',
  };
  const rows = await q(
    `SELECT key_hash, company, title, salary, salary_min, salary_max, city, url, greeted, contact_state, score, status, availability, manual_excluded, manual_exclusion_reason, scanned_at,
            json_unquote(json_extract(raw,'$.recommendation')) AS recommendation,
            json_unquote(json_extract(raw,'$.score_eligible')) AS score_eligible
     FROM boss_jobs ${whereSql}
     ORDER BY ${orderMap[sort] || orderMap.score_desc}
     LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  );

  return {
    ok: true,
    threshold: cfg.threshold,
    total,
    page: safePage,
    pageSize,
    totalPages,
    rows: rows.map((r) => ({
      key_hash: r.key_hash,
      company: r.company,
      title: r.title,
      salary: r.salary,
      salary_min: r.salary_min == null ? null : Number(r.salary_min),
      salary_max: r.salary_max == null ? null : Number(r.salary_max),
      city: r.city,
      url: r.url,
      greeted: Boolean(r.greeted),
      contactState: r.contact_state,
      availability: r.availability,
      manualExcluded: Boolean(r.manual_excluded),
      manualExclusionReason: r.manual_exclusion_reason || '',
      eligibility: scopedSelection.reasonsByKey[String(r.key_hash)] || 'not_candidate',
      score: r.score == null ? null : Number(r.score),
      // 无分数 = 评分判定「不可发送」后按设计不回写 score。把评分器写下的原因带出来，
      // 列表里就能显示"为什么没有分数"，而不是只看到一个「—」（2026-10-14 用户提问）。
      recommendation: r.recommendation || '',
      scoreEligible: r.score_eligible == null ? null : Number(r.score_eligible),
      status: r.status,
      scanned_at: r.scanned_at,
    })),
  };
}

// ===== 执行引擎（白名单 + 实时日志）=====
// 只跑下表中的命令；send / send_city 为危险档，需前端显式确认后才放行。
const RUN_ALLOWED = {
  doctor:  'npm run doctor',
  scan:    'npm run boss:extract:daily',
  scan_all:'npm run boss:extract:daily:all',
  score:   'npm run boss:score',
  fill:    'npm run boss:fill -- --prepare',
  review:  'npm run boss:review',
  dryrun:  'npm run boss:chrome:apply -- --dry-run',
  send:    'npm run boss:chrome:apply -- --confirmed-review',
  merge:   'node merge-tracker.mjs',
  check_closed: 'node boss/boss-check-closed.mjs',
};
const RUN_TIER = { send: 'confirm' };
const RUN_JOBS = new Map();
let runSeq = 0;
let runningId = null;

function publicJob(j) {
  return {
    id: j.id, key: j.key, cmd: j.cmd, status: j.status,
    output: j.output, code: j.code,
    startedAt: j.startedAt, endedAt: j.endedAt,
    elapsed: ((j.endedAt || Date.now()) - j.startedAt) / 1000,
  };
}

// 跨平台启动命令：Windows 用 cmd.exe /d /s /c；Unix 用登录 shell（保证 PATH 与用户终端一致）。
// 不再硬编码 /bin/bash —— 该路径在 Windows 不存在（spawn ENOENT，任务秒挂）。
// extraEnv：按任务注入的环境变量（如扫描节奏），优先级高于服务进程自身环境。
function buildSpawn(cmd, nodeDir, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, PATH: `${nodeDir}${PATH_DELIMITER}${process.env.PATH || ''}` };
  if (IS_WIN) {
    // cmd.exe 需要 /d /s /c；命令串里的 && 由 cmd 解析。
    // 先切 UTF-8 代码页：Windows 控制台默认 OEM(936/GBK)，会让子进程的 UTF-8 输出（✓/中文）变成乱码。
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `chcp 65001>nul && ${cmd}`], env };
  }
  return { file: '/bin/sh', args: ['-lc', cmd], env };
}

// 整组终止：Unix 用负 pid 杀进程组；Windows 无进程组信号，改用 taskkill /T /F 杀进程树。
function killTree(pid, signal) {
  if (!pid) return;
  if (IS_WIN) {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    return;
  }
  try { process.kill(-pid, signal); } catch { /* ignore */ }
}

// 扫描节奏 → 子进程环境变量（driver 与 extractor 都从 env 读取，console 配置优先于脚本默认值）
async function pacingEnv() {
  const cfg = await loadBossConfig();
  return {
    BOSS_KEYWORD_GAP_SECONDS: String(cfg.keywordGapSeconds),
    BOSS_CITY_GAP_SECONDS: String(cfg.cityGapSeconds),
    BOSS_CARD_GAP_MIN_MS: String(cfg.cardGapMinMs),
    BOSS_CARD_GAP_MAX_MS: String(cfg.cardGapMaxMs),
    BOSS_SCAN_BUDGET_FACTOR: String(cfg.scanBudgetFactor),
    BOSS_REQUIRE_FULL_JD: cfg.requireFullJd ? 'true' : 'false',
    // 单关键词扫描预算（2026-10-15）：0 = 关闭，抽取器按 0 处理为不限
    BOSS_MAX_DOM_CARDS: String(cfg.maxDomCards),
    BOSS_KNOWN_STREAK_LIMIT: String(cfg.knownStreakLimit),
  };
}

function startRun(key, extraEnv = {}) {
  const cmd = RUN_ALLOWED[key];
  const job = { id: ++runSeq, key, cmd, status: 'running', output: '', code: null, startedAt: Date.now(), endedAt: null, proc: null };
  RUN_JOBS.set(job.id, job);
  runningId = job.id;
  // 用登录 shell 启动，保证 PATH 与用户终端一致（否则 node 可能落到别的版本）。
  // 同时把服务自身的 node 目录前置到 PATH 兜底。
  // detached: 独立进程组 —— Unix 下终止时才能整组杀掉（否则只杀外壳，extract/node/npm 子进程照跑）。
  const nodeDir = dirname(process.execPath);
  const { file, args, env } = buildSpawn(cmd, nodeDir, extraEnv);
  const proc = spawn(file, args, {
    cwd: ROOT,
    env,
    detached: !IS_WIN, // Windows 无 POSIX 进程组语义，detached 反而妨碍 taskkill /T
    windowsHide: true,
  });
  job.proc = proc;
  const push = (t) => { job.output += t; if (job.output.length > 120000) job.output = job.output.slice(-120000); };
  proc.stdout?.on('data', (d) => push(d.toString()));
  proc.stderr?.on('data', (d) => push(d.toString()));
  // 超时可配置：--all 单城 7 词光关键词间隔就 30 分钟，固定 20 分钟会把任务误杀。
  const timeoutMs = Number(process.env.BOSS_RUN_TIMEOUT_MS || 90 * 60 * 1000);
  const timer = setTimeout(() => {
    killTree(proc.pid, 'SIGKILL');
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }, timeoutMs);
  const finish = (status, code) => {
    clearTimeout(timer);
    job.status = status; job.code = code; job.endedAt = Date.now();
    if (runningId === job.id) runningId = null;
  };
  proc.on('close', (code) => finish(code === 0 ? 'done' : 'failed', code));
  proc.on('error', (e) => { push('\n[spawn error] ' + e.message + '\n'); finish('failed', -1); });
  return job;
}

// 整组终止：先 SIGTERM 进程树，3 秒后仍在则 SIGKILL 兜底。
// 只杀外壳时 extract/node/npm 子进程会变成孤儿继续跑，任务状态永远 running。
function killRunJob(job) {
  if (!job || !job.proc || job.status !== 'running') return false;
  const pid = job.proc.pid;
  killTree(pid, 'SIGTERM');
  try { job.proc.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    if (job.status !== 'running') return;
    killTree(pid, 'SIGKILL');
    try { job.proc.kill('SIGKILL'); } catch { /* ignore */ }
  }, 3000);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/overview') {
      const data = await getOverview();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    }
    if (url.pathname === '/api/jobs') {
      const data = await getJobs(url.searchParams);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
    }

    // ---- 批量状态操作：联系事实、人工暂缓、恢复暂缓、删除 ----
    if (url.pathname === '/api/city/purge' && req.method === 'POST') {
      // 删除城市后清掉其遗留岗位（城市表「删除」按钮配套动作）
      const body = await readBody(req);
      const city = String(body.city || '').trim();
      if (!/^[一-龥A-Za-z0-9·\-]{1,20}$/.test(city)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '城市名非法' }));
      }
      const ret = await q('DELETE FROM boss_jobs WHERE city = ?', [city]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, deleted: Number(ret.affectedRows || 0) }));
    }
    if (url.pathname === '/api/jobs/bulk' && req.method === 'POST') {
      await ensureJobStateSchema();
      const body = await readBody(req);
      const action = String(body.action || '');
      const allowed = new Set(['confirm_contact', 'exclude', 'restore_exclusion', 'delete']);
      if (!allowed.has(action)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '不支持的操作：' + action }));
      }
      let target;
      if (Array.isArray(body.keyHashes) && body.keyHashes.length) {
        const hashes = body.keyHashes.map(String).filter((h) => /^[A-Za-z0-9+/=_\-]{8,512}$/.test(h));
        if (!hashes.length) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: '无有效的 key_hash' }));
        }
        target = { whereSql: 'WHERE key_hash IN (' + hashes.map(() => '?').join(',') + ')', args: hashes };
      } else if (body.filter && typeof body.filter === 'object') {
        const cfgBulk = await loadBossConfig();
        target = buildJobFilter(body.filter, { threshold: cfgBulk.threshold });
        if (body.filter.eligibility === 'sendable') {
          const snapshot = await getSendabilitySnapshot(cfgBulk);
          const city = String(body.filter.city || '').trim();
          const scoped = city
            ? selectSendableJobs(snapshot.rows.filter((job) => String(job.city || '').split('·')[0] === city), {
              threshold: cfgBulk.threshold,
              cityLimits: cfgBulk.dailyLimitPerCity,
              platformLimit: cfgBulk.platformDailyLimit,
              history: snapshot.history,
            })
            : snapshot.selection;
          const keys = [...scoped.selectedKeys];
          if (!keys.length) target.whereSql += `${target.whereSql ? ' AND ' : 'WHERE '}1=0`;
          else {
            target.whereSql += `${target.whereSql ? ' AND ' : 'WHERE '}key_hash IN (${keys.map(() => '?').join(',')})`;
            target.args.push(...keys);
          }
        }
        if (!target.whereSql) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'filter 为空，禁止对全表执行' }));
        }
      } else {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '需提供 keyHashes 或 filter' }));
      }
      try {
        let r;
        if (action === 'confirm_contact') {
          r = await q(`UPDATE boss_jobs SET greeted=1, contact_state='manual_contact_confirmed',
            manual_excluded=0, manual_exclusion_reason='',
            raw=JSON_SET(raw, '$.greeted', CAST('true' AS JSON), '$.contactState', 'manual_contact_confirmed', '$.manualExcluded', CAST('false' AS JSON), '$.manualExclusionReason', '') ` + target.whereSql, target.args);
        } else if (action === 'exclude') {
          r = await q(`UPDATE boss_jobs SET manual_excluded=1, manual_exclusion_reason='user',
            raw=JSON_SET(raw, '$.manualExcluded', CAST('true' AS JSON), '$.manualExclusionReason', 'user') ` + target.whereSql, target.args);
        } else if (action === 'restore_exclusion') {
          r = await q(`UPDATE boss_jobs SET manual_excluded=0, manual_exclusion_reason='',
            raw=JSON_SET(raw, '$.manualExcluded', CAST('false' AS JSON), '$.manualExclusionReason', '') ` + target.whereSql, target.args);
        } else {
          r = await q('DELETE FROM boss_jobs ' + target.whereSql, target.args);
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, action, affected: r.affectedRows }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // ---- 配额写回（可编辑每日城市配额 + 评分阈值）----
    if (url.pathname === '/api/quota' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const cfg = await saveBossConfig(body);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, threshold: cfg.threshold, dailyLimitPerCity: cfg.dailyLimitPerCity }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // ---- 执行引擎 ----
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body.key || '');
      const json = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

      // 动态命令：单城发送。apply 无 --city 参数，必须先写一份只含该城岗位的临时队列
      // （否则其他城市岗位会混入，且配额表外城市不被排除）。
      if (key === 'send_city') {
        const city = String(body.city || '').trim();
        if (!city) return json({ ok: false, error: '缺少城市' }, 400);
        if (!/^[一-龥A-Za-z0-9·\-]{1,20}$/.test(city)) return json({ ok: false, error: `城市名非法：${city}` }, 400);
        const cfg = await loadBossConfig();
        const snapshot = await getSendabilitySnapshot(cfg);
        const cityCandidates = snapshot.rows.filter((job) => String(job.city || '').split('·')[0] === city);
        const citySelection = selectSendableJobs(cityCandidates, {
          threshold: cfg.threshold,
          cityLimits: cfg.dailyLimitPerCity,
          platformLimit: cfg.platformDailyLimit,
          history: snapshot.history,
        });
        const jobs = citySelection.jobs;
        if (!jobs.length) {
          return json({ ok: false, error: `${city} 当前没有进入本轮可发送队列的岗位（评分、联系状态、职位状态、30 天去重或当日配额未通过）` }, 400);
        }
        mkdirSync(join(ROOT, 'data'), { recursive: true });
        const rel = `data/boss-queue-${city}.json`;
        writeFileSync(join(ROOT, rel), JSON.stringify(jobs, null, 2), 'utf-8');
        const cmd = `npm run boss:chrome:apply -- --input ${rel} --threshold ${cfg.threshold} --confirmed-review && node merge-tracker.mjs`;
        if (body.confirm !== true) {
          return json({ ok: false, needConfirm: true, cmd, count: jobs.length,
            message: `已按控制台“本轮可发送”预检生成 ${city} 临时队列，共 ${jobs.length} 条。确认后仍会在发送前检查 BOSS 实时页面状态。` }, 409);
        }
        if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
        RUN_ALLOWED[key] = cmd;
        RUN_TIER[key] = 'confirm';
        return json({ ok: true, job: publicJob(startRun(key)), note: `临时队列已写入 ${rel}` });
      }

      // 动态命令：单城一键准备 = ②扫描该城关键词 → ③评分 → ④排队（除发送外全部自动完成，发送仍是人工检查点）。
      // extract 加 --city 只跑该城，不影响其他城；评分/排队为全局步骤。
      // 关键词量由每城词表控制；若前端传 keywords 子集则只扫选中的词（控制台多选下拉）。
      if (key === 'scan_city') {
        const city = String(body.city || '').trim();
        if (!city) return json({ ok: false, error: '缺少城市' }, 400);
        if (!/^[一-龥A-Za-z0-9·\-]{1,20}$/.test(city)) return json({ ok: false, error: `城市名非法：${city}` }, 400);
        if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
        // 解析可选的关键词子集，并校验为该市生效词表中的元素（防注入 / 防错词）
        let kwArg = '';
        if (Array.isArray(body.keywords) && body.keywords.length) {
          const cfg2 = await loadBossConfig();
          const known = new Set(
            (Array.isArray(cfg2.dailyExtractKeywordsByCity?.[city]) && cfg2.dailyExtractKeywordsByCity[city].length
              ? cfg2.dailyExtractKeywordsByCity[city]
              : (cfg2.dailyExtractQueries || [])),
          );
          const picked = body.keywords
            .map((k) => String(k || '').trim())
            .filter((k) => k.length > 0 && k.length <= 40 && known.has(k));
          if (!picked.length || picked.length !== body.keywords.length) {
            return json({ ok: false, error: `关键词不在 ${city} 的生效词表中（可用：${(cfg2.dailyExtractKeywordsByCity?.[city] || cfg2.dailyExtractQueries || []).join(',') || '（空）'}）` }, 400);
          }
          if (picked.length === known.size) {
            kwArg = ' --all'; // 选了全部 = 等同原「全扫」
          } else {
            kwArg = ` --keywords "${picked.join(',')}"`;
          }
        } else {
          kwArg = ' --all';
        }
        try { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(LAST_SCAN_FILE, new Date().toISOString()); } catch { /* ignore */ }
        const cmd = `npm run boss:extract:daily -- --city "${city}"${kwArg} && npm run boss:score && npm run boss:fill -- --prepare`;
        RUN_ALLOWED[key] = cmd;
        RUN_TIER[key] = 'safe';
        const scope = kwArg === ' --all' ? '全部关键词' : `关键词子集（${body.keywords.length} 个）`;
        return json({ ok: true, job: publicJob(startRun(key, await pacingEnv())), note: `一键准备：扫描 ${city} ${scope} → 评分 → 排队（不影响其他城市，完成后可直接发送/发新扫）` });
      }

      // 动态命令：发新扫——最近一次扫描新增岗位也必须经过同一套发送资格预检。
      if (key === 'send_city_new') {
        const city = String(body.city || '').trim();
        if (!city) return json({ ok: false, error: '缺少城市' }, 400);
        if (!/^[一-龥A-Za-z0-9·\-]{1,20}$/.test(city)) return json({ ok: false, error: `城市名非法：${city}` }, 400);
        const cfg = await loadBossConfig();
        await ensureJobStateSchema();
        const last = getLastScanAt();
        if (!last) return json({ ok: false, error: '尚未执行过扫描，无法确定「新扫描」范围。请先扫描此城。' }, 400);
        const snapshot = await getSendabilitySnapshot(cfg);
        const recentCityCandidates = snapshot.rows.filter((job) =>
          String(job.city || '').split('·')[0] === city
          && job.scanned_at != null
          && new Date(job.scanned_at).getTime() >= new Date(last).getTime(),
        );
        const selection = selectSendableJobs(recentCityCandidates, {
          threshold: cfg.threshold,
          cityLimits: cfg.dailyLimitPerCity,
          platformLimit: cfg.platformDailyLimit,
          history: snapshot.history,
        });
        const jobs = selection.jobs;
        if (!jobs.length) {
          // 新扫描岗位可能尚未评分（score NULL 会被 ≥阈值 过滤），给出可执行的下一步
          let hint = '';
          const [uns] = await q(
            'SELECT COUNT(*) AS n FROM boss_jobs WHERE city=? AND greeted=0 AND score IS NULL AND scanned_at >= ?',
            [city, last],
          );
          if (uns.n > 0) hint = `检测到 ${city} 有 ${uns.n} 条新扫描岗位尚未评分，请先执行主流程③评分（boss:score）再发新扫。`;
          return json({ ok: false, error: `${city} 最近扫描新增岗位中没有通过本轮可发送预检的岗位。${hint}` }, 400);
        }
        mkdirSync(join(ROOT, 'data'), { recursive: true });
        const rel = `data/boss-queue-${city}.json`;
        writeFileSync(join(ROOT, rel), JSON.stringify(jobs, null, 2), 'utf-8');
        const cmd = `npm run boss:chrome:apply -- --input ${rel} --threshold ${cfg.threshold} --confirmed-review && node merge-tracker.mjs`;
        if (body.confirm !== true) {
          return json({ ok: false, needConfirm: true, cmd, count: jobs.length,
            message: `已按本轮发送规则从最近扫描新增岗位中预检出 ${jobs.length} 条。确认后仍会在发送前检查 BOSS 实时页面状态。` }, 409);
        }
        if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
        RUN_ALLOWED[key] = cmd;
        RUN_TIER[key] = 'confirm';
        return json({ ok: true, job: publicJob(startRun(key)), note: `临时队列已写入 ${rel}` });
      }

      if (!RUN_ALLOWED[key]) return json({ ok: false, error: `命令不在白名单：${key}` }, 400);
      if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
      if (RUN_TIER[key] === 'confirm' && body.confirm !== true) {
        return json({ ok: false, needConfirm: true, cmd: RUN_ALLOWED[key],
          message: '此命令会真实向 HR 发送打招呼，不可撤销。确认后才会执行。' }, 409);
      }
      // 扫描类命令注入节奏配置（关键词/城市/卡片间隔、预算系数）；score 也注入——
      // BOSS_REQUIRE_FULL_JD 开关同时控制评分端的 JD 完整性资格闸门，保持两端一致。
      const SCAN_KEYS = new Set(['scan', 'scan_all', 'score']);
      return json({ ok: true, job: publicJob(startRun(key, SCAN_KEYS.has(key) ? await pacingEnv() : {})) });
    }
    if (url.pathname === '/api/run' && req.method === 'GET') {
      const id = Number(new URL(req.url, `http://${req.headers.host}`).searchParams.get('id')) || (runSeq || 1);
      const job = RUN_JOBS.get(id);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, job: job ? publicJob(job) : null, runningId }));
    }
    if (url.pathname === '/api/run/kill' && req.method === 'POST') {
      const body = await readBody(req);
      const job = RUN_JOBS.get(Number(body.id)) || (runningId !== null ? RUN_JOBS.get(runningId) : null);
      const killed = killRunJob(job);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, killed, id: job ? job.id : null }));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(HTML_PATH);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`BOSS 流程操作控制台已启动: http://127.0.0.1:${PORT}`);
  console.log(`MySQL: ${DB.host}:${DB.port}/${DB.database}  user=${DB.user}`);
});
