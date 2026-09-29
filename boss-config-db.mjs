// boss-config-db.mjs — BOSS「每日城市操作流程控制」配置统一存储
//
// 设计（2026-09-29 完全迁库）：
//   - 单一配置行 boss_config.name = 'boss_city_control'，value 为 JSON 文本（MySQL/MariaDB 兼容，不依赖 JSON 列类型）。
//   - DB 为主存储；profile.yml 仅在「DB 空且 profile 含这些键」时作为一次性迁移源，之后不再依赖 profile。
//   - 每次读取走单连接（mysql2 createConnection + end），脚本运行结束不残留连接，进程可正常退出。
//
// 存储的键（即控制台「每日城市操作流程控制」管理的全部字段）：
//   send_threshold, daily_limit_per_city, daily_extract_queries, daily_extract_keywords_by_city
//
// 注意：daily_extract_cities / jd_focus_terms / greeting_style 等 boss.* 键不属于本控件，仍留 profile.yml。

import mysql from 'mysql2/promise';
import { readFileSync, existsSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dirname, 'config', 'profile.yml');

const DB = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '***REMOVED***',
  database: process.env.MYSQL_DB || 'career_ops',
};

const CONFIG_ROW = 'boss_city_control';

const FALLBACK = {
  send_threshold: 3.0,
  daily_limit_per_city: { 上海: 20, 杭州: 40, 南京: 20, 无锡: 20, 常州: 20 },
  daily_extract_queries: [],
  daily_extract_keywords_by_city: {},
  // BOSS 平台级每日沟通上限：0 = 不启用（用户自行通过城市配额管理，
  // 会员可解除平台限制）。仅在显式配置 >0 时才参与封顶。
  platform_daily_limit: 0,
};

function normalize(v = {}) {
  return {
    send_threshold: Number(v.send_threshold) > 0 ? Number(v.send_threshold) : FALLBACK.send_threshold,
    daily_limit_per_city:
      v.daily_limit_per_city && typeof v.daily_limit_per_city === 'object'
        ? v.daily_limit_per_city
        : FALLBACK.daily_limit_per_city,
    daily_extract_queries: Array.isArray(v.daily_extract_queries) ? v.daily_extract_queries : [],
    daily_extract_keywords_by_city:
      v.daily_extract_keywords_by_city && typeof v.daily_extract_keywords_by_city === 'object'
        ? v.daily_extract_keywords_by_city
        : {},
    platform_daily_limit:
      Number.isFinite(Number(v.platform_daily_limit)) && Number(v.platform_daily_limit) > 0
        ? Number(v.platform_daily_limit)
        : 0,
  };
}

// 从 profile.yml 读取这 4 个键（仅用于一次性迁移与 DB 不可用时的兜底）
function readFromProfile() {
  try {
    if (!existsSync(PROFILE)) return null;
    const cfg = yaml.load(readFileSync(PROFILE, 'utf-8')) || {};
    const boss = cfg.boss || {};
    if (
      boss.send_threshold == null &&
      !boss.daily_limit_per_city &&
      !boss.daily_extract_queries &&
      !boss.daily_extract_keywords_by_city
    ) {
      return null;
    }
    return normalize({
      send_threshold: boss.send_threshold,
      daily_limit_per_city: boss.daily_limit_per_city,
      daily_extract_queries: boss.daily_extract_queries,
      daily_extract_keywords_by_city: boss.daily_extract_keywords_by_city,
    });
  } catch {
    return null;
  }
}

let _ensured = false;
async function withConn(fn) {
  const conn = await mysql.createConnection(DB);
  try {
    if (!_ensured) {
      await conn.query(
        `CREATE TABLE IF NOT EXISTS boss_config (
          name       VARCHAR(128) NOT NULL PRIMARY KEY,
          value      TEXT         NOT NULL,
          updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      _ensured = true;
    }
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

// 读取配置。优先 DB；DB 空则从 profile 迁移并写回；DB 不可用则降级 profile / 默认值。
export async function loadBossControl() {
  try {
    return await withConn(async (conn) => {
      const [rows] = await conn.query('SELECT value FROM boss_config WHERE name = ?', [CONFIG_ROW]);
      if (rows.length && rows[0].value) {
        const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
        return normalize(v);
      }
      const fromProfile = readFromProfile();
      if (fromProfile) {
        await conn.query(
          'INSERT INTO boss_config (name, value, updated_at) VALUES (?, ?, NOW(3)) ' +
            'ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW(3)',
          [CONFIG_ROW, JSON.stringify(fromProfile)],
        );
        return fromProfile;
      }
      return normalize({});
    });
  } catch {
    return readFromProfile() || normalize({});
  }
}

// 写入配置。partial 与当前值合并后整行覆盖写回。DB 不可用时抛出，由调用方上报错误。
export async function saveBossControl(partial = {}) {
  const cur = await loadBossControl();
  const merged = { ...cur, ...partial };
  const value = normalize(merged);
  await withConn(async (conn) => {
    await conn.query(
      'INSERT INTO boss_config (name, value, updated_at) VALUES (?, ?, NOW(3)) ' +
        'ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW(3)',
      [CONFIG_ROW, JSON.stringify(value)],
    );
  });
  return value;
}
