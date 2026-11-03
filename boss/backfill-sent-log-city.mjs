#!/usr/bin/env node
// backfill-sent-log-city.mjs — 给 PostgreSQL boss_sent_log 的历史行补 city
//
// 背景（2026-10-14）：岗位身份键与发送去重键从 `公司::岗位` 升级为 `公司::岗位::base城市`，
// 使同一公司在不同城市发布的同名岗位不再互相过滤。新日志由 appendSentLog 直接写 city 列，
// 但历史 8 列日志没有城市，只能退化成「公司级」兼容键——那会让旧记录继续跨城拦截。
//
// 2026-10 迁移后发送日志在 PostgreSQL `boss_sent_log`。本脚本一次性回填：
// 用发送记录 URL 的 pathname（job_detail/<id>.html）反查候选池拿城市；查不到的行保持空 city。
//
//   node boss/backfill-sent-log-city.mjs --dry-run
//   node boss/backfill-sent-log-city.mjs
//
// 幂等：已有 city 的行原样保留。

import { query, closePool } from './pg-db.mjs';
import { ensureSchema } from './pg-schema.mjs';
import { loadCandidates, urlPathname, parseArgs } from './boss-common.mjs';

const args = parseArgs();

async function main() {
  await ensureSchema();

  const jobs = await loadCandidates();
  // URL pathname → 城市。同一 pathname 只会对应一个岗位，取首个非空城市。
  const cityByPath = new Map();
  for (const job of jobs) {
    const path = urlPathname(job.url);
    const city = String(job.city || job.location || '').split('·')[0];
    if (path && city && !cityByPath.has(path)) cityByPath.set(path, city);
  }
  console.error(`[回填] 候选池 ${jobs.length} 条，建立 URL→城市映射 ${cityByPath.size} 条`);

  const [rows] = await query("SELECT id, url, city FROM boss_sent_log WHERE city IS NULL OR city = ''");
  const updates = [];
  let unresolved = 0;
  for (const row of rows) {
    const city = cityByPath.get(urlPathname(row.url)) || '';
    if (city) updates.push({ id: row.id, city });
    else unresolved += 1;
  }

  const summary = {
    emptyCityRows: rows.length,
    fillable: updates.length,
    unresolved,
    dryRun: Boolean(args['dry-run']),
  };
  if (!args['dry-run']) {
    for (const u of updates) {
      await query('UPDATE boss_sent_log SET city = ? WHERE id = ?', [u.city, u.id]);
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => { console.error(`backfill-sent-log-city failed: ${err.message}`); process.exitCode = 1; })
  .finally(closePool);
