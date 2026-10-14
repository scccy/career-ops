#!/usr/bin/env node
// boss-filter-queue.mjs — score 重跑后的强制过滤（modes/_custom.md Boss直聘 Workflow 规则）
// 【恢复副本 2026-09-22】原文件随项目目录被误删，内容从会话重建
//
// 背景：每次重跑 boss:score 都会从全量候选池重建 boss-queue.json，
// 之前手动剔除的公司（校招/实习/外包/已发送）会被加回来。
// 本脚本在任何 score 重跑之后、review/send 之前执行：
//   node boss-filter-queue.mjs [--lookback-days 30]
//
// 排除规则：
//   1. 30 天内已沟通过的公司（sent log，failed 不计）
//   2. 标题命中 title_exclude（默认 校招/应届/实习/秋招/春招/毕业生）
//   3. 公司命中 company_exclude（默认 人力/代招/FESCO/外企德科等）
//   2、3 自 2026-10-14 起统一到控制台（DB boss_config，见 skip-rules.mjs）；
//   本文件里只在 DB 不可用时回落到内置默认。
// 保留但标注（建议跳过，最终由用户定夺）：产品经理/运营/测试/运维/分析师等非开发岗。

import { pathToFileURL } from 'url';
import {
  QUEUE_PATH,
  loadSentPlacementKeys,
  readJson,
  uniqueCompanyKey,
  uniqueCompanyPlacementKey,
  writeJson,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import {
  buildWordRegex,
  NEVER_MATCH,
  DEFAULT_TITLE_EXCLUDE,
  DEFAULT_COMPANY_EXCLUDE,
} from './skip-rules.mjs';

// 排队阶段排除规则：DB 配置优先（控制台可编辑），缺省或 DB 不可用 → 内置默认
const QUEUE_CONTROL = await loadBossControl().catch(() => ({}));
const TITLE_EXCLUDE = buildWordRegex(
  Array.isArray(QUEUE_CONTROL.title_exclude) ? QUEUE_CONTROL.title_exclude : DEFAULT_TITLE_EXCLUDE,
) || NEVER_MATCH;
const COMPANY_EXCLUDE = buildWordRegex(
  Array.isArray(QUEUE_CONTROL.company_exclude) ? QUEUE_CONTROL.company_exclude : DEFAULT_COMPANY_EXCLUDE,
) || NEVER_MATCH;
const ROLE_NOTE = /产品经理|产品专家|业务运营|测试工程师|运维工程师|大数据分析师|交付工程师/;

const args = process.argv.slice(2);
const lookbackIdx = args.indexOf('--lookback-days');
const lookbackDays = lookbackIdx >= 0 ? Number(args[lookbackIdx + 1]) : 30;

const sentCompanies = loadSentPlacementKeys({ lookbackDays });
const queue = readJson(QUEUE_PATH, []);

const kept = [];
const dropped = [];
for (const job of queue) {
  const reasons = [];
  if (sentCompanies.has(uniqueCompanyPlacementKey(job)) || sentCompanies.has(uniqueCompanyKey(job))) reasons.push('30天内已沟通该公司同一基地');
  if (TITLE_EXCLUDE.test(job.title || '')) reasons.push('校招/应届/实习');
  if (COMPANY_EXCLUDE.test(job.company || '')) reasons.push('人力外包/代招');
  if (reasons.length) {
    dropped.push({ company: job.company, title: job.title, score: job.score, reasons });
  } else {
    kept.push(job);
  }
}

writeJson(QUEUE_PATH, kept);

const annotated = kept
  .filter((job) => ROLE_NOTE.test(job.title || ''))
  .map((job) => ({ company: job.company, title: job.title, score: job.score, note: '非开发岗，建议跳过' }));

console.log(JSON.stringify({ kept: kept.length, dropped, annotated }, null, 2));
