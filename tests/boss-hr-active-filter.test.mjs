// tests/boss-hr-active-filter.test.mjs — 控制台「HR活跃」过滤契约 + 独立数据库列（2026-10-16 用户要求）
//
// hr_active（HR/BOSS 活跃时间，如「今日活跃」「本周活跃」「2月内活跃」「半年内活跃」）
// 原本只存在 boss_jobs.raw 的 '$.hr_active' 里。2026-10-16 用户要求「数据库中也要有记录」，
// 提为独立列 boss_jobs.hr_active（含存量回填），控制台既显示也过滤，直接查库/导出也可见。
// 本契约把五段串起来：
//   提取/写入(jobRow) → 独立列(hr_active) → 读取(mapJobRow 覆盖回对象)
//   → UI 下拉(fHrActive)/HR活跃列 → server buildJobFilter 走列过滤。
// 任何一段漏掉，筛选都会静默不生效（与 2026-10-14 规则表、2026-10-15 扫描预算同一类坑）。
//
// Run: node test-all.mjs --only boss-hr-active-filter

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const html = readFileSync(join(ROOT, 'boss', 'boss-web', 'index.html'), 'utf-8');
const serverSrc = readFileSync(join(ROOT, 'boss', 'boss-web', 'server.mjs'), 'utf-8');
const commonSrc = readFileSync(join(ROOT, 'boss', 'boss-common.mjs'), 'utf-8');
const regressionSrc = readFileSync(join(ROOT, 'boss', 'extract-first-regression.mjs'), 'utf-8');
// 2026-10 MySQL→PostgreSQL 迁移后，建表语句搬到 boss/pg-schema.mjs（DDL 不再在 boss-common.mjs 里）。
const schemaSrc = readFileSync(join(ROOT, 'boss', 'pg-schema.mjs'), 'utf-8');

test('数据库：boss_jobs 有独立 hr_active 列 + 索引（PG DDL）', () => {
  // MySQL 时代的「ADD COLUMN … AFTER city / JSON_UNQUOTE 回填」随迁移并入 pg-schema 的建表语句，
  // 存量数据由 migrate-mysql-to-pg.mjs 整体搬运，这里只钉「列存在且有索引」这件事本身。
  assert.match(schemaSrc, /hr_active VARCHAR\(64\) DEFAULT ''/, 'pg-schema 的 boss_jobs DDL 必须定义 hr_active 列');
  assert.match(schemaSrc, /idx_boss_jobs_hr_active ON boss_jobs \(hr_active\)/, 'hr_active 列要有索引（过滤/统计用）');
});

test('写入路径：jobRow 与 JOB_COLUMNS 都要带上 hr_active', () => {
  assert.match(commonSrc, /const hrActive = String\(job\.hr_active \|\| ''\)\.slice\(0, 64\)/, 'jobRow 必须取 hr_active');
  // PG 版 INSERT 用 JOB_COLUMNS 常量拼列名：hr_active 必须紧跟 city（与 jobRow 数组顺序一致，错位会写错列）
  assert.match(
    commonSrc,
    /'city', 'hr_active'/,
    'JOB_COLUMNS 必须含 hr_active 且紧跟 city（与 jobRow 数组顺序一致）',
  );
  // 回归脚本不再自己拼 upsert 列：它走 boss-common 的 upsertJobs（列顺序由 JOB_COLUMNS 统一），
  // 所以这里钉「走的是同一条写入路径」，而不是它自己的列名字符串（2026-10 PG 迁移后如此）。
  assert.match(regressionSrc, /await upsertJobs\(\[job\]\)/, 'extract-first-regression 必须走共享的 upsertJobs（列顺序单一来源）');
  assert.match(regressionSrc, /String\(job\.hr_active \|\| ''\)\.slice\(0, 64\)/, '回归脚本的 jobRow 也要带 hr_active');
});

test('读取路径：SELECT 带 hr_active 列，mapJobRow 用列覆盖回对象', () => {
  assert.match(commonSrc, /SELECT key_hash, url, greeted, contact_state, score, status, availability, manual_excluded, manual_exclusion_reason, hr_active, raw FROM/, 'loadCandidates / loadCandidatesByKeyHashes 必须查出 hr_active 列');
  assert.match(commonSrc, /if \(r\.hr_active != null\) job\.hr_active = String\(r\.hr_active\)/, 'mapJobRow 必须用列覆盖 raw 对象');
});

test('控制台有「HR活跃」下拉，且三档都在（recent / week / month）', () => {
  assert.match(html, /<select id="fHrActive">/, '检索区必须有 fHrActive 下拉');
  for (const tier of ['recent', 'week', 'month']) {
    assert.match(html, new RegExp(`value="${tier}"`), `fHrActive 必须含 ${tier} 档`);
  }
});

test('前端接线：buildQuery / currentFilter / reset / applyPreset 都带上 hrActive', () => {
  assert.match(html, /p\.set\('hrActive',\s*v\('fHrActive'\)\)/, 'buildQuery 必须携带 hrActive');
  assert.match(html, /hrActive:v\('fHrActive'\)/, 'currentFilter（批量操作 filter）必须带 hrActive');
  assert.match(html, /'fJobType','fHrActive'\]/, '重置筛选必须清空 fHrActive');
  assert.match(html, /setVal\('fHrActive',\s*preset\.hrActive\|\|''\)/, 'applyPreset 必须回填 fHrActive');
  assert.match(html, /<th>HR活跃<\/th>/, '列表必须有 HR活跃 列');
  assert.match(html, /esc\(m\.hrActive\|\|'—'\)/, '行渲染必须输出 hrActive');
});

test('服务端：buildJobFilter 解析 hrActive 且直接按独立列过滤', () => {
  assert.match(serverSrc, /hrActive:\s*String\(sp\.get\('hrActive'\)\s*\|\| ''\)/, 'getJobs 必须解析 hrActive 查询参数');
  for (const tier of ['recent', 'week', 'month']) {
    assert.match(serverSrc, new RegExp(`f\\.hrActive === '${tier}'`), `buildJobFilter 必须处理 ${tier} 档`);
  }
  // 2026-10-16 起走独立列：过滤 SQL 必须直接引用 hr_active 列，而不是 JSON_EXTRACT(raw,...)
  // PostgreSQL 的正则匹配运算符是 `~`（MySQL 时代是 REGEXP），迁移后不能再用 MySQL 写法。
  assert.match(serverSrc, /hr_active ~ '刚刚\|今日/, '过滤必须走独立列 hr_active（PostgreSQL ~ 运算符）');
  assert.doesNotMatch(serverSrc, /hr_active REGEXP/, 'PostgreSQL 没有 REGEXP 运算符，会直接 SQL 报错');
  assert.doesNotMatch(serverSrc, /JSON_EXTRACT\(raw,'\$\.hr_active'\)/, '过滤不应再走 raw JSON（列已是权威）');
  assert.match(serverSrc, /hr_active, url, greeted, contact_state, score/, 'getJobs SELECT 必须带出 hr_active 列');
  assert.match(serverSrc, /hrActive:\s*r\.hr_active \|\| ''/, '行映射必须带 hrActive');
});

// 月档（用户主诉求「只看最近一个月」）的排除语义：把「2月内/半年/1年」等长期未活跃挡在外面。
// 这里验证与 server.mjs 相同的正则关键词，防止日后改词表时把排除项改丢。
test('月档排除语义：正则里要挡住「X月/半年/年」，同时保留近期关键词', () => {
  const monthBlock = serverSrc.match(/f\.hrActive === 'month'[\s\S]*?\}\);/)?.[0] || '';
  assert.ok(monthBlock, 'month 分支必须存在');
  assert.match(monthBlock, /\[2-9\]月/, '月档必须排除 2月~9月（如「2月内活跃」）');
  assert.match(monthBlock, /半年/, '月档必须排除「半年」');
  assert.match(monthBlock, /年/, '月档必须排除以年计（如「1年内活跃」）');
  assert.match(monthBlock, /今日|今天|刚刚|本周|本月/, '月档必须保留近期活跃关键词');
});
