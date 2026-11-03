// tests/boss-config-single-source.test.mjs — BOSS 操作配置的唯一来源必须是 PostgreSQL
//
// 2026-10 迁移：BOSS 的**操作配置**（阈值 / 每城配额 / 词表 / 节奏 / 门禁 / 跳词与排除规则）
// 全部以 PostgreSQL `career_ops.boss_config`（name='boss_city_control'）为唯一基准，`config/profile.yml`
// 不再保存副本、也不再作为兜底。这条契约必须被钉住，因为它曾经以两种方式静默失效：
//   1. 控制台/脚本里还留着「profile 兜底」分支 —— 无数据库凭据时连库失败，脚本读到的是
//      过期的文件值，看起来一切正常（历史事故：把厦门每日配额 120 写成了 20）。
//   2. 城市清单单独存一份 —— 控制台加了城市、全量扫描却扫不到（清单与 daily_limit_per_city 漂移）。
//
// Run: node test-all.mjs --only boss-config-single-source

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import * as yaml from 'js-yaml';

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8');
// 只检查**可执行代码**：注释里会出现「不再读 config/profile.yml」这类说明文字，
// 拿整份源码做否定匹配会把正确的注释判成违规。
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

const configDbSrc = read('boss', 'boss-config-db.mjs');
const driverSrc = read('boss', 'boss-extract-driver.mjs');
const serverSrc = read('boss', 'boss-web', 'server.mjs');
const profile = yaml.load(read('config', 'profile.yml')) || {};

// 已迁库的 5 个键：profile.yml 里一个都不许再有
const MIGRATED_BOSS_KEYS = [
  'send_threshold',
  'daily_limit_per_city',
  'daily_extract_cities',
  'daily_extract_queries',
  'daily_extract_keywords_by_city',
];

test('boss-config-db 不再读 profile.yml（DB 是唯一来源，无一次性迁移、无兜底）', () => {
  // 错误信息里出现 "config/profile.yml" 是说明文字，不算读取；这里钉的是**读取动作**本身
  assert.doesNotMatch(stripComments(configDbSrc), /readFileSync|yaml\.load|existsSync/,
    'boss-config-db.mjs 不得再读取任何配置文件（只允许读 PostgreSQL）');
  assert.doesNotMatch(stripComments(configDbSrc), /readFromProfile/, '不得保留 profile 迁移/兜底函数');
  assert.doesNotMatch(stripComments(configDbSrc), /from 'node:fs'/, '不再需要文件读取：配置只来自 PostgreSQL');
  assert.doesNotMatch(configDbSrc, /mysql2|MYSQL_/, '已迁移到 PostgreSQL，不得再引用 MySQL');
});

test('连库失败必须抛错，不能静默回落（历史事故：配额被过期文件值覆盖）', () => {
  // loadBossControl 的 catch 分支必须 throw，且错误信息要指出 PostgreSQL 才是基准
  assert.match(configDbSrc, /读取 PostgreSQL 配置失败/, '连库失败的错误信息必须可诊断');
  assert.match(configDbSrc, /export async function loadBossControl\(\)[\s\S]*?catch \(e\)[\s\S]*?throw new Error/,
    'loadBossControl 的 catch 必须 throw，不得 return 兜底值');
});

test('城市清单 = daily_limit_per_city 的键，driver 不再读 profile', () => {
  assert.match(driverSrc, /Object\.keys\(control\.daily_limit_per_city/, 'driver 的城市清单必须取自 DB 配额表');
  assert.doesNotMatch(stripComments(driverSrc), /profile\.yml|config\/profile/, 'driver 代码不得再读 profile.yml');
  assert.doesNotMatch(stripComments(driverSrc), /daily_extract_cities/, '城市清单不再有独立键，避免与配额表漂移');
});

test('各 boss 脚本不再用 .catch(() => ({})) 吞掉配置读取失败', () => {
  const scripts = [
    ['boss-apply.mjs'],
    ['boss-check-closed.mjs'],
    ['boss-chrome-apply.mjs'],
    ['boss-fill.mjs'],
    ['boss-filter-queue.mjs'],
    ['boss-quota.mjs'],
    ['boss-score.mjs'],
  ];
  for (const p of scripts) {
    const src = read('boss', ...p);
    assert.doesNotMatch(src, /loadBossControl\(\)\.catch/, `${p} 不得吞掉配置读取失败`);
    assert.doesNotMatch(src, /profile\?\.boss\?\.(send_threshold|daily_limit_per_city|daily_limit)/,
      `${p} 不得回落 profile.boss.* 的阈值/配额`);
  }
});

test('控制台不再内置默认城市表，且不吞连库错误', () => {
  assert.doesNotMatch(serverSrc, /上海: 20, 杭州: 40/, 'server.mjs 不得内置默认城市配额表');
  assert.doesNotMatch(serverSrc, /loadBossControl\(\)\.catch/, 'server.mjs 不得吞掉连库错误（应把错误带到前端）');
});

test('config/profile.yml 不再保存已迁库的 boss 操作配置，只留求职画像', () => {
  const boss = profile.boss || {};
  for (const key of MIGRATED_BOSS_KEYS) {
    assert.ok(!(key in boss), `profile.yml 的 boss.${key} 已迁库，不得保留副本`);
  }
  assert.ok('greeting_style' in boss, '画像键 greeting_style 应保留在 profile.yml');
  assert.ok(Array.isArray(boss.skills_core), '画像键 skills_core 应保留在 profile.yml');
});
