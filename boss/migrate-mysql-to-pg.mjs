#!/usr/bin/env node
// boss/migrate-mysql-to-pg.mjs — 一次性把 BOSS 的 MySQL 数据迁移到 PostgreSQL
//
// 迁移内容：
//   boss_jobs           岗位池（career_ops.boss_jobs，含 raw JSON）
//   boss_config         操作配置（单行 boss_city_control）
//   boss_sent_log       发送日志（原 data/boss-sent-log.tsv）
//   boss_queue          待发队列（原 data/boss-queue.json / boss-queue-<city>.json）
//   boss_runtime_state  运行时状态（原 data/last-scan.txt）
//
// 幂等：默认目标表非空则跳过该项；--force 先清空再导入。
// 用法：node boss/migrate-mysql-to-pg.mjs [--force]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { PG_CONFIG } from './pg-db.mjs'; // 同时加载 boss/.env.local
import { ensureSchema } from './pg-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FORCE = process.argv.includes('--force');

const MYSQL = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || 'career_ops',
};

const JOB_COLS = [
  'key_hash', 'company', 'title', 'salary', 'city', 'hr_active', 'url', 'greeted',
  'contact_state', 'salary_min', 'salary_max', 'score', 'status', 'availability',
  'manual_excluded', 'manual_exclusion_reason', 'scanned_at', 'raw', 'created_at', 'updated_at',
];
const SENT_COLS = ['sent_date', 'sent_time', 'company', 'title', 'url', 'status', 'message', 'error', 'city'];

function jsonText(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

async function countRows(client, table) {
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

async function insertRows(client, table, cols, rows, { batch = 200 } = {}) {
  const n = cols.length;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const values = [];
    const placeholders = chunk.map((row, ri) => {
      const ph = cols.map((c, ci) => {
        values.push(row[c] === undefined ? null : row[c]);
        return `$${ri * n + ci + 1}`;
      });
      return '(' + ph.join(',') + ')';
    }).join(', ');
    await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders}`, values);
  }
}

function parseSentLog(path) {
  const text = readFileSync(path, 'utf-8');
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (cells, key) => (idx[key] === undefined ? '' : (cells[idx[key]] ?? ''));
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const date = get(cells, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({
      sent_date: date,
      sent_time: get(cells, 'time') || null,
      company: get(cells, 'company'),
      title: get(cells, 'title'),
      url: get(cells, 'url'),
      status: get(cells, 'status'),
      message: get(cells, 'message'),
      error: get(cells, 'error'),
      city: get(cells, 'city'),
    });
  }
  return rows;
}

function parseQueueFile(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function main() {
  const summary = { pg: `${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`, mysql: `${MYSQL.host}:${MYSQL.port}/${MYSQL.database}`, force: FORCE, migrated: {} };

  console.log(`[migrate] MySQL ${summary.mysql} -> PostgreSQL ${summary.pg}`);
  await ensureSchema();

  const my = await mysql.createConnection(MYSQL);
  const client = new pg.Client(PG_CONFIG);
  await client.connect();
  try {
    // ---- boss_jobs ----
    const existingJobs = await countRows(client, 'boss_jobs');
    if (existingJobs > 0 && !FORCE) {
      summary.migrated.boss_jobs = { skipped: true, existing: existingJobs };
    } else {
      const [jobs] = await my.query('SELECT * FROM boss_jobs ORDER BY id');
      if (existingJobs > 0) await client.query('TRUNCATE TABLE boss_jobs RESTART IDENTITY');
      const rows = jobs.map((r) => ({
        key_hash: r.key_hash,
        company: r.company || '',
        title: r.title || '',
        salary: r.salary || '',
        city: r.city || '',
        hr_active: r.hr_active || '',
        url: r.url || '',
        greeted: Number(r.greeted || 0),
        contact_state: r.contact_state || 'never_contacted',
        salary_min: r.salary_min,
        salary_max: r.salary_max,
        score: r.score,
        status: r.status || '',
        availability: r.availability || 'unknown',
        manual_excluded: Number(r.manual_excluded || 0),
        manual_exclusion_reason: r.manual_exclusion_reason || '',
        scanned_at: r.scanned_at || null,
        raw: jsonText(r.raw),
        created_at: r.created_at || null,
        updated_at: r.updated_at || null,
      }));
      await insertRows(client, 'boss_jobs', JOB_COLS, rows);
      summary.migrated.boss_jobs = { inserted: rows.length };
    }

    // ---- boss_config ----
    const [configs] = await my.query('SELECT name, value, updated_at FROM boss_config');
    let cfgCount = 0;
    for (const c of configs) {
      await client.query(
        `INSERT INTO boss_config (name, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [c.name, c.value, c.updated_at || new Date()],
      );
      cfgCount++;
    }
    summary.migrated.boss_config = { upserted: cfgCount };

    // ---- boss_sent_log ----
    const sentPath = join(ROOT, 'data', 'boss-sent-log.tsv');
    const existingSent = await countRows(client, 'boss_sent_log');
    if (!existsSync(sentPath)) {
      summary.migrated.boss_sent_log = { skipped: true, reason: 'no tsv' };
    } else if (existingSent > 0 && !FORCE) {
      summary.migrated.boss_sent_log = { skipped: true, existing: existingSent };
    } else {
      const rows = parseSentLog(sentPath);
      if (existingSent > 0) await client.query('TRUNCATE TABLE boss_sent_log RESTART IDENTITY');
      await insertRows(client, 'boss_sent_log', SENT_COLS, rows);
      summary.migrated.boss_sent_log = { inserted: rows.length };
    }

    // ---- boss_queue ----
    const queueSpecs = [];
    const allQueue = join(ROOT, 'data', 'boss-queue.json');
    if (existsSync(allQueue)) queueSpecs.push({ name: 'all', path: allQueue });
    for (const name of readdirSync(join(ROOT, 'data'))) {
      const m = name.match(/^boss-queue-(.+)\.json$/);
      if (m) queueSpecs.push({ name: m[1], path: join(ROOT, 'data', name) });
    }
    const queueSummary = [];
    for (const spec of queueSpecs) {
      const jobs = parseQueueFile(spec.path);
      const existing = await client.query('SELECT COUNT(*)::int AS n FROM boss_queue WHERE queue_name = $1', [spec.name]);
      if (existing.rows[0].n > 0 && !FORCE) { queueSummary.push({ name: spec.name, skipped: true, existing: existing.rows[0].n }); continue; }
      await client.query('DELETE FROM boss_queue WHERE queue_name = $1', [spec.name]);
      for (const job of jobs) {
        await client.query('INSERT INTO boss_queue (queue_name, key_hash, payload) VALUES ($1, $2, $3::jsonb)', [spec.name, job.key_hash || null, JSON.stringify(job)]);
      }
      queueSummary.push({ name: spec.name, inserted: jobs.length });
    }
    summary.migrated.boss_queue = queueSummary;

    // ---- last-scan ----
    const lastScanPath = join(ROOT, 'data', 'last-scan.txt');
    if (existsSync(lastScanPath)) {
      const value = readFileSync(lastScanPath, 'utf-8').trim();
      if (value) {
        await client.query(
          `INSERT INTO boss_runtime_state (state_key, value, updated_at) VALUES ('last_scan_at', $1, now())
           ON CONFLICT (state_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [value],
        );
        summary.migrated.boss_runtime_state = { last_scan_at: value };
      }
    }

    // ---- 校验 ----
    summary.verify = {
      boss_jobs: await countRows(client, 'boss_jobs'),
      boss_config: await countRows(client, 'boss_config'),
      boss_sent_log: await countRows(client, 'boss_sent_log'),
      boss_queue: await countRows(client, 'boss_queue'),
    };
  } finally {
    await client.end().catch(() => {});
    await my.end().catch(() => {});
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => { console.error('[migrate] failed:', err.message); process.exit(1); });
