#!/usr/bin/env node
// backfill-sent-log-city.mjs — 给历史发送日志补上第 9 列 city
//
// 背景（2026-10-14）：岗位身份键与发送去重键从 `公司::岗位` 升级为 `公司::岗位::base城市`，
// 使同一公司在不同城市发布的同名岗位不再互相过滤。新日志由 appendSentLog 直接写 city 列，
// 但历史 8 列日志没有城市，只能退化成「公司级」兼容键——那会让旧记录继续跨城拦截。
//
// 本脚本一次性回填：用发送记录 URL 的 pathname（job_detail/<id>.html）反查候选池拿城市。
// 查不到城市的行保持 8 列（仍按旧的公司级语义拦截，不猜）。
//
//   node boss/backfill-sent-log-city.mjs --dry-run
//   node boss/backfill-sent-log-city.mjs
//
// 幂等：已有第 9 列的行原样保留。写回前自动备份为 data/boss-sent-log.tsv.bak。

import { existsSync, copyFileSync, writeFileSync, readFileSync } from 'fs';
import { SENT_LOG_PATH, loadCandidates, urlPathname, parseArgs } from './boss-common.mjs';

const args = parseArgs();

async function main() {
  if (!existsSync(SENT_LOG_PATH)) throw new Error(`${SENT_LOG_PATH} 不存在，无需回填`);

  const jobs = await loadCandidates();
  // URL pathname → 城市。同一 pathname 只会对应一个岗位，取首个非空城市。
  const cityByPath = new Map();
  for (const job of jobs) {
    const path = urlPathname(job.url);
    const city = String(job.city || job.location || '').split('·')[0];
    if (path && city && !cityByPath.has(path)) cityByPath.set(path, city);
  }
  console.error(`[回填] 候选池 ${jobs.length} 条，建立 URL→城市映射 ${cityByPath.size} 条`);

  const lines = readFileSync(SENT_LOG_PATH, 'utf-8').split('\n');
  const header = lines[0] || '';
  const out = [];
  // 表头统一补 city 列（列顺序由 appendSentLog 固定：date time company title url status message error city）
  const headerFields = header.split('\t');
  out.push(headerFields.length >= 9 ? header : `${header.replace(/\r$/, '')}\tcity`);

  let already = 0;
  let filled = 0;
  let unresolved = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = line.replace(/\r$/, '').split('\t');
    if (fields.length >= 9 && fields[8]) { already += 1; out.push(fields.join('\t')); continue; }
    const url = fields[4] || '';
    const city = cityByPath.get(urlPathname(url)) || '';
    if (city) {
      filled += 1;
      out.push([...fields.slice(0, 8), city].join('\t'));
    } else {
      unresolved += 1;
      out.push(fields.slice(0, 8).join('\t'));
    }
  }

  const summary = { total: out.length - 1, alreadyHadCity: already, filled, unresolved, dryRun: Boolean(args['dry-run']) };
  if (args['dry-run']) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (filled) {
    copyFileSync(SENT_LOG_PATH, `${SENT_LOG_PATH}.bak`);
    writeFileSync(SENT_LOG_PATH, `${out.join('\n')}\n`, 'utf-8');
    summary.backup = `${SENT_LOG_PATH}.bak`;
  }
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error(`backfill-sent-log-city failed: ${err.message}`);
    process.exit(1);
  });
