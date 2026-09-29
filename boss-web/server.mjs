// boss-web/server.mjs — BOSS 直聘流程操作控制台：实时概览 + 候选池检索 + 白名单命令执行
// 复用项目 node_modules 的 mysql2 / js-yaml；连接参数与 boss-common.mjs 保持一致（MYSQL_* 可覆盖）。
// 用法：node boss-web/server.mjs  →  浏览器打开 http://127.0.0.1:4173

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import * as yaml from 'js-yaml';
import { loadBossControl, saveBossControl } from '../boss-config-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BOSS_DASHBOARD_PORT || 4173);
const ROOT = join(__dirname, '..');
const SENT_LOG = join(ROOT, 'data', 'boss-sent-log.tsv');
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
  };
}

// ---- 写回 boss 配置到数据库（阈值 / 每城配额 / 关键词）----
// 前端每次提交完整的 daily_limit_per_city 映射，与 DB 现有值合并后整体覆盖，天然支持「移除城市」。
async function saveBossConfig(body = {}) {
  const { send_threshold, daily_limit_per_city, daily_extract_queries, daily_extract_keywords_by_city, platform_daily_limit } = body;
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
  await saveBossControl(partial);
  return loadBossConfig();
}

const DB = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '***REMOVED***',
  database: process.env.MYSQL_DB || 'career_ops',
  connectionLimit: 5,
  connectTimeout: 4000,
};
const pool = mysql.createPool(DB);

async function q(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// ---- 今日各城市已发送公司数（来自发送日志，URL 反查候选池城市） ----
// URL 指纹：只取 pathname（job_detail/<id>.html）。BOSS 每次扫描同一岗位都换
// 新 securityId，用完整 URL 匹配会让重扫后历史发送记录对不上城市（少算配额）。
function urlPathname(u) {
  const s = String(u || '');
  if (!s) return '';
  try { return new URL(s).pathname; } catch { return s; }
}

function countTodayByCity() {
  const today = new Date().toISOString().slice(0, 10);
  const result = { todaySent: 0, byCity: {} };
  if (!existsSync(SENT_LOG)) return result;
  const lines = readFileSync(SENT_LOG, 'utf-8').split('\n').slice(1);
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [date, , company, , url, status] = line.split('\t');
    if (date !== today) continue;
    if (status !== 'sent' && status !== 'auto_sent') continue;
    const key = url || (company || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.todaySent++;
  }
  return result;
}

async function getOverview() {
  const cfg = await loadBossConfig();
  const thr = cfg.threshold;
  const totalRows = await q('SELECT COUNT(*) AS n FROM boss_jobs');
  const greetedRows = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE greeted=1');
  const scoredRows = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE score IS NOT NULL');
  const pendingRows = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE greeted=0 AND score>=?', [thr]);
  const total = Number(totalRows[0].n);
  const greeted = Number(greetedRows[0].n);
  const scored = Number(scoredRows[0].n);
  const pending = Number(pendingRows[0].n);

  const cities = await q(
    `SELECT city,
            COUNT(*) AS total,
            SUM(greeted=1) AS greeted,
            SUM(greeted=0 AND score>=?) AS pending
     FROM boss_jobs GROUP BY city`,
    [thr],
  );

  const urlRows = await q("SELECT url, city FROM boss_jobs WHERE url<>''");
  const urlCity = new Map(urlRows.map((r) => [urlPathname(r.url), String(r.city || '').split('·')[0]]));
  const todayInfo = countTodayByCity();
  const byCity = {};
  if (existsSync(SENT_LOG)) {
    const lines = readFileSync(SENT_LOG, 'utf-8').split('\n').slice(1);
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      const [date, , company, , url, status] = line.split('\t');
      if (date !== today || (status !== 'sent' && status !== 'auto_sent')) continue;
      const key = (url && urlPathname(url)) || (company || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const city = (url && urlCity.get(urlPathname(url))) || '未知';
      byCity[city] = (byCity[city] || 0) + 1;
    }
  }

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
      keywordsCustom,
      keywords: perCityKw,
    };
  });

  const unknownCitySent = (byCity['未知'] || 0);
  const cityRows = await q('SELECT city, COUNT(*) AS n FROM boss_jobs GROUP BY city ORDER BY n DESC');
  const salRows = await q('SELECT MIN(salary_min) AS lo, MAX(salary_max) AS hi FROM boss_jobs');

  // BOSS 平台级每日上限：可选开关（0=不启用，用户自行用城市配额管理/会员解除）
  const platformLimit = cfg.platformDailyLimit || 0;
  const platformSentToday = Object.values(byCity).reduce((s, n) => s + n, 0);
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
    total: total,
    greeted: greeted,
    notGreeted: total - greeted,
    scored: scored,
    unscored: total - scored,
    pending: pending,
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
function buildJobFilter(f) {
  const where = [];
  const args = [];
  if (f.city) { where.push('city = ?'); args.push(f.city); }
  // 薪资区间按"重叠"匹配：岗位最高薪 ≥ 下限 且 最低薪 ≤ 上限
  if (f.salaryMin !== '' && f.salaryMin != null && Number.isFinite(Number(f.salaryMin))) {
    where.push('salary_max >= ?'); args.push(Number(f.salaryMin));
  }
  if (f.salaryMax !== '' && f.salaryMax != null && Number.isFinite(Number(f.salaryMax))) {
    where.push('salary_min <= ?'); args.push(Number(f.salaryMax));
  }
  if (f.greeted === '0' || f.greeted === '1') { where.push('greeted = ?'); args.push(Number(f.greeted)); }
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
  const page = Math.max(1, Number(sp.get('page') || 1));
  const pageSize = Math.min(200, Math.max(1, Number(sp.get('pageSize') || 20)));
  const f = {
    city: String(sp.get('city') || '').trim(),
    salaryMin: sp.get('salaryMin'),
    salaryMax: sp.get('salaryMax'),
    greeted: String(sp.get('greeted') || ''),
    scored: String(sp.get('scored') || ''),
    minScore: sp.get('minScore'),
    keyword: String(sp.get('keyword') || '').trim(),
  };
  const sort = String(sp.get('sort') || 'score_desc');

  const { whereSql, args } = buildJobFilter(f);
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
    `SELECT key_hash, company, title, salary, salary_min, salary_max, city, url, greeted, score, status, scanned_at
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
      score: r.score == null ? null : Number(r.score),
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

function startRun(key) {
  const cmd = RUN_ALLOWED[key];
  const job = { id: ++runSeq, key, cmd, status: 'running', output: '', code: null, startedAt: Date.now(), endedAt: null, proc: null };
  RUN_JOBS.set(job.id, job);
  runningId = job.id;
  // 用登录 shell 启动，保证 PATH 与用户终端一致（否则 node 可能落到别的版本，
  // 如 WorkBuddy 内置 v22 在此沙箱下会 WebAssembly.instantiate(): Out of memory）。
  // 同时把服务自身的 node 目录前置到 PATH 兜底。
  // detached: 独立进程组 —— 终止时才能整组杀掉（否则只杀 bash 外壳，
  // extract/node/npm 子进程照跑，任务状态永远 running=「终止失败」）。
  const nodeDir = dirname(process.execPath);
  const proc = spawn('/bin/bash', ['-lc', cmd], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH || ''}` },
    detached: true,
  });
  job.proc = proc;
  const push = (t) => { job.output += t; if (job.output.length > 120000) job.output = job.output.slice(-120000); };
  proc.stdout.on('data', (d) => push(d.toString()));
  proc.stderr.on('data', (d) => push(d.toString()));
  const timer = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } } }, 20 * 60 * 1000);
  const finish = (status, code) => {
    clearTimeout(timer);
    job.status = status; job.code = code; job.endedAt = Date.now();
    if (runningId === job.id) runningId = null;
  };
  proc.on('close', (code) => finish(code === 0 ? 'done' : 'failed', code));
  proc.on('error', (e) => { push('\n[spawn error] ' + e.message + '\n'); finish('failed', -1); });
  return job;
}

// 整组终止：先 SIGTERM 进程组（-pid），3 秒后仍在则 SIGKILL 兜底。
// 只杀 bash 外壳时 extract/node/npm 子进程会变成孤儿继续跑，任务状态永远 running。
function killRunJob(job) {
  if (!job || !job.proc || job.status !== 'running') return false;
  const pid = job.proc.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { job.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  setTimeout(() => {
    if (job.status !== 'running') return;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
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

    // ---- 批量操作：标记已发(greeted=1) / 删除（keyHashes 或 filter 指定范围）----
    if (url.pathname === '/api/jobs/bulk' && req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      if (action !== 'mark_greeted' && action !== 'delete') {
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
        target = buildJobFilter(body.filter);
        if (!target.whereSql) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'filter 为空，禁止对全表执行' }));
        }
      } else {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '需提供 keyHashes 或 filter' }));
      }
      try {
        const r = action === 'mark_greeted'
          ? await q('UPDATE boss_jobs SET greeted=1 ' + target.whereSql, target.args)
          : await q('DELETE FROM boss_jobs ' + target.whereSql, target.args);
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
        const rows = await q(
          'SELECT key_hash, url, greeted, raw FROM boss_jobs WHERE city=? AND greeted=0 AND score>=? AND (status IS NULL OR status <> ?) ORDER BY score DESC',
          [city, cfg.threshold, 'closed'],
        );
        if (!rows.length) return json({ ok: false, error: `${city} 没有「待发」岗位（greeted=0 且 score≥${cfg.threshold}）` }, 400);
        const jobs = rows.map((r) => {
          const job = typeof r.raw === 'string' ? JSON.parse(r.raw) : r.raw;
          if (r.url) job.url = r.url;
          job.greeted = Boolean(r.greeted);
          if (r.key_hash) job.key_hash = r.key_hash;
          return job;
        });
        mkdirSync(join(ROOT, 'data'), { recursive: true });
        const rel = `data/boss-queue-${city}.json`;
        writeFileSync(join(ROOT, rel), JSON.stringify(jobs, null, 2), 'utf-8');
        const cmd = `npm run boss:chrome:apply -- --input ${rel} --threshold ${cfg.threshold} --confirmed-review && node merge-tracker.mjs`;
        if (body.confirm !== true) {
          return json({ ok: false, needConfirm: true, cmd, count: jobs.length,
            message: `已生成 ${city} 临时队列（${jobs.length} 个待发岗位），将按该城当日剩余配额真实发送。` }, 409);
        }
        if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
        RUN_ALLOWED[key] = cmd;
        RUN_TIER[key] = 'confirm';
        return json({ ok: true, job: publicJob(startRun(key)), note: `临时队列已写入 ${rel}` });
      }

      // 动态命令：单城一键准备 = ②扫描该城全部关键词 → ③评分 → ④排队（除发送外全部自动完成，发送仍是人工检查点）。
      // extract 加 --city 只跑该城，不影响其他城；评分/排队为全局步骤。关键词量由每城词表自行控制。
      if (key === 'scan_city') {
        const city = String(body.city || '').trim();
        if (!city) return json({ ok: false, error: '缺少城市' }, 400);
        if (!/^[一-龥A-Za-z0-9·\-]{1,20}$/.test(city)) return json({ ok: false, error: `城市名非法：${city}` }, 400);
        if (runningId !== null) return json({ ok: false, busy: true, error: '已有任务在运行，请先等待或终止' }, 409);
        try { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(LAST_SCAN_FILE, new Date().toISOString()); } catch { /* ignore */ }
        const cmd = `bash boss-extract-3cities.sh --city "${city}" --all && npm run boss:score && npm run boss:fill -- --prepare`;
        RUN_ALLOWED[key] = cmd;
        RUN_TIER[key] = 'safe';
        return json({ ok: true, job: publicJob(startRun(key)), note: `一键准备：扫描 ${city} 全部关键词 → 评分 → 排队（不影响其他城市，完成后可直接发送/发新扫）` });
      }

      // 动态命令：发新扫——只发「最近一次扫描才开始出现」的岗位（greeted=0 且 score≥阈值，时间降序；走单城临时队列）
      if (key === 'send_city_new') {
        const city = String(body.city || '').trim();
        if (!city) return json({ ok: false, error: '缺少城市' }, 400);
        if (!/^[一-龥A-Za-z0-9·\-]{1,20}$/.test(city)) return json({ ok: false, error: `城市名非法：${city}` }, 400);
        const cfg = await loadBossConfig();
        const last = getLastScanAt();
        if (!last) return json({ ok: false, error: '尚未执行过扫描，无法确定「新扫描」范围。请先扫描此城。' }, 400);
        let sql = 'SELECT key_hash, url, greeted, raw FROM boss_jobs WHERE city=? AND greeted=0 AND score>=? AND (status IS NULL OR status <> ?) AND scanned_at >= ? ORDER BY scanned_at DESC';
        const args = [city, cfg.threshold, 'closed', last];
        const rows = await q(sql, args);
        if (!rows.length) {
          // 新扫描岗位可能尚未评分（score NULL 会被 ≥阈值 过滤），给出可执行的下一步
          let hint = '';
          const [uns] = await q(
            'SELECT COUNT(*) AS n FROM boss_jobs WHERE city=? AND greeted=0 AND score IS NULL AND scanned_at >= ?',
            [city, last],
          );
          if (uns.n > 0) hint = `检测到 ${city} 有 ${uns.n} 条新扫描岗位尚未评分，请先执行主流程③评分（boss:score）再发新扫。`;
          return json({ ok: false, error: `${city} 没有符合条件的待发岗位（greeted=0 且 score≥${cfg.threshold} 且为最近扫描新增）${hint}` }, 400);
        }
        const jobs = rows.map((r) => {
          const job = typeof r.raw === 'string' ? JSON.parse(r.raw) : r.raw;
          if (r.url) job.url = r.url;
          job.greeted = Boolean(r.greeted);
          if (r.key_hash) job.key_hash = r.key_hash;
          return job;
        });
        mkdirSync(join(ROOT, 'data'), { recursive: true });
        const rel = `data/boss-queue-${city}.json`;
        writeFileSync(join(ROOT, rel), JSON.stringify(jobs, null, 2), 'utf-8');
        const cmd = `npm run boss:chrome:apply -- --input ${rel} --threshold ${cfg.threshold} --confirmed-review && node merge-tracker.mjs`;
        if (body.confirm !== true) {
          return json({ ok: false, needConfirm: true, cmd, count: jobs.length,
            message: `已生成 ${city} 临时队列（${jobs.length} 个待发岗位），只发最近扫描新增、按时间降序真实发送。` }, 409);
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
      return json({ ok: true, job: publicJob(startRun(key)) });
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
