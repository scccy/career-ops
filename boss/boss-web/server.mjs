// boss-web/server.mjs — BOSS 直聘流程操作控制台：实时概览 + 候选池检索 + 白名单命令执行
// 复用项目 node_modules 的 pg / js-yaml；连接参数与 boss-common.mjs 保持一致（PG* 可覆盖）。
// 用法：node boss/boss-web/server.mjs  →  本机 http://127.0.0.1:4173，局域网 http://<本机IP>:4173
// 绑定地址由 BOSS_DASHBOARD_HOST 控制（默认 0.0.0.0 = 局域网可访问；设为 127.0.0.1 收回本机独占）。

import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter as PATH_DELIMITER } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { query as dbQuery, PG_CONFIG } from '../pg-db.mjs';
import { loadBossControl, saveBossControl } from '../boss-config-db.mjs';
import { splitWordList, validateWordRegex } from '../skip-rules.mjs';
import {
  LLM_PROTOCOLS,
  llmStatusForClient,
  normalizeBaseUrl,
  resolveLlmConfig,
  testLlmConnection,
} from '../boss-llm.mjs';
import { ensureCandidatesSchemaReady, urlPathname as sharedUrlPathname, saveQueue, getRuntimeState, setRuntimeState } from '../boss-common.mjs';
import { readSendHistory as readSharedSendHistory, selectSendableJobs } from '../boss-send-eligibility.mjs';

const IS_WIN = process.platform === 'win32';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BOSS_DASHBOARD_PORT || 4173);
// 绑定地址：默认 0.0.0.0（局域网可访问，家庭网络用法）。
// 想收回本机独占：设 BOSS_DASHBOARD_HOST=127.0.0.1。
// ⚠️ 控制台本身无鉴权，绑到 0.0.0.0 时同网段任何设备都能发招呼/删岗位池——只在可信网络里这么开。
const HOST = process.env.BOSS_DASHBOARD_HOST || '0.0.0.0';
const ROOT = join(__dirname, '..', '..');
const HTML_PATH = join(__dirname, 'index.html');

// 读取「最近一次扫描」的起始时间戳（存 PG boss_runtime_state.last_scan_at），用于「发送新扫描的」范围界定。
async function getLastScanAt() {
  try { const t = await getRuntimeState('last_scan_at'); return t || null; } catch { return null; }
}

// ---- 读取 boss 配置（阈值 / 每城配额 / 关键词）----
// PostgreSQL boss_config 是**唯一**配置基准。这里不再内置任何默认城市/阈值副本，
// 也不再 .catch 吞掉连库错误 —— 库不可用时直接把错误带到前端，避免"看起来正常、其实用的是过期文件值"。
// 城市清单 = daily_limit_per_city 的键（配额 0 = 只扫不发）。
async function loadBossConfig() {
  const c = await loadBossControl();
  return {
    threshold: Number(c.send_threshold) > 0 ? Number(c.send_threshold) : 3.0,
    dailyLimitPerCity:
      c.daily_limit_per_city && typeof c.daily_limit_per_city === 'object'
        ? c.daily_limit_per_city
        : {},
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
    // HR 活跃硬闸（true=hr_active 以月/半年/年计的岗位被发送预检拦截；false=关闭，只靠评分压分）
    staleHrActiveExclude: c.stale_hr_active_exclude === false ? false : true,
    // 跳词 / 排除规则（DB boss_config，控制台可编辑；默认表见 boss/skip-rules.mjs）
    skipWords: Array.isArray(c.skip_words) ? c.skip_words : [],
    riskKeywords: Array.isArray(c.risk_keywords) ? c.risk_keywords : [],
    titleExclude: Array.isArray(c.title_exclude) ? c.title_exclude : [],
    companyExclude: Array.isArray(c.company_exclude) ? c.company_exclude : [],
    // LLM 招呼语（2026-10-30）：base url / 模型 / 协议 / key 全部来自 DB 同一行配置。
    // 明文 key 只留在服务端，这里给前端的是掩码（llmStatusForClient）。
    llm: llmStatusForClient(resolveLlmConfig(c)),
  };
}

// 运行时可用的 LLM 配置（含明文 key）——只给服务端自己用（打分/测试连通），绝不进响应体。
async function loadRuntimeLlmConfig() {
  return resolveLlmConfig(await loadBossControl());
}

// ---- 写回 boss 配置到数据库（阈值 / 每城配额 / 关键词）----
// 前端每次提交完整的 daily_limit_per_city 映射，与 DB 现有值合并后整体覆盖，天然支持「移除城市」。
async function saveBossConfig(body = {}) {
  const {
    send_threshold, daily_limit_per_city, daily_extract_queries, daily_extract_keywords_by_city,
    platform_daily_limit,
    keyword_gap_seconds, city_gap_seconds, card_gap_min_ms, card_gap_max_ms, scan_budget_factor,
    require_full_jd, stale_hr_active_exclude,
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
  // HR 活跃硬闸开关：布尔透传，未传保持现值（默认开）
  if (stale_hr_active_exclude != null) partial.stale_hr_active_exclude = Boolean(stale_hr_active_exclude);
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

async function q(sql, params) {
  const [rows] = await dbQuery(sql, params);
  return rows;
}

// ---- LLM 招呼语配置写回（2026-10-30；独立于 /api/quota，有自己的保存/测试按钮）----
// 校验原则：控制台填什么就校验什么，非法值直接报错，不要静默夹到默认值——否则用户以为改好了。
// API Key 特殊：空字符串 = **保持不变**（前端永远只拿到掩码，留空不能把已配置的 key 抹掉）；
// 要清空必须显式 clearKey: true。
async function saveLlmConfig(body = {}) {
  const partial = {};
  if (body.enabled != null) partial.llm_enabled = Boolean(body.enabled);
  if (body.protocol != null) {
    const p = String(body.protocol).trim().toLowerCase();
    if (!LLM_PROTOCOLS.includes(p)) {
      throw new Error(`协议非法：${body.protocol}（可选 ${LLM_PROTOCOLS.join(' / ')}）`);
    }
    partial.llm_protocol = p;
  }
  if (body.baseUrl != null) {
    const raw = String(body.baseUrl).trim();
    if (raw && !/^https?:\/\//i.test(raw)) throw new Error('base url 必须以 http:// 或 https:// 开头');
    partial.llm_base_url = normalizeBaseUrl(raw);
  }
  if (body.model != null) partial.llm_model = String(body.model).trim();
  if (body.clearKey === true) partial.llm_api_key = '';
  else if (body.apiKey != null && String(body.apiKey).trim()) partial.llm_api_key = String(body.apiKey).trim();
  const numeric = [
    ['temperature', 'llm_temperature', 0, 2],
    ['maxTokens', 'llm_max_tokens', 0, 8192],
    ['timeoutMs', 'llm_timeout_ms', 1000, 300000],
    ['concurrency', 'llm_concurrency', 1, 16],
    // 唯一的数量参数：每批岗位数（输出预算/超时由代码按批自动推算，不再是可填项）
    ['batchSize', 'llm_analyze_batch_size', 1, 100],
  ];
  for (const [field, key, min, max] of numeric) {
    if (body[field] == null || body[field] === '') continue;
    const n = Number(body[field]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${field} 非法：需在 ${min}–${max} 之间`);
    partial[key] = n;
  }
  // 评估开关：评分时要不要跑这一轮 LLM（匹配结构 + 招呼语）
  if (body.analyzeEnabled != null) partial.llm_analyze_enabled = Boolean(body.analyzeEnabled);
  // 关思维链（网关扩展参数，实测省约 4 倍费用）：显式传值才写
  if (body.thinkingDisabled != null) partial.llm_thinking_disabled = Boolean(body.thinkingDisabled);
  // 思考力度：空 = 不传该参数（各家网关兼容性最好）
  if (body.reasoningEffort != null) {
    const effort = String(body.reasoningEffort).toLowerCase();
    if (!['', 'low', 'medium', 'high'].includes(effort)) throw new Error(`思考力度非法：${body.reasoningEffort}`);
    partial.llm_reasoning_effort = effort;
  }
  if (body.prompt != null) partial.llm_prompt = String(body.prompt).slice(0, 4000);
  await saveBossControl(partial);
  return loadBossConfig();
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
  const history = await readSharedSendHistory(urlCity);
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
    titleExclude: cfg.titleExclude,
    staleHrActiveExclude: cfg.staleHrActiveExclude,
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
            SUM(CASE WHEN greeted=1 THEN 1 ELSE 0 END) AS greeted,
            -- 原始候选同样排除人工排除的岗位（2026-10-30 用户：排除=彻底不出局，连候选都不算）
            SUM(CASE WHEN greeted=0 AND manual_excluded=0 AND score>=? AND availability <> 'closed' AND (status IS NULL OR status <> 'closed') THEN 1 ELSE 0 END) AS pending
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
      titleExclude: cfg.titleExclude,
      staleHrActiveExclude: cfg.staleHrActiveExclude,
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
    // LLM 招呼语状态（掩码 key）：控制台首屏横幅与「LLM 招呼语」面板都用它回填
    llm: cfg.llm,
    dailyExtractQueries: cfg.dailyExtractQueries,
    pacing: {
      keywordGapSeconds: cfg.keywordGapSeconds,
      cityGapSeconds: cfg.cityGapSeconds,
      cardGapMinMs: cfg.cardGapMinMs,
      cardGapMaxMs: cfg.cardGapMaxMs,
      scanBudgetFactor: cfg.scanBudgetFactor,
      requireFullJd: cfg.requireFullJd,
      staleHrActiveExclude: cfg.staleHrActiveExclude,
      maxDomCards: cfg.maxDomCards,
      knownStreakLimit: cfg.knownStreakLimit,
    },
    rules: {
      skipWords: cfg.skipWords,
      riskKeywords: cfg.riskKeywords,
      titleExclude: cfg.titleExclude,
      staleHrActiveExclude: cfg.staleHrActiveExclude,
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
    lastScanAt: await getLastScanAt(),
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
    const likes = kws.map(() => '(title ILIKE ? OR raw::text ILIKE ?)').join(' OR ');
    kws.forEach((kw) => args.push(`%${kw}%`, `%${kw}%`));
    where.push('NOT (' + likes + ')');
  } else if (typePatterns[f.jobType]) {
    const likes = typePatterns[f.jobType].map(() => '(title ILIKE ? OR raw::text ILIKE ?)').join(' OR ');
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
  // HR 活跃时间过滤（2026-10-16 用户要求）：走独立列 boss_jobs.hr_active
  // （提取自卡片/详情页 .boss-active-time，如「刚刚活跃 / 今日活跃 / 3日内活跃 / 本周活跃 / 2月内活跃」）。
  // 未提取到的（历史数据、空串）只在「不限」时出现；选任一档都会把它们排除。
  if (f.hrActive === 'recent') {
    // 近一周内有活动迹象：刚刚/今日/今天/分钟/小时/日内/天内/本周
    where.push(`hr_active ~ '刚刚|今日|今天|分钟|小时|日内|天内|本周|在线'`);
  } else if (f.hrActive === 'week') {
    // 本周（含近期）：排除以「月/年」为单位的长期未活跃
    where.push(`(hr_active ~ '刚刚|今日|今天|分钟|小时|日内|天内|本周|在线'
      OR (hr_active <> '' AND hr_active !~ '月|年'))`);
  } else if (f.hrActive === 'month') {
    // 最近一个月：排除「2月内活跃」「半年」「X年」等，保留「一月内/30天内/本月活跃」及所有近期档
    where.push(`(hr_active ~ '刚刚|今日|今天|分钟|小时|日内|天内|本周|在线|一月内|30天|本月|半个月|半月|一周内|两周'
      OR (hr_active <> '' AND hr_active !~ '[2-9]月|半年|几月|数月|年'))`);
  }
  if (f.keyword) {
    const terms = String(f.keyword).split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (terms.length) {
      const ors = terms.map(() => '(title ILIKE ? OR raw::text ILIKE ?)');
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
    hrActive: String(sp.get('hrActive') || ''),
  };
  const sort = String(sp.get('sort') || 'score_desc');

  const { whereSql: baseWhere, args } = buildJobFilter(f, { threshold: cfg.threshold });
  const snapshot = await getSendabilitySnapshot(cfg);
  const scopedSelection = f.city
    ? selectSendableJobs(snapshot.rows.filter((job) => String(job.city || '').split('·')[0] === f.city), {
      threshold: cfg.threshold,
      cityLimits: cfg.dailyLimitPerCity,
      platformLimit: cfg.platformDailyLimit,
      titleExclude: cfg.titleExclude,
      staleHrActiveExclude: cfg.staleHrActiveExclude,
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
    // 按 LLM 深解析的匹配分排序（没解析过的排最后）
    // 用 coalesce 而不是裸列：llm_score 是派生列，历史上有整池重写清空过，raw.llm 才是来源
    llm_desc: `(coalesce(llm_score, (raw->'llm'->'match'->>'score')::numeric)) IS NULL,
               (coalesce(llm_score, (raw->'llm'->'match'->>'score')::numeric)) DESC, score DESC`,
    // 升序版本：没有分的仍然沉底（IS NULL 前置），否则空值会占满第一页
    llm_asc: `(coalesce(llm_score, (raw->'llm'->'match'->>'score')::numeric)) IS NULL,
              (coalesce(llm_score, (raw->'llm'->'match'->>'score')::numeric)) ASC, score DESC`,
    score_asc: 'score IS NULL, score ASC, salary_max DESC',
    salary_asc: 'salary_max IS NULL, salary_max ASC, score DESC',
  };
  const rows = await q(
    `SELECT key_hash, company, title, salary, salary_min, salary_max, city, hr_active, url, greeted, contact_state, score, status, availability, manual_excluded, manual_exclusion_reason, scanned_at,
            coalesce(llm_score, (raw->'llm'->'match'->>'score')::numeric) AS llm_score,
            raw->'llm' AS llm,
            raw->>'recommendation' AS recommendation,
            raw->>'score_eligible' AS score_eligible,
            raw->>'greetingSource' AS greeting_source,
            raw->>'greeting' AS greeting
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
    rows: rows.map((r) => {
      // 深解析结果（cv.md + JD → 标准 JSON）：raw.llm 整份带出来，列表只摘要关键几项
      const llm = r.llm && typeof r.llm === 'object' ? r.llm : null;
      return {
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
      // HR 活跃时间（独立列，卡片/详情页 .boss-active-time，如「今日活跃」）——展示与过滤共用
      hrActive: r.hr_active || '',
      // 无分数 = 评分判定「不可发送」后按设计不回写 score。把评分器写下的原因带出来，
      // 列表里就能显示"为什么没有分数"，而不是只看到一个「—」（2026-10-14 用户提问）。
      recommendation: r.recommendation || '',
      scoreEligible: r.score_eligible == null ? null : Number(r.score_eligible),
      // 招呼语来源（llm_analysis / llm / template）与文案本身：列表里能看出会不会用模板话术发出去
      greetingSource: r.greeting_source || '',
      greeting: r.greeting || '',
      // LLM 深解析（参考分：不参与发送资格，规则分仍是唯一权威）
      llmScore: r.llm_score == null ? null : Number(r.llm_score),
      llmLevel: llm?.match?.level || '',
      llmWhy: llm?.match?.why || '',
      llmRisk: llm?.job?.risk_level || '',
      llmGaps: Array.isArray(llm?.match?.gaps) ? llm.match.gaps.map((g) => g.requirement).slice(0, 4) : [],
      llmTech: Array.isArray(llm?.job?.tech_stack) ? llm.job.tech_stack.slice(0, 8) : [],
      llmRedFlags: Array.isArray(llm?.job?.red_flags) ? llm.job.red_flags.slice(0, 4) : [],
      llmAnalyzedAt: llm?.analyzed_at || '',
      llmModel: llm?.model || '',
      status: r.status,
      scanned_at: r.scanned_at,
      };
    }),
  };
}

// ===== 执行引擎（白名单 + 实时日志）=====
// 只跑下表中的命令；send / send_city 为危险档，需前端显式确认后才放行。
const RUN_ALLOWED = {
  doctor:  'npm run doctor',
  scan:    'npm run boss:extract:daily',
  scan_all:'npm run boss:extract:daily:all',
  score:   'npm run boss:score',
  // 深解析已并进 score（点「扫描」一条龙就做了）；这里留一个手动入口，用于补跑/重解析少量岗位
  analyze: 'npm run boss:analyze -- --limit 20',
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

    // ---- 单岗位详情（表格里放不下招呼语全文与深解析明细，点开弹窗时按需拉这一条）----
    if (url.pathname === '/api/jobs/llm' && req.method === 'GET') {
      const json = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      const keyHash = String(url.searchParams.get('key_hash') || '').trim();
      if (!/^[A-Za-z0-9+/=_\-]{8,512}$/.test(keyHash)) return json({ ok: false, error: 'key_hash 非法' }, 400);
      const rows = await q(
        `SELECT key_hash, company, title, city, salary, hr_active, url, greeted, contact_state,
                status, availability, manual_excluded, score,
                coalesce(llm_score, (raw->'llm'->'match'->>'score')::numeric) AS llm_score,
                raw->>'greeting' AS greeting,
                raw->>'greetingSource' AS greeting_source,
                raw->>'greetingModel' AS greeting_model,
                raw->'llm' AS llm
           FROM boss_jobs WHERE key_hash = ?`,
        [keyHash],
      );
      if (!rows.length) return json({ ok: false, error: '岗位不存在（可能已被删除）' }, 404);
      const r = rows[0];
      const llm = r.llm && typeof r.llm === 'object' ? r.llm : null;
      return json({
        ok: true,
        job: {
          key_hash: r.key_hash,
          company: r.company,
          title: r.title,
          city: r.city,
          salary: r.salary,
          hrActive: r.hr_active || '',
          url: r.url || '',
          greeted: Boolean(r.greeted),
          contactState: r.contact_state || '',
          status: r.status || '',
          availability: r.availability || '',
          manualExcluded: Boolean(r.manual_excluded),
          score: r.score == null ? null : Number(r.score),
          llmLevel: llm?.match?.level || '',
        },
        llmScore: r.llm_score == null ? null : Number(r.llm_score),
        greeting: r.greeting || '',
        greetingSource: r.greeting_source || '',
        greetingModel: r.greeting_model || '',
        llm,
      });
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
              titleExclude: cfgBulk.titleExclude,
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
            raw=jsonb_set(jsonb_set(jsonb_set(jsonb_set(raw,
              '{greeted}', to_jsonb(true)),
              '{contactState}', to_jsonb('manual_contact_confirmed'::text)),
              '{manualExcluded}', to_jsonb(false)),
              '{manualExclusionReason}', to_jsonb(''::text)) ` + target.whereSql, target.args);
        } else if (action === 'exclude') {
          r = await q(`UPDATE boss_jobs SET manual_excluded=1, manual_exclusion_reason='user',
            raw=jsonb_set(jsonb_set(raw, '{manualExcluded}', to_jsonb(true)), '{manualExclusionReason}', to_jsonb('user'::text)) ` + target.whereSql, target.args);
        } else if (action === 'restore_exclusion') {
          r = await q(`UPDATE boss_jobs SET manual_excluded=0, manual_exclusion_reason='',
            raw=jsonb_set(jsonb_set(raw, '{manualExcluded}', to_jsonb(false)), '{manualExclusionReason}', to_jsonb(''::text)) ` + target.whereSql, target.args);
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

    // ---- LLM 招呼语：读配置（key 只给掩码）/ 保存 / 测试连通 ----
    if (url.pathname === '/api/llm') {
      const json = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET') {
        const cfg = await loadBossConfig();
        return json({ ok: true, llm: cfg.llm });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const cfg = await saveLlmConfig(body);
          return json({ ok: true, llm: cfg.llm });
        } catch (e) {
          return json({ ok: false, error: e.message }, 400);
        }
      }
      return json({ ok: false, error: `不支持的方法：${req.method}` }, 405);
    }
    // 测试连通：优先用前端表单里**当前**的值（未保存也能先试），留空的字段回落到库里已保存的值；
    // key 留空则用库里那份（前端拿不到明文，只能这样）。只发一句最小请求，不写库、不产生打招呼文案。
    if (url.pathname === '/api/llm/test' && req.method === 'POST') {
      const json = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      let body = {};
      try { body = await readBody(req); } catch { body = {}; }
      try {
        const stored = await loadRuntimeLlmConfig();
        const candidate = {
          ...stored,
          enabled: true,
          protocol: body.protocol ? String(body.protocol).toLowerCase() : stored.protocol,
          baseUrl: body.baseUrl ? normalizeBaseUrl(body.baseUrl) : stored.baseUrl,
          model: body.model ? String(body.model).trim() : stored.model,
          apiKey: (body.apiKey && String(body.apiKey).trim()) || stored.apiKey,
        };
        for (const [field, key] of [['temperature', 'temperature'], ['maxTokens', 'maxTokens'], ['timeoutMs', 'timeoutMs']]) {
          const n = Number(body[field]);
          if (body[field] != null && body[field] !== '' && Number.isFinite(n)) candidate[key] = n;
        }
        const result = await testLlmConnection(candidate);
        return json({ ok: true, ...result, model: candidate.model, protocol: candidate.protocol });
      } catch (e) {
        return json({ ok: false, error: e.message }, 200);
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
          titleExclude: cfg.titleExclude,
      staleHrActiveExclude: cfg.staleHrActiveExclude,
          history: snapshot.history,
        });
        const jobs = citySelection.jobs;
        if (!jobs.length) {
          return json({ ok: false, error: `${city} 当前没有进入本轮可发送队列的岗位（评分、联系状态、职位状态、30 天同岗位去重或当日配额未通过）` }, 400);
        }
        await saveQueue(city, jobs);
        const cmd = `npm run boss:chrome:apply -- --queue ${city} --threshold ${cfg.threshold} --confirmed-review && node merge-tracker.mjs`;
        if (body.confirm !== true) {
          return json({ ok: false, needConfirm: true, cmd, count: jobs.length,
            message: `已按控制台“本轮可发送”预检生成 ${city} 临时队列（PG boss_queue），共 ${jobs.length} 条。确认后仍会在发送前检查 BOSS 实时页面状态。` }, 409);
        }
        if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
        RUN_ALLOWED[key] = cmd;
        RUN_TIER[key] = 'confirm';
        return json({ ok: true, job: publicJob(startRun(key)), note: `临时队列已写入 PG boss_queue（queue_name=${city}）` });
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
        try { await setRuntimeState('last_scan_at', new Date().toISOString()); } catch { /* ignore */ }
        // --analyze-city：评分里的深解析只解析本城（点南京的扫描不去解析上海/厦门的岗位）
        const cmd = `npm run boss:extract:daily -- --city "${city}"${kwArg} && npm run boss:score -- --analyze-city "${city}" && npm run boss:fill -- --prepare`;
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
          titleExclude: cfg.titleExclude,
      staleHrActiveExclude: cfg.staleHrActiveExclude,
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
        await saveQueue(city, jobs);
        const cmd = `npm run boss:chrome:apply -- --queue ${city} --threshold ${cfg.threshold} --confirmed-review && node merge-tracker.mjs`;
        if (body.confirm !== true) {
          return json({ ok: false, needConfirm: true, cmd, count: jobs.length,
            message: `已按本轮发送规则从最近扫描新增岗位中预检出 ${jobs.length} 条（PG boss_queue）。确认后仍会在发送前检查 BOSS 实时页面状态。` }, 409);
        }
        if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
        RUN_ALLOWED[key] = cmd;
        RUN_TIER[key] = 'confirm';
        return json({ ok: true, job: publicJob(startRun(key)), note: `临时队列已写入 PG boss_queue（queue_name=${city}）` });
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

// 列出本机非回环 IPv4，方便直接照抄到手机/另一台电脑打开控制台。
function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`BOSS 流程操作控制台已启动: http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const urls = lanUrls(PORT);
    if (urls.length) console.log(`局域网访问: ${urls.join('  ')}`);
    else console.log('局域网访问: 未检测到非回环 IPv4 网卡');
    console.log('（控制台无鉴权，仅限可信网络；收回本机独占设 BOSS_DASHBOARD_HOST=127.0.0.1）');
  } else {
    console.log(`绑定地址: ${HOST}（仅此地址可访问）`);
  }
  console.log(`PostgreSQL: ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}  user=${PG_CONFIG.user}`);
});




