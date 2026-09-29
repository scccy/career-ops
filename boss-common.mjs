import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, normalize } from 'path';
import { createHash } from 'crypto';
import mysql from 'mysql2/promise';
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

export function uniqueJobKey(job) {
  return `${normalizeText(job.company)}::${normalizeText(job.title)}`;
}

export function uniqueCandidateKey(job) {
  // 公司+岗位名 = 岗位唯一身份。URL 不参与：BOSS 每次扫描同一岗位都会带新的
  // securityId 查询参数，旧键含 URL 导致同一岗位每次扫描都算新哈希、重复入库
  // （2026-09-29 实测 245 组 745 行重复）。且发送日志去重 loadSentKeys 本就是
  // company::title，两处键保持一致。
  return uniqueJobKey(job);
}

export function uniqueCompanyKey(job) {
  return normalizeText(job.company || job.url || job.title);
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

export function loadSentKeys({ date = null, sinceDate = '', lookbackDays = null, statuses = ['sent'] } = {}) {
  const keys = new Set();
  if (!existsSync(SENT_LOG_PATH)) return keys;
  const allowedStatuses = new Set(statuses);
  const minDate = sinceDate || (lookbackDays == null ? '' : daysAgoIso(lookbackDays));
  for (const line of readFileSync(SENT_LOG_PATH, 'utf-8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [sentDate, , company, title, , status] = line.split('\t');
    if (date && sentDate !== date) continue;
    if (minDate && sentDate < minDate) continue;
    if (allowedStatuses.size && !allowedStatuses.has(status)) continue;
    if (company && title) keys.add(`${normalizeText(company)}::${normalizeText(title)}`);
  }
  return keys;
}

// auto_sent = 继续沟通场景下 BOSS 自动发送的默认打招呼语（真实联系已建立，计入配额与去重）
export function loadSentCompanyKeys({ date = null, sinceDate = '', lookbackDays = null, statuses = ['sent', 'auto_sent'] } = {}) {
  const keys = new Set();
  if (!existsSync(SENT_LOG_PATH)) return keys;
  const allowedStatuses = new Set(statuses);
  const minDate = sinceDate || (lookbackDays == null ? '' : daysAgoIso(lookbackDays));
  for (const line of readFileSync(SENT_LOG_PATH, 'utf-8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [sentDate, , company, , , status] = line.split('\t');
    if (date && sentDate !== date) continue;
    if (minDate && sentDate < minDate) continue;
    if (allowedStatuses.size && !allowedStatuses.has(status)) continue;
    if (company) keys.add(normalizeText(company));
  }
  return keys;
}

export function countSentToday(date = todayIso()) {
  if (!existsSync(SENT_LOG_PATH)) return 0;
  let count = 0;
  for (const line of readFileSync(SENT_LOG_PATH, 'utf-8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [sentDate, , , , , status] = line.split('\t');
    if (sentDate === date && status === 'sent') count++;
  }
  return count;
}

export function countSentCompaniesToday(date = todayIso()) {
  return loadSentCompanyKeys({ date, statuses: ['sent', 'auto_sent'] }).size;
}

// 按城市统计今日已发送公司数（本地适配：城市配额见 config/profile.yml boss.daily_limit_per_city）
// 城市由发送记录 URL 反查候选池得到（发送日志本身无城市列）；无法匹配的 URL 归入"未知"。
// URL 指纹：只取 pathname（job_detail/<id>.html），剥掉 query。
// BOSS 每次扫描同一岗位都换新 securityId，若用完整 URL 匹配，重扫后
// 发送日志里的历史 URL 就对不上池子，按城配额扣减会失灵（#2026-09-29）。
export function urlPathname(url) {
  const s = String(url || '');
  if (!s) return '';
  try { return new URL(s).pathname; } catch { return s; }
}

export function countSentCompaniesTodayByCity({ date = todayIso(), urlCity = new Map() } = {}) {
  const byCity = new Map();
  if (!existsSync(SENT_LOG_PATH)) return {};
  const seen = new Set();
  const countedStatuses = new Set(['sent', 'auto_sent']);
  for (const line of readFileSync(SENT_LOG_PATH, 'utf-8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [sentDate, , company, , url, status] = line.split('\t');
    if (sentDate !== date || !countedStatuses.has(status)) continue;
    const path = urlPathname(url);
    const dedupeKey = path || normalizeText(company);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const city = String(urlCity.get(path) || '').split('·')[0] || '未知';
    if (!byCity.has(city)) byCity.set(city, new Set());
    byCity.get(city).add(normalizeText(company));
  }
  return Object.fromEntries([...byCity].map(([city, keys]) => [city, keys.size]));
}

export function appendSentLog({ job, status, message = '', error = '' }) {
  mkdirSync(ROOT_DATA_DIR, { recursive: true });
  if (!existsSync(SENT_LOG_PATH)) {
    writeFileSync(SENT_LOG_PATH, 'date\ttime\tcompany\ttitle\turl\tstatus\tmessage\terror\n', 'utf-8');
  }
  const now = new Date();
  const row = [
    now.toISOString().slice(0, 10),
    now.toTimeString().slice(0, 8),
    job.company || '',
    job.title || '',
    job.url || '',
    status,
    String(message).replace(/\s+/g, ' '),
    String(error).replace(/\s+/g, ' '),
  ].join('\t');
  appendFileSync(SENT_LOG_PATH, `${row}\n`, 'utf-8');
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

// ===== MySQL 候选池（career_ops.boss_jobs）=====
// 2026-09-23 用户确认：职位池一步到位迁 MySQL，data/boss-candidates.json 降级为每次写入时的备份镜像。
// 消费方：loadCandidates / saveCandidates / mergeIntoCandidates / isCandidatesPath。
// 连接参数可用环境变量覆盖：MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DB。

const DB_NAME = process.env.MYSQL_DB || 'career_ops';
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'asdsc88-+Q12',
  connectionLimit: 5,
  waitForConnections: true,
};
const BOSS_JOBS_TABLE = '`' + DB_NAME + '`.`boss_jobs`';

let _dbPool = null;
function dbPool() {
  if (!_dbPool) _dbPool = mysql.createPool(DB_CONFIG);
  return _dbPool;
}

export function isCandidatesPath(p) {
  return normalize(String(p || '')) === normalize(CANDIDATES_PATH);
}

export function candidateKeyHash(job) {
  return createHash('sha256').update(uniqueCandidateKey(job)).digest('hex');
}

const BOSS_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS ${'`' + DB_NAME + '`.`boss_jobs`'} (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  key_hash CHAR(64) NOT NULL UNIQUE,
  company VARCHAR(191) DEFAULT '',
  title VARCHAR(255) DEFAULT '',
  salary VARCHAR(128) DEFAULT '',
  city VARCHAR(128) DEFAULT '',
  url VARCHAR(768) DEFAULT '',
  greeted TINYINT(1) DEFAULT 0,
  salary_min DECIMAL(6,2) NULL,
  salary_max DECIMAL(6,2) NULL,
  score DECIMAL(4,2) NULL,
  status VARCHAR(32) DEFAULT '',
  scanned_at DATETIME(3) NULL,
  raw JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_city_score (city, score),
  INDEX idx_company (company),
  INDEX idx_greeted (greeted),
  INDEX idx_salary (salary_min, salary_max),
  INDEX idx_scanned (scanned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`;

let _schemaReady = null;
let _idleTimer = null;

// 薪资解析：K 月薪 → {min,max}（单位 K/月）；日结/时薪/面议等非 K 格式 → {min:null,max:null}
// 覆盖："15-22K"、"15-30K·14薪"、"20-40K.16薪"、大小写 K
// 薪资列解析：仅接受 K/千 月薪格式 → {min,max}（单位 K/月）；日结/时薪/月结数字/面议 → {min:null,max:null}
// （复用 parseSalaryRange 的解析能力，但加单位守卫：防止 "180-200元/天" 被误读成 180-200K）
export function parseSalaryMinMax(salary) {
  const text = String(salary || '');
  if (/元\/(天|时|月)/.test(text) || /面议/.test(text)) return { min: null, max: null };
  const parsed = parseSalaryRange(text);
  if (!parsed) return { min: null, max: null };
  return { min: Math.min(parsed.min, parsed.max), max: Math.max(parsed.min, parsed.max) };
}
// CLI 脚本跑完 main 后需自然退出：连接池空闲 5s 后自动关闭，否则挂起的 socket 会让进程永不退出
function cancelIdleClose() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}
function scheduleIdleClose() {
  cancelIdleClose();
  _idleTimer = setTimeout(async () => {
    _idleTimer = null;
    const pool = _dbPool;
    _dbPool = null;
    _schemaReady = null;
    if (pool) { try { await pool.end(); } catch { /* 退出阶段忽略 */ } }
  }, 5000);
}
function schemaReady() {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const pool = dbPool();
      // 连接串不带 database，先建库再建表（首次冷启动也能跑）
      await pool.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
      await pool.query(BOSS_JOBS_DDL);
      // 存量表列迁移：缺 url / greeted 列时补列 + 从 raw 回填（历史表升级路径）
      const [cols] = await pool.query(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'boss_jobs'`,
        [DB_NAME],
      );
      const colNames = new Set(cols.map((c) => c.name));
      const added = [];
      if (!colNames.has('url')) {
        await pool.query(`ALTER TABLE ${BOSS_JOBS_TABLE} ADD COLUMN url VARCHAR(768) DEFAULT '' AFTER city`);
        added.push('url');
      }
      if (!colNames.has('greeted')) {
        await pool.query(`ALTER TABLE ${BOSS_JOBS_TABLE} ADD COLUMN greeted TINYINT(1) DEFAULT 0 AFTER url`);
        added.push('greeted');
      }
      if (!colNames.has('salary_min') || !colNames.has('salary_max')) {
        if (!colNames.has('salary_min')) await pool.query(`ALTER TABLE ${BOSS_JOBS_TABLE} ADD COLUMN salary_min DECIMAL(6,2) NULL AFTER greeted`);
        if (!colNames.has('salary_max')) await pool.query(`ALTER TABLE ${BOSS_JOBS_TABLE} ADD COLUMN salary_max DECIMAL(6,2) NULL AFTER salary_min`);
        added.push('salary_min/salary_max');
      }
      if (added.length) {
        await pool.query(`ALTER TABLE ${BOSS_JOBS_TABLE} ADD INDEX idx_greeted (greeted)`).catch(() => {});
        if (added.includes('salary_min/salary_max')) {
          await pool.query(`ALTER TABLE ${BOSS_JOBS_TABLE} ADD INDEX idx_salary (salary_min, salary_max)`).catch(() => {});
          // 薪资解析依赖 JS 正则，逐行回填（仅 K 月薪格式；日结/时薪/面议存 NULL）
          const [salaryRows] = await pool.query(`SELECT id, salary FROM ${BOSS_JOBS_TABLE}`);
          for (const row of salaryRows) {
            const { min, max } = parseSalaryMinMax(row.salary);
            if (min === null) continue;
            await pool.query(`UPDATE ${BOSS_JOBS_TABLE} SET salary_min = ?, salary_max = ? WHERE id = ?`, [min, max, row.id]);
          }
        }
        await pool.query(
          `UPDATE ${BOSS_JOBS_TABLE}
             SET url = COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw, '$.url')), ''),
                 greeted = IF(IFNULL(JSON_EXTRACT(raw, '$.greeted'), 0) OR IFNULL(JSON_EXTRACT(raw, '$.already_contacted'), 0), 1, 0)
           WHERE url = '' OR url IS NULL`,
        );
        console.error(`[boss-db] boss_jobs 补列: ${added.join(', ')}（已从 raw 回填）`);
      }
    })().catch((err) => { _schemaReady = null; throw err; });
  }
  return _schemaReady;
}

function parseRawRow(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// 行 → 岗位对象：url / greeted / key_hash 独立列是权威字段，覆盖回 raw 对象
function mapJobRow(r) {
  const job = parseRawRow(r.raw);
  if (r.url) job.url = r.url;
  job.greeted = Boolean(r.greeted);
  if (r.key_hash) job.key_hash = r.key_hash;
  return job;
}

export async function loadCandidates() {
  cancelIdleClose();
  try {
    await schemaReady();
    const pool = dbPool();
    const [rows] = await pool.query(`SELECT key_hash, url, greeted, raw FROM ${BOSS_JOBS_TABLE} ORDER BY id`);
    if (rows.length === 0 && existsSync(CANDIDATES_PATH)) {
      // 一次性迁移：库空且存在旧 JSON 池 → 导入后返回
      const legacy = readJson(CANDIDATES_PATH, []);
      if (legacy.length) {
        await saveCandidates(legacy);
        console.error(`[boss-db] 已从 ${CANDIDATES_PATH} 迁移 ${legacy.length} 条到 MySQL ${DB_NAME}.boss_jobs`);
        return legacy;
      }
    }
    // url / greeted 独立列是权威字段：读取时覆盖回 raw 对象
    return rows.map(mapJobRow);
  } finally {
    scheduleIdleClose();
  }
}

function jobRow(job) {
  const scanned = job.scanned_at ? new Date(job.scanned_at) : null;
  const scoreNum = Number(job.score);
  // city 列存城市前缀（"杭州·滨江区·长河" → "杭州"）方便精确搜索；raw 里保留完整串
  const cityPrefix = String(job.city || job.location || '').split('·')[0].slice(0, 120);
  const { min: salaryMin, max: salaryMax } = parseSalaryMinMax(job.salary);
  return [
    candidateKeyHash(job),
    String(job.company || '').slice(0, 190),
    String(job.title || '').slice(0, 250),
    String(job.salary || '').slice(0, 120),
    cityPrefix,
    String(job.url || '').slice(0, 760),
    job.greeted ? 1 : 0,
    salaryMin,
    salaryMax,
    job.score !== undefined && job.score !== null && job.score !== '' && Number.isFinite(scoreNum) ? scoreNum : null,
    String(job.status || '').slice(0, 30),
    scanned && !Number.isNaN(scanned.getTime()) ? scanned : null,
    JSON.stringify(job),
  ];
}

// 语义对齐原 writeJson(CANDIDATES_PATH, jobs)：整池重写；同时落 JSON 备份镜像
export async function saveCandidates(jobs) {
  cancelIdleClose();
  try {
    await schemaReady();
    const pool = dbPool();
    const list = listJobs(jobs);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`TRUNCATE TABLE ${BOSS_JOBS_TABLE}`);
      if (list.length) {
        const values = list.map(jobRow);
        await conn.query(
          `INSERT INTO ${BOSS_JOBS_TABLE} (key_hash, company, title, salary, city, url, greeted, salary_min, salary_max, score, status, scanned_at, raw) VALUES ?`,
          [values],
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

// 语义对齐 mergeJobs(readJson(CANDIDATES_PATH), incoming) + writeJson：库内合并（同 key 字段覆盖）
export async function mergeIntoCandidates(incomingJobs) {
  const existing = await loadCandidates();
  const merged = mergeJobs(existing, incomingJobs);
  await saveCandidates(merged);
  return merged;
}

// 打招呼成功后打标：greeted 列置 1，同时同步进 raw，保证 JSON 备份镜像一致
export async function markCandidatesGreeted(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return 0;
  cancelIdleClose();
  try {
    await schemaReady();
    const pool = dbPool();
    const [res] = await pool.query(
      `UPDATE ${BOSS_JOBS_TABLE}
          SET greeted = 1,
              raw = JSON_SET(raw, '$.greeted', CAST('true' AS JSON))
        WHERE url IN (?)`,
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
    await schemaReady();
    const pool = dbPool();
    const [rows] = await pool.query(
      `SELECT key_hash, url, greeted, raw FROM ${BOSS_JOBS_TABLE} WHERE key_hash IN (?)`,
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
