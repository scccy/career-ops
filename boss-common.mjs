import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
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
  return `${uniqueJobKey(job)}::${normalizeText(job.url || job.salary || job.city)}`;
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

export function loadSentCompanyKeys({ date = null, sinceDate = '', lookbackDays = null, statuses = ['sent'] } = {}) {
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
  return loadSentCompanyKeys({ date, statuses: ['sent'] }).size;
}

// 按城市统计今日已发送公司数（本地适配：城市配额见 config/profile.yml boss.daily_limit_per_city）
// 城市由发送记录 URL 反查候选池得到（发送日志本身无城市列）；无法匹配的 URL 归入"未知"。
export function countSentCompaniesTodayByCity({ date = todayIso(), urlCity = new Map() } = {}) {
  const byCity = new Map();
  if (!existsSync(SENT_LOG_PATH)) return {};
  const seen = new Set();
  for (const line of readFileSync(SENT_LOG_PATH, 'utf-8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [sentDate, , company, , url, status] = line.split('\t');
    if (sentDate !== date || status !== 'sent') continue;
    const dedupeKey = url || normalizeText(company);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const city = String(urlCity.get(url) || '').split('·')[0] || '未知';
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
