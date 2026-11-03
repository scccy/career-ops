import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, normalize } from 'path';
import { createHash } from 'crypto';
import { query, getConnection, cancelIdleClose, scheduleIdleClose } from './pg-db.mjs';
import { ensureSchema } from './pg-schema.mjs';
import * as yaml from 'js-yaml';

export const ROOT_DATA_DIR = 'data';
export const CANDIDATES_PATH = 'data/boss-candidates.json';
export const QUEUE_PATH = 'data/boss-queue.json';
export const SENT_LOG_PATH = 'data/boss-sent-log.tsv';
export const APPLICATIONS_PATH = 'data/applications.md';

export const BOSS_CITY_CODES = {
  全国: '100010000',
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  成都: '101270100',
  南京: '101190100',
  无锡: '101190200',
  常州: '101191100',
  苏州: '101190400',
  武汉: '101200100',
  西安: '101110100',
  长沙: '101250100',
  重庆: '101040100',
  天津: '101030100',
  长春: '101060100',
  // 2026-10-23 新增：厦门（福建）。编码取自 BOSS 官方城市表 city.json，与搜索页 URL
  // web/geek/jobs?city=101230200 一致；其余同省城市 福州 101230100 / 泉州 101230500。
  厦门: '101230200',
};

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

export function ensureDirFor(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function writeJson(filePath, data) {
  ensureDirFor(filePath);
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgoIso(days, date = todayIso()) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

export function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

export function list(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === '') return [];
  return [String(value)];
}

// 年薪（万）→ 月薪 K，供 boss-score 的 parseSalaryRange 使用；已是 K 格式则原样透传。
function annualToMonthlyK(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const k = (n) => Math.round(Number(n) * 10 / 12);
  const range = t.match(/(\d+(?:\.\d+)?)[-~至](\d+(?:\.\d+)?)万/);
  if (range) return `${k(range[1])}-${k(range[2])}K`;
  const single = t.match(/(\d+(?:\.\d+)?)万/);
  if (single) return `${k(single[1])}K`;
  return t;
}

// 主项目画像 schema → boss 评分器期望字段的归一视图。只做字段映射，不新增事实：
// 数据全部来自 config/profile.yml（target_roles / location / compensation / narrative / boss.skills_core）。
function normalizeProfile(profile) {
  const roles = [...list(profile?.target_roles?.primary), ...list(profile?.target_roles?.secondary)];
  const cities = list(profile?.location?.preferred_cities);
  const skills = list(profile?.boss?.skills_core);
  return {
    ...profile,
    target: {
      ...(profile?.target || {}),
      roles: roles.length ? roles : list(profile?.target?.roles),
      cities: cities.length ? cities : list(profile?.target?.cities),
      expected_salary: profile?.target?.expected_salary || annualToMonthlyK(profile?.compensation?.target_range),
      minimum_salary: profile?.target?.minimum_salary || annualToMonthlyK(profile?.compensation?.minimum),
    },
    skills: { ...(profile?.skills || {}), core: skills.length ? skills : list(profile?.skills?.core) },
    preferences: {
      ...(profile?.preferences || {}),
      reject: list(profile?.preferences?.reject).length ? list(profile?.preferences?.reject) : list(profile?.location?.block_default),
    },
    highlights: {
      projects: list(profile?.narrative?.proof_points).map((p) => [p?.name, p?.hero_metric, p?.detail].filter(Boolean).join('：')),
      experience: list(profile?.narrative?.superpowers),
    },
  };
}

export function loadProfile({ allowUnconfirmed = false } = {}) {
  if (!existsSync('config/profile.yml')) {
    throw new Error('config/profile.yml not found. 请先根据简历生成并确认中文求职画像。');
  }
  const profile = yaml.load(readFileSync('config/profile.yml', 'utf-8')) || {};
  // 主项目画像没有 profile.confirmed 键；candidate + target_roles/narrative 同时存在即视为已个性化画像。
  const mainProfileReady = Boolean(profile?.candidate && (profile?.target_roles || profile?.narrative));
  if (!allowUnconfirmed && profile?.profile?.confirmed !== true && !mainProfileReady) {
    throw new Error('中文求职画像尚未确认。请先确认 config/profile.yml 中 profile.confirmed: true 后再评分或批量发送。');
  }
  return normalizeProfile(profile);
}

export function resolveBossCityCode(city) {
  const text = String(city || '').replace(/\s+/g, '');
  if (!text) return '';
  if (/^\d+$/.test(text)) return text;
  const normalized = text.split(/[·,，/、-]/)[0];
  return BOSS_CITY_CODES[normalized] || '';
}

export function resolveBossSearchCity({ explicitCity = '', profile = null, fallback = '100010000' } = {}) {
  const explicit = resolveBossCityCode(explicitCity);
  if (explicit) return { code: explicit, source: 'args', city: explicitCity };

  const targetCity = list(profile?.target?.cities)[0]
    || list(profile?.location?.preferred_cities)[0]
    || String(profile?.candidate?.location || '');
  const fromProfile = resolveBossCityCode(targetCity);
  if (fromProfile) return { code: fromProfile, source: 'profile', city: targetCity };

  return { code: fallback, source: 'fallback', city: targetCity || '全国' };
}

export function parseSalaryRange(raw) {
  const text = String(raw || '').replace(/\s+/g, '');
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)(?:-|~|—|至)(\d+(?:\.\d+)?)\s*[kK千]?/);
  if (match) return { min: Number(match[1]), max: Number(match[2]), unit: 'K/月' };
  const single = text.match(/(\d+(?:\.\d+)?)\s*[kK千]/);
  if (single) return { min: Number(single[1]), max: Number(single[1]), unit: 'K/月' };
  return null;
}

export function salaryScore(jobSalary, expectedSalary, minimumSalary) {
  const job = parseSalaryRange(jobSalary);
  const expected = parseSalaryRange(expectedSalary);
  const minimum = parseSalaryRange(minimumSalary);
  if (!job || (!expected && !minimum)) return 3;
  if (minimum && job.max < minimum.min) return 1;
  if (expected && job.max >= expected.min && job.min <= expected.max) return 5;
  if (expected && job.max >= expected.min * 0.85) return 4;
  if (minimum && job.max >= minimum.min) return 3.5;
  return 2;
}

export function includesAny(text, keywords) {
  const lower = normalizeText(text);
  return list(keywords).some((kw) => lower.includes(normalizeText(kw)));
}

export function countMatches(text, keywords) {
  const lower = normalizeText(text);
  return list(keywords).filter((kw) => lower.includes(normalizeText(kw))).length;
}

export function normalizeBossCity(value) {
  // BOSS 的 city 可能是「杭州·滨江区·长河」；岗位身份只按 base city 区分，
  // 避免同一 base 的区域文本变化制造重复，同时避免不同 base 被错误合并。
  return normalizeText(String(value || '').split(/[·,，/、-]/)[0]) || 'unknown';
}

export function uniqueJobKeyLegacy(job) {
  // 兼容 2026-10-14 之前的发送日志/旧键：仅公司+岗位，不作为新数据的主键。
  return `${normalizeText(job.company)}::${normalizeText(job.title)}`;
}

export function uniqueJobKeyUnknown(job) {
  // 发送日志里没有 city 列的历史行（2026-10-01 之前）专用：城市位固定 unknown，
  // 只会与「城市未知」的岗位相撞，不再跨城误杀。
  return `${normalizeText(job.title)}::${normalizeText(job.company)}::unknown`;
}

export function uniqueJobKey(job) {
  // 2026-10 用户要求：岗位身份 = 岗位名称 + 公司 + base 城市（不再含 URL 指纹）。
  // 同公司 + 同标题 + 同 base 城市 = 同一岗位（不同 job id 也合并）；不同标题 / 不同 base 城市仍是不同岗位。
  // base 城市只取第一段，避免「杭州·滨江区·长河」区域文本变化制造重复。
  return `${normalizeText(job.title)}::${normalizeText(job.company)}::${normalizeBossCity(job.city || job.location)}`;
}

export function uniqueCandidateKey(job) {
  // 候选池主键与重复投递的「同一岗位」判断共用城市作用域；同公司同岗位不同 base
  // 是两个不同机会，应分别入库/评估。公司级去重仍由 uniqueCompanyKey 单独负责。
  return uniqueJobKey(job);
}

export function uniqueCompanyKey(job) {
  return normalizeText(job.company || job.url || job.title);
}

export function uniqueCompanyPlacementKey(job) {
  // 公司+base 城市。只用于「同一批次内一家公司只取一条」的批次上限，
  // 不再承担 30 天去重（2026-10-23 用户确认：同公司的不同部门/子项目应能分别投递）。
  return `${uniqueCompanyKey(job)}::${normalizeBossCity(job.city || job.location)}`;
}

export function mergeJobs(existingJobs, incomingJobs) {
  const merged = [];
  const indexByKey = new Map();
  for (const job of [...listJobs(existingJobs), ...listJobs(incomingJobs)]) {
    const key = uniqueCandidateKey(job);
    if (!key.replace(/:/g, '')) continue;
    if (indexByKey.has(key)) {
      merged[indexByKey.get(key)] = { ...merged[indexByKey.get(key)], ...job };
      continue;
    }
    indexByKey.set(key, merged.length);
    merged.push(job);
  }
  return merged;
}

export function countUniqueCompanies(jobs) {
  return new Set(listJobs(jobs).map(uniqueCompanyKey).filter(Boolean)).size;
}

function listJobs(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

export async function loadSentKeys({ date = null, sinceDate = '', lookbackDays = null, statuses = ['sent'] } = {}) {
  const keys = new Set();
  const allowedStatuses = list(statuses);
  const minDate = sinceDate || (lookbackDays == null ? '' : daysAgoIso(lookbackDays));
  const where = [];
  const params = [];
  if (date) { where.push('sent_date = ?'); params.push(date); }
  if (minDate) { where.push('sent_date >= ?'); params.push(minDate); }
  if (allowedStatuses.length) { where.push('status = ANY(?)'); params.push(allowedStatuses); }
  const [rows] = await query(
    `SELECT company, title, url, city FROM boss_sent_log${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    params,
  );
  for (const row of rows) {
    if (!row.company || !row.title) continue;
    keys.add(row.city
      ? uniqueJobKey({ company: row.company, title: row.title, url: row.url, city: row.city })
      : uniqueJobKeyUnknown({ company: row.company, title: row.title, url: row.url }));
  }
  return keys;
}

// auto_sent = 继续沟通场景下 BOSS 自动发送的默认打招呼语（真实联系已建立，计入配额与去重）
export async function loadSentCompanyKeys({ date = null, sinceDate = '', lookbackDays = null, statuses = ['sent', 'auto_sent'] } = {}) {
  const keys = new Set();
  const allowedStatuses = list(statuses);
  const minDate = sinceDate || (lookbackDays == null ? '' : daysAgoIso(lookbackDays));
  const where = [];
  const params = [];
  if (date) { where.push('sent_date = ?'); params.push(date); }
  if (minDate) { where.push('sent_date >= ?'); params.push(minDate); }
  if (allowedStatuses.length) { where.push('status = ANY(?)'); params.push(allowedStatuses); }
  const [rows] = await query(
    `SELECT company FROM boss_sent_log${where.length ? ' WHERE ' + where.join(' AND ') : ''}`,
    params,
  );
  for (const row of rows) {
    if (row.company) keys.add(normalizeText(row.company));
  }
  return keys;
}

export async function countSentToday(date = todayIso()) {
  const [rows] = await query('SELECT COUNT(*)::int AS n FROM boss_sent_log WHERE sent_date = ? AND status = ?', [date, 'sent']);
  return Number(rows[0].n);
}

export async function countSentCompaniesToday(date = todayIso()) {
  return (await loadSentCompanyKeys({ date, statuses: ['sent', 'auto_sent'] })).size;
}

// 按城市统计今日已发送公司数（本地适配：城市配额见 PostgreSQL boss_config.boss_city_control.daily_limit_per_city）。
// 新日志直接使用 city 列；旧日志没有 city 时再由 URL 反查候选池，无法匹配归入"未知"。
// URL 指纹：只取 pathname（job_detail/<id>.html），剥掉 query。
// BOSS 每次扫描同一岗位都换新 securityId，若用完整 URL 匹配，重扫后
// 发送日志里的历史 URL 就对不上池子，按城配额扣减会失灵（#2026-09-29）。
export function urlPathname(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  // 相对 href（如卡片上的 `/job_detail/xxx.html?securityId=...`）用 new URL() 解析会抛错，
  // 早期实现直接返回原始串，等于把每次都变的 securityId 算进了岗位身份（2026-10-23 修正）。
  // 现在两种形式都只取 path：绝对 URL 取 pathname，相对串按 ? / # 截断。
  try {
    return new URL(s).pathname || '';
  } catch {
    return s.split(/[?#]/)[0];
  }
}

export async function countSentCompaniesTodayByCity({ date = todayIso(), urlCity = new Map() } = {}) {
  const byCity = new Map();
  const seen = new Set();
  const [rows] = await query(
    'SELECT company, url, city FROM boss_sent_log WHERE sent_date = ? AND status = ANY(?)',
    [date, ['sent', 'auto_sent']],
  );
  for (const row of rows) {
    const path = urlPathname(row.url);
    const dedupeKey = path || `${normalizeText(row.company)}::${normalizeBossCity(row.city)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const city = String(row.city || urlCity.get(path) || '').split('·')[0] || '未知';
    if (!byCity.has(city)) byCity.set(city, new Set());
    byCity.get(city).add(normalizeText(row.company));
  }
  return Object.fromEntries([...byCity].map(([city, keys]) => [city, keys.size]));
}

export async function appendSentLog({ job, status, message = '', error = '' }) {
  const now = new Date();
  await query(
    `INSERT INTO boss_sent_log (sent_date, sent_time, company, title, url, key_hash, status, message, error, city)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now.toISOString().slice(0, 10),
      now.toTimeString().slice(0, 8),
      job.company || '',
      job.title || '',
      job.url || '',
      job.key_hash || null,
      status,
      String(message).replace(/\s+/g, ' '),
      String(error).replace(/\s+/g, ' '),
      String(job.city || job.location || '').replace(/\s+/g, ' '),
    ],
  );
}

export function ensureApplicationsTracker() {
  mkdirSync(ROOT_DATA_DIR, { recursive: true });
  if (!existsSync(APPLICATIONS_PATH)) {
    writeFileSync(
      APPLICATIONS_PATH,
      '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n',
      'utf-8',
    );
  }
}

export function nextTrackerId() {
  ensureApplicationsTracker();
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  let max = 0;
  for (const match of text.matchAll(/^\|\s*(\d+)\s*\|/gm)) {
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

// 追踪表新增一律走 batch/tracker-additions TSV 由 merge-tracker.mjs 合并（pipeline integrity 规则），不直接写 applications.md。
let additionSeq = 0;

export function appendApplication({ job, score = '—', status = 'Applied', report = '—', notes = '' }) {
  const dir = 'batch/tracker-additions';
  mkdirSync(dir, { recursive: true });
  const num = nextTrackerId() + additionSeq++;
  const slug = String(job.company || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'boss';
  const file = `${dir}/${num}-${slug}.tsv`;
  const header = ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes', 'url'].join('\t');
  const row = [num, todayIso(), job.company || '?', job.title || '', status, score, '❌', report, notes, job.url || ''].join('\t');
  writeFileSync(file, `${header}\n${row}\n`, 'utf-8');
  return file;
}

// ===== PostgreSQL 候选池（boss_jobs）=====
// 2026-10 迁移：BOSS 流程全部以 PostgreSQL 为准（库名默认 career_ops）。
// data/boss-candidates.json 降级为每次写入时的 JSON 备份镜像，权威数据在 PG。
// 连接参数：PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE（见 pg-db.mjs）。

export function isCandidatesPath(p) {
  return normalize(String(p || '')) === normalize(CANDIDATES_PATH);
}

export function candidateKeyHash(job) {
  return createHash('sha256').update(uniqueCandidateKey(job)).digest('hex');
}

function parseRawRow(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// 行 → 岗位对象：url / greeted / key_hash 独立列是权威字段，覆盖回 raw 对象
function mapJobRow(r) {
  const job = parseRawRow(r.raw);
  if (r.url) job.url = r.url;
  if (r.hr_active != null) job.hr_active = String(r.hr_active);
  job.greeted = Boolean(r.greeted);
  job.contactState = String(r.contact_state || (r.greeted ? 'legacy_contact_unknown' : 'never_contacted'));
  job.availability = String(r.availability || (r.status === 'closed' ? 'closed' : 'unknown'));
  job.manualExcluded = Boolean(r.manual_excluded);
  job.manualExclusionReason = String(r.manual_exclusion_reason || '');
  // 数据库主键：LLM 批次用它当「岗位编号」（比 1..N 的序号可回溯：出问题能直接按 id 查库）
  if (r.id != null) job.dbId = Number(r.id);
  if (r.key_hash) job.key_hash = r.key_hash;
  // score/status 列是权威字段：必须回读，否则扫描整池重写时评分与「职位已关闭」标记会被抹掉
  // score 列是权威字段：为 NULL 时必须显式置空，否则 raw 里的旧 score 会在整池重写时被复活，
  // 让「不可发送」的岗位重新变成有分数（2026-10 迁移时实测到 1 条）。
  job.score = r.score == null ? null : Number(r.score);
  if (r.status) job.status = r.status;
  return job;
}

// Console API 与 CLI 脚本共用同一个幂等建表入口。
export async function ensureCandidatesSchemaReady() {
  cancelIdleClose();
  try { await ensureSchema(); }
  finally { scheduleIdleClose(); }
}

export async function loadCandidates() {
  cancelIdleClose();
  try {
    await ensureSchema();
    const [rows] = await query(`SELECT id, key_hash, url, greeted, contact_state, score, status, availability, manual_excluded, manual_exclusion_reason, hr_active, raw FROM boss_jobs ORDER BY id`);
    if (rows.length === 0 && existsSync(CANDIDATES_PATH)) {
      // 一次性迁移：库空且存在旧 JSON 池 → 导入后返回
      const legacy = readJson(CANDIDATES_PATH, []);
      if (legacy.length) {
        await saveCandidates(legacy);
        console.error(`[boss-db] 已从 ${CANDIDATES_PATH} 迁移 ${legacy.length} 条到 PostgreSQL boss_jobs`);
        return legacy;
      }
    }
    return rows.map(mapJobRow);
  } finally {
    scheduleIdleClose();
  }
}

const JOB_COLUMNS = [
  'key_hash', 'company', 'title', 'salary', 'city', 'hr_active', 'url', 'greeted',
  'contact_state', 'salary_min', 'salary_max', 'score', 'llm_score', 'status', 'availability',
  'manual_excluded', 'manual_exclusion_reason', 'scanned_at', 'raw',
];

// 薪资列解析：仅接受 K/千 月薪格式 → {min,max}（单位 K/月）；日结/时薪/月结数字/面议 → {min:null,max:null}
export function parseSalaryMinMax(salary) {
  const text = String(salary || '');
  if (/元\/(天|时|月)/.test(text) || /面议/.test(text)) return { min: null, max: null };
  const parsed = parseSalaryRange(text);
  if (!parsed) return { min: null, max: null };
  return { min: Math.min(parsed.min, parsed.max), max: Math.max(parsed.min, parsed.max) };
}

// LLM 深解析分（列 llm_score）：优先用显式字段，其次从 raw.llm.match.score 反推。
// 目的只有一个：任何「整表重写」路径都不能把这一列写丢（llm_score 是派生值，raw.llm 才是来源）。
export function llmScoreOrNull(job) {
  if (!job || typeof job !== 'object') return null;
  for (const candidate of [job.llm_score, job.llm?.match?.score]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 1 && n <= 5) return Number(n.toFixed(2));
  }
  return null;
}

function jobRow(job) {
  const scanned = job.scanned_at ? new Date(job.scanned_at) : null;
  const scoreNum = Number(job.score);
  // city 列存城市前缀（"杭州·滨江区·长河" → "杭州"）方便精确搜索；raw 里保留完整串
  const cityPrefix = String(job.city || job.location || '').split('·')[0].slice(0, 120);
  const hrActive = String(job.hr_active || '').slice(0, 64);
  const { min: salaryMin, max: salaryMax } = parseSalaryMinMax(job.salary);
  return [
    candidateKeyHash(job),
    String(job.company || '').slice(0, 190),
    String(job.title || '').slice(0, 250),
    String(job.salary || '').slice(0, 120),
    cityPrefix,
    hrActive,
    String(job.url || '').slice(0, 760),
    job.greeted ? 1 : 0,
    String(job.contactState || (job.greeted ? 'legacy_contact_unknown' : 'never_contacted')).slice(0, 32),
    salaryMin,
    salaryMax,
    job.score !== undefined && job.score !== null && job.score !== '' && Number.isFinite(scoreNum) ? scoreNum : null,
    // LLM 深解析分：列存在 llm_score；整池重写（saveCandidates = TRUNCATE + INSERT）时若不带上这一列会把它清空，
    // 所以从 job.llm_score 或 raw.llm.match.score 反推，保证「重写全表」也不会丢（2026-10-30 实际踩过）
    llmScoreOrNull(job),
    String(job.status || '').slice(0, 30),
    String(job.availability || (job.status === 'closed' ? 'closed' : 'unknown')).slice(0, 16),
    job.manualExcluded ? 1 : 0,
    String(job.manualExclusionReason || '').slice(0, 255),
    scanned && !Number.isNaN(scanned.getTime()) ? scanned : null,
    JSON.stringify(job),
  ];
}

function buildValuesSql(rows) {
  const n = JOB_COLUMNS.length;
  return rows.map((_, ri) => '(' + JOB_COLUMNS.map((_, ci) => `$${ri * n + ci + 1}`).join(', ') + ')').join(', ');
}

// ===== LLM 深度解析结果落库（2026-10-30）=====
// 一次调用（cv.md + JD）产出的标准 JSON 全部存下来：整份放 raw.llm，
// 匹配分另存 llm_score 列（可排序/筛选/建索引）；招呼语顺手写进 raw.greeting，
// greetingSource 记为 llm_analysis —— 发送端读的还是同一处，不需要改。
// 注意：这里**不动** score 列。规则评分仍是发送资格的权威，LLM 分只作参考。
export async function saveJobAnalysis(keyHash, analysis, meta = {}) {
  if (!keyHash) throw new Error('saveJobAnalysis: 缺少 key_hash');
  cancelIdleClose();
  try {
    await ensureSchema();
    const payload = {
      ...analysis,
      model: String(meta.model || ''),
      protocol: String(meta.protocol || ''),
      analyzed_at: new Date().toISOString(),
      latency_ms: meta.latencyMs == null ? null : Number(meta.latencyMs),
      usage: meta.usage || null,
    };
    const greeting = String(analysis?.greeting?.text || '');
    const [ret] = await query(
      `UPDATE boss_jobs SET
         llm_score = ?,
         raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object(
                 'llm', ?::jsonb,
                 'greeting', ?::text,
                 'greetingSource', ?::text,
                 'greetingModel', ?::text,
                 'greetingError', ''),
         updated_at = now()
       WHERE key_hash = ?`,
      [
        Number.isFinite(Number(analysis?.match?.score)) ? Number(analysis.match.score) : null,
        JSON.stringify(payload),
        greeting,
        'llm_analysis',
        String(meta.model || ''),
        keyHash,
      ],
    );
    return ret.affectedRows;
  } finally {
    scheduleIdleClose();
  }
}

// 评分回写：只回写评分规则判定可发送的岗位；不合格的保持 score NULL（NULL=不可发）。
export async function persistJobScores(scoredJobs) {
  cancelIdleClose();
  const conn = await getConnection();
  let updated = 0;
  try {
    for (const job of scoredJobs) {
      if (!job || !job.key_hash) continue;
      const eligible = job.db_eligible ? 1 : 0;
      const source = String(job.greeting_source || 'template');
      const greetingText = String(job.greeting || '');
      const [ret] = await conn.query(
        `UPDATE boss_jobs SET
           score = ?,
           raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object(
                   -- 文案不能倒退：本轮只有模板文案（没被 LLM 选中 / 本轮没跑）时，
                   -- 绝不覆盖库里已有的 LLM 文案（2026-10-30 审计：整池覆盖把 50 条 LLM 文案打回了模板）
                   'greeting', CASE
                     WHEN ?::text = 'template' AND COALESCE(raw->>'greetingSource', '') IN ('llm', 'llm_analysis')
                       THEN COALESCE(raw->>'greeting', ?::text)
                     ELSE ?::text END,
                   'greetingSource', CASE
                     WHEN ?::text = 'template' AND COALESCE(raw->>'greetingSource', '') IN ('llm', 'llm_analysis')
                       THEN raw->>'greetingSource'
                     ELSE ?::text END,
                   'greetingModel', ?::text,
                   'greetingError', ?::text,
                   'recommendation', ?::text,
                   'score_eligible', ?::int),
           updated_at = now()
         WHERE key_hash = ?`,
        [
          job.db_eligible && Number.isFinite(Number(job.score)) ? Number(job.score) : null,
          source,
          greetingText,
          greetingText,
          source,
          source,
          String(job.greeting_model || ''),
          String(job.greeting_llm_error || ''),
          String(job.recommendation || ''),
          eligible,
          job.key_hash,
        ],
      );
      updated += ret.affectedRows;
    }
  } finally {
    conn.release();
    scheduleIdleClose();
  }
  return updated;
}

// 语义对齐原 writeJson(CANDIDATES_PATH, jobs)：整池重写；同时落 JSON 备份镜像
// 整池写入（2026-10-30 改）：**不再 TRUNCATE**，改成按 key_hash 幂等 upsert。
// 为什么改：TRUNCATE + INSERT 会让 identity 序列一直涨，同一岗位每重写一次就换一个新 id
// （实测 2629 行的表 id 已到 8 万多），`boss_jobs.id` 因此没法当稳定标识 —— 而 LLM 批次就是用它当编号的。
// 现在同一 key_hash 永远命中同一行、同一个 id；重复扫到不会多出一行。
// 冲突时各列的处置（重要，别改错）：
//   - company/title/salary/city/hr_active/url/salary_* /scanned_at：用新值（扫描结果为准）
//   - raw：**合并**（旧的 || 新的）——扫描对象里没有 llm/greeting 键，合并才不会把 LLM 结果抹掉
//   - score / llm_score：COALESCE 新值，避免「扫描对象不带分数 → 把分数写成 NULL」
//   - greeted / contact_state / status / availability / manual_*：**保持旧值**
//     （这些由发送、复核、关闭检测这些专门流程维护，扫描不该重置人工排除或已联系状态）
export async function saveCandidates(jobs) {
  cancelIdleClose();
  try {
    await ensureSchema();
    const list = listJobs(jobs);
    const conn = await getConnection();
    // 同一 key_hash 在一次批次里出现两次会让 ON CONFLICT 报错（"cannot affect row a second time"），
    // 先按 key_hash 去重，后者覆盖前者（新扫到的数据优先）。
    const byKey = new Map();
    for (const job of list) byKey.set(candidateKeyHash(job), job);
    const unique = [...byKey.values()];
    const preserved = new Set([
      'greeted', 'contact_state', 'status', 'availability',
      'manual_excluded', 'manual_exclusion_reason',
    ]);
    const conflictUpdate = JOB_COLUMNS
      .filter((c) => c !== 'key_hash')
      .map((c) => {
        if (c === 'raw') return 'raw = COALESCE(boss_jobs.raw, \'{}\'::jsonb) || EXCLUDED.raw';
        if (c === 'score' || c === 'llm_score') return `${c} = COALESCE(EXCLUDED.${c}, boss_jobs.${c})`;
        if (preserved.has(c)) return null;
        return `${c} = EXCLUDED.${c}`;
      })
      .filter(Boolean)
      .join(',\n             ');
    try {
      await conn.beginTransaction();
      if (unique.length) {
        await conn.query(
          `INSERT INTO boss_jobs (${JOB_COLUMNS.join(', ')}) VALUES ${buildValuesSql(unique)}
           ON CONFLICT (key_hash) DO UPDATE SET
             ${conflictUpdate},
             updated_at = now()`,
          unique.flatMap(jobRow),
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    writeJson(CANDIDATES_PATH, list);
    return list;
  } finally {
    scheduleIdleClose();
  }
}

// 单条/批量 upsert（extract-first-regression 用），不清空整表。
export async function upsertJobs(jobs) {
  const list = listJobs(jobs);
  if (!list.length) return 0;
  cancelIdleClose();
  try {
    await ensureSchema();
    const updates = JOB_COLUMNS
      .filter((c) => c !== 'key_hash')
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');
    const [res] = await query(
      `INSERT INTO boss_jobs (${JOB_COLUMNS.join(', ')}) VALUES ${buildValuesSql(list)}
       ON CONFLICT (key_hash) DO UPDATE SET ${updates}, updated_at = now()`,
      list.flatMap(jobRow),
    );
    return res.affectedRows;
  } finally {
    scheduleIdleClose();
  }
}

// 语义对齐 mergeJobs(readJson(CANDIDATES_PATH), incoming) + writeJson：库内合并（同 key 字段覆盖）
export async function mergeIntoCandidates(incomingJobs) {
  const existing = await loadCandidates();
  const merged = mergeJobs(existing, incomingJobs);
  await saveCandidates(merged);
  return merged;
}

// 打招呼成功后打标：greeted 列置 1，同时同步进 raw，保证 JSON 备份镜像一致
export async function markCandidatesGreeted(urls, contactState = 'custom_sent') {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return 0;
  cancelIdleClose();
  try {
    await ensureSchema();
    const [res] = await query(
      `UPDATE boss_jobs
          SET greeted = 1,
              contact_state = ?,
              manual_excluded = 0,
              manual_exclusion_reason = '',
              raw = jsonb_set(jsonb_set(jsonb_set(jsonb_set(raw,
                      '{greeted}', to_jsonb(true)),
                      '{contactState}', to_jsonb(?::text)),
                      '{manualExcluded}', to_jsonb(false)),
                      '{manualExclusionReason}', to_jsonb(''::text)),
              updated_at = now()
        WHERE url = ANY(?)`,
      [contactState, contactState, list],
    );
    return res.affectedRows;
  } finally {
    scheduleIdleClose();
  }
}

// 职位已关闭（JOB_CLOSED）的岗位标记出局：status='closed'，发送队列 SQL 排除之。
export async function markJobsClosed(keyHashes) {
  const list = (Array.isArray(keyHashes) ? keyHashes : [keyHashes]).filter(Boolean);
  if (!list.length) return 0;
  cancelIdleClose();
  try {
    await ensureSchema();
    const [res] = await query(
      `UPDATE boss_jobs SET status = 'closed', availability = 'closed', updated_at = now() WHERE key_hash = ANY(?)`,
      [list],
    );
    return res.affectedRows;
  } finally {
    scheduleIdleClose();
  }
}

// 按 key_hash 批量取岗位（单发/点名模式入口，支持一个或多个）
export async function loadCandidatesByKeyHashes(keyHashes) {
  const list = (Array.isArray(keyHashes) ? keyHashes : String(keyHashes || '').split(/[,\s]+/))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!list.length) return [];
  cancelIdleClose();
  try {
    await ensureSchema();
    const [rows] = await query(
      `SELECT key_hash, url, greeted, contact_state, score, status, availability, manual_excluded, manual_exclusion_reason, hr_active, raw FROM boss_jobs WHERE key_hash = ANY(?)`,
      [list],
    );
    return rows.map(mapJobRow);
  } finally {
    scheduleIdleClose();
  }
}

// 单个 key_hash 便捷封装（未命中返回 null）
export async function loadCandidateByKeyHash(keyHash) {
  const jobs = await loadCandidatesByKeyHashes([keyHash]);
  return jobs[0] || null;
}

// ===== 待发队列（PostgreSQL boss_queue）=====
// 原先 data/boss-queue.json / data/boss-queue-<city>.json；现以 queue_name 区分（'all' 或城市名）。
// 队列快照 + 库里最新状态 = 本次真正要发的岗位。
// 队列只决定「发哪些、什么顺序」；**文案和状态一律以库里的行（key_hash 对应）为准**。
// 2026-10-30 修：原来这段只刷新 score/greeted/status，漏了 greeting ——
// 队列是在 LLM 写库之前建的，于是发送时用的还是老模板文案（实测 5/5 条与库里不一致）。
export function hydrateQueueJob(queued = {}, current = null) {
  if (!current) return queued;
  const score = Number(current.score);
  return {
    ...queued,
    ...(Number.isFinite(score) ? { score } : {}),
    greeted: Boolean(current.greeted),
    contactState: current.contactState || queued.contactState,
    availability: current.availability || queued.availability,
    manualExcluded: Boolean(current.manualExcluded),
    manualExclusionReason: current.manualExclusionReason || '',
    status: current.status || queued.status,
    // 文案：库里最新（LLM 可能在入队之后才写）；库里没有才回退到队列快照
    greeting: String(current.greeting || queued.greeting || ''),
    greetingSource: String(current.greetingSource || queued.greetingSource || ''),
    greetingModel: String(current.greetingModel || queued.greetingModel || ''),
    greetingLlmError: String(current.greetingLlmError || ''),
  };
}
export async function saveQueue(name, jobs) {
  const queueName = String(name || 'all');
  // 人工排除 = 用户明确「不发送」，这类岗位一律不进队列（2026-10-30 实测队列里混了 385 条）。
  // 放在这里做统一收口：score / fill / 控制台三条写入路径都经过它。
  const list = listJobs(jobs).filter((job) => !(job?.manualExcluded || job?.manual_excluded));
  cancelIdleClose();
  try {
    await ensureSchema();
    const conn = await getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM boss_queue WHERE queue_name = ?', [queueName]);
      for (const job of list) {
        await conn.query(
          'INSERT INTO boss_queue (queue_name, key_hash, payload) VALUES (?, ?, ?)',
          [queueName, job.key_hash || null, JSON.stringify(job)],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return list;
  } finally {
    scheduleIdleClose();
  }
}

export async function loadQueue(name = 'all') {
  cancelIdleClose();
  try {
    await ensureSchema();
    const [rows] = await query('SELECT payload FROM boss_queue WHERE queue_name = ? ORDER BY id', [String(name || 'all')]);
    return rows.map((r) => parseRawRow(r.payload));
  } finally {
    scheduleIdleClose();
  }
}

// ===== 运行时状态（PostgreSQL boss_runtime_state）=====
// 原先 data/last-scan.txt；现以 state_key 存键值（如 'last_scan_at'）。
export async function getRuntimeState(key) {
  cancelIdleClose();
  try {
    await ensureSchema();
    const [rows] = await query('SELECT value FROM boss_runtime_state WHERE state_key = ?', [String(key)]);
    return rows.length ? rows[0].value : null;
  } finally {
    scheduleIdleClose();
  }
}

export async function setRuntimeState(key, value) {
  cancelIdleClose();
  try {
    await ensureSchema();
    await query(
      `INSERT INTO boss_runtime_state (state_key, value, updated_at) VALUES (?, ?, now())
       ON CONFLICT (state_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [String(key), String(value)],
    );
  } finally {
    scheduleIdleClose();
  }
}
