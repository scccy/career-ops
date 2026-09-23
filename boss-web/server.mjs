// boss-web/server.mjs — BOSS 直聘流程可视化：实时概览 + key_hash 查询
// 复用项目 node_modules 的 mysql2 / js-yaml；连接参数与 boss-common.mjs 保持一致（MYSQL_* 可覆盖）。
// 用法：node boss-web/server.mjs  →  浏览器打开 http://127.0.0.1:4173

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';
import * as yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BOSS_DASHBOARD_PORT || 4173);
const ROOT = join(__dirname, '..');
const SENT_LOG = join(ROOT, 'data', 'boss-sent-log.tsv');
const HTML_PATH = join(__dirname, 'index.html');

// ---- 读取 boss 配置（阈值 / 每城配额），与 config/profile.yml 同步 ----
function loadBossConfig() {
  const fallback = {
    threshold: 3.0,
    dailyLimitPerCity: { 上海: 20, 杭州: 40, 南京: 20, 无锡: 20, 常州: 20 },
  };
  try {
    const raw = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8');
    const cfg = yaml.load(raw) || {};
    const boss = cfg.boss || {};
    return {
      threshold: Number(boss.send_threshold) || fallback.threshold,
      dailyLimitPerCity: boss.daily_limit_per_city || fallback.dailyLimitPerCity,
      greetingStyle: boss.greeting_style || '',
    };
  } catch {
    return fallback;
  }
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
function countTodayByCity(threshold) {
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
  const cfg = loadBossConfig();
  const thr = cfg.threshold;
  const [totalR] = await q('SELECT COUNT(*) AS n FROM boss_jobs');
  const [greetedR] = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE greeted=1');
  const [scoredR] = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE score IS NOT NULL');
  const [pendingR] = await q('SELECT COUNT(*) AS n FROM boss_jobs WHERE greeted=0 AND score>=?', [thr]);

  const cities = await q(
    `SELECT city,
            COUNT(*) AS total,
            SUM(greeted=1) AS greeted,
            SUM(greeted=0 AND score>=?) AS pending
     FROM boss_jobs GROUP BY city`,
    [thr],
  );

  // URL → 城市前缀，反查今日发送日志的城市分布
  const urlRows = await q("SELECT url, city FROM boss_jobs WHERE url<>''");
  const urlCity = new Map(urlRows.map((r) => [r.url, String(r.city || '').split('·')[0]]));
  const todayInfo = countTodayByCity(thr);
  const byCity = {};
  if (existsSync(SENT_LOG)) {
    const lines = readFileSync(SENT_LOG, 'utf-8').split('\n').slice(1);
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      const [date, , company, , url, status] = line.split('\t');
      if (date !== today || (status !== 'sent' && status !== 'auto_sent')) continue;
      const key = url || (company || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const city = (url && urlCity.get(url)) || '未知';
      byCity[city] = (byCity[city] || 0) + 1;
    }
  }

  const quotaData = Object.entries(cfg.dailyLimitPerCity).map(([city, quota]) => {
    const row = cities.find((c) => String(c.city).split('·')[0] === city) || { total: 0, greeted: 0, pending: 0 };
    const sentToday = byCity[city] || 0;
    return {
      city,
      quota,
      sentToday,
      remaining: Math.max(0, quota - sentToday),
      poolTotal: Number(row.total || 0),
      poolPending: Number(row.pending || 0),
    };
  });

  const unknownCitySent = (byCity['未知'] || 0);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    threshold: thr,
    greetingStyle: cfg.greetingStyle,
    total: Number(totalR[0].n),
    greeted: Number(greetedR[0].n),
    notGreeted: Number(totalR[0].n) - Number(greetedR[0].n),
    scored: Number(scoredR[0].n),
    unscored: Number(totalR[0].n) - Number(scoredR[0].n),
    pending: Number(pendingR[0].n),
    todaySent: todayInfo.todaySent,
    unknownCitySent,
    quota: quotaData,
  };
}

async function getByKeyHashes(raw) {
  const list = String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return { ok: false, error: '请提供至少一个 key_hash' };
  const [rows] = await q(
    `SELECT key_hash, company, title, salary, city, url, greeted, score, status
     FROM boss_jobs WHERE key_hash IN (?)`,
    [list],
  );
  const matched = rows.map((r) => ({
    key_hash: r.key_hash,
    company: r.company,
    title: r.title,
    salary: r.salary,
    city: r.city,
    url: r.url,
    greeted: Boolean(r.greeted),
    score: r.score,
    status: r.status,
  }));
  const missing = list.filter((h) => !matched.some((m) => m.key_hash === h));
  const sendable = matched.filter((m) => !m.greeted);
  const cmd = `npm run boss:send:one -- --key-hash ${list.join(',')}`;
  return { ok: true, queried: list.length, matched, missing, sendable, cmd };
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
    if (url.pathname === '/api/keyhash') {
      const data = await getByKeyHashes(url.searchParams.get('h'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(data));
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
  console.log(`BOSS 流程可视化已启动: http://127.0.0.1:${PORT}`);
  console.log(`MySQL: ${DB.host}:${DB.port}/${DB.database}  user=${DB.user}`);
});
