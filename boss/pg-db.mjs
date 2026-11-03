// boss/pg-db.mjs — BOSS 流程 PostgreSQL 访问层（MySQL→PG 迁移后唯一数据库）
//
// 设计（2026-10 迁移）：
//   - BOSS 控制台与全部 boss 脚本的数据面统一走 PostgreSQL（库名默认 career_ops）。
//   - 连接参数：PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE（也接受 POSTGRES_* 别名）。
//   - 本地凭据放在 boss/.env.local（gitignored），本模块在启动时自动读取，只填充尚未设置的变量。
//   - 提供 mysql2 风格的 query/getConnection 门面：`?` 占位符按顺序转成 `$1..$n`，
//     返回值形状保持 `[rows]`（SELECT）与 `[{ affectedRows }]`（写操作），把迁移改动降到最小。
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 从 boss/.env.local 读取本地凭据（gitignored，不随仓库分发）。仅填充尚未设置的变量。
function loadEnvLocal() {
  const p = join(__dirname, '.env.local');
  if (!existsSync(p)) return;
  for (const rawLine of readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
loadEnvLocal();

function pick(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

export const PG_CONFIG = {
  host: pick('PGHOST', 'POSTGRES_HOST') || '127.0.0.1',
  port: Number(pick('PGPORT', 'POSTGRES_PORT') || 5432),
  user: pick('PGUSER', 'POSTGRES_USER') || 'root',
  password: pick('PGPASSWORD', 'POSTGRES_PASSWORD') || '',
  database: pick('PGDATABASE', 'POSTGRES_DB') || 'career_ops',
};

let _pool = null;
let _idleTimer = null;

export function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      ...PG_CONFIG,
      max: 5,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 10000,
    });
    _pool.on('error', () => { /* 空闲连接断开时忽略，下次查询自动重连 */ });
  }
  return _pool;
}

// CLI 脚本跑完 main 后需自然退出：连接池空闲 5s 后自动关闭，否则挂起的 socket 会让进程永不退出。
export function cancelIdleClose() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

export function scheduleIdleClose(ms = 5000) {
  cancelIdleClose();
  _idleTimer = setTimeout(async () => {
    _idleTimer = null;
    const pool = _pool;
    _pool = null;
    if (pool) { try { await pool.end(); } catch { /* 退出阶段忽略 */ } }
  }, ms);
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

// mysql2 风格：把 `?` 占位符顺序替换成 `$1..$n`。
export function toPgSql(sql) {
  let i = 0;
  return String(sql).replace(/\?/g, () => `$${++i}`);
}

function shapeResult(res) {
  const cmd = String(res.command || '').toUpperCase();
  if (cmd === 'SELECT' || cmd === 'SHOW' || cmd === 'WITH' || cmd === 'EXPLAIN') {
    return [res.rows];
  }
  return [{ affectedRows: res.rowCount, rows: res.rows, insertId: res.rows?.[0]?.id }];
}

export async function query(sql, params = []) {
  const res = await getPool().query(toPgSql(sql), params);
  return shapeResult(res);
}

// mysql2 风格连接（事务用）：query / beginTransaction / commit / rollback / release。
export async function getConnection() {
  const client = await getPool().connect();
  return {
    query: async (sql, params = []) => shapeResult(await client.query(toPgSql(sql), params)),
    beginTransaction: () => client.query('BEGIN'),
    commit: () => client.query('COMMIT'),
    rollback: () => client.query('ROLLBACK'),
    release: () => client.release(),
  };
}

export async function closePool() {
  cancelIdleClose();
  const pool = _pool;
  _pool = null;
  if (pool) { try { await pool.end(); } catch { /* ignore */ } }
}

// 建库（连到 postgres 维护库检查/创建）。幂等，仅需一次。
export async function ensureDatabaseExists() {
  const admin = new pg.Client({ ...PG_CONFIG, database: 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [PG_CONFIG.database]);
    if (!rows.length) {
      const safe = String(PG_CONFIG.database).replace(/"/g, '""');
      await admin.query(`CREATE DATABASE "${safe}"`);
    }
  } finally {
    await admin.end().catch(() => { /* ignore */ });
  }
}
