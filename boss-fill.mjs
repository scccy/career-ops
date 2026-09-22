#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  CANDIDATES_PATH,
  list,
  loadProfile,
  loadSentCompanyKeys,
  loadSentKeys,
  parseArgs,
  readJson,
} from './boss-common.mjs';
import { planQuota } from './boss-quota.mjs';

const DEFAULT_TARGET_COMPANIES = 20;
const DEFAULT_BATCH_COMPANIES = 30;
const RECENT_COMPANY_DEDUPE_DAYS = 30;

function runNode(args) {
  return execFileSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function buildNextStep(plan, input, profile) {
  if (plan.enoughForToday) {
    return {
      message: '已凑够可打招呼公司，可以生成发送队列、确认清单和 dry-run。',
      commands: [
        `npm run boss:score -- --input ${input} --threshold ${plan.threshold}`,
        `npm run boss:review -- --limit ${plan.targetCompanies} --threshold ${plan.threshold}`,
        `npm run boss:chrome:apply -- --threshold ${plan.threshold} --daily-limit ${plan.targetCompanies} --dry-run`,
      ],
    };
  }

  const target = plan.nextBatchTarget;
  const missing = plan.additionalReadCount;
  const query = list(profile?.target?.roles)[0] || '<目标岗位>';
  return {
    message: `还不够 ${plan.targetCompanies} 家达标公司。继续读取 ${missing} 家公司的右侧完整 JD，使去重公司数达到 ${target} 家。`,
    commands: [
      `自动扫描可用时：npm run boss:scan -- --query "${query}" --company-limit ${missing} --append`,
      '手动补读时：继续在 BOSS 逐个点开左侧岗位，读取右侧完整 JD。',
      `导入详情时使用追加：npm run boss:import:detail -- --input <详情文件> --append`,
      `导入后再次运行：npm run boss:fill -- --input ${input}`,
    ],
  };
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`Usage:
node boss-fill.mjs --input data/boss-candidates.json
node boss-fill.mjs --input data/boss-candidates.json --prepare

Rules:
- 每批至少读取 30 家公司的右侧完整 JD
- 最近 30 天沟通过的公司排除
- 达标公司数 >= 20 后停止读取
- 发送前只生成 dry-run，不真实发送`);
    return;
  }

  const input = args.input || CANDIDATES_PATH;
  const profile = loadProfile({ allowUnconfirmed: Boolean(args['allow-unconfirmed']) });
  const jobs = readJson(input, []);
  const plan = planQuota(jobs, profile, {
    targetCompanies: Number(args['target-companies'] ?? profile?.boss?.daily_limit ?? DEFAULT_TARGET_COMPANIES),
    batchCompanies: Number(args['batch-companies'] ?? DEFAULT_BATCH_COMPANIES),
    threshold: Number(args.threshold ?? profile?.boss?.send_threshold ?? 4.0),
    sentJobs: loadSentKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS }),
    recentSentCompanies: loadSentCompanyKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS }),
  });
  const nextStep = buildNextStep(plan, input, profile);
  const output = {
    input,
    ...plan,
    nextStep,
  };

  if (args.prepare && plan.enoughForToday) {
    const scoreOutput = runNode(['boss-score.mjs', '--input', input, '--threshold', String(plan.threshold)]);
    const reviewOutput = runNode(['boss-review.mjs', '--limit', String(plan.targetCompanies), '--threshold', String(plan.threshold)]);
    const applyDryRun = runNode(['boss-chrome-apply.mjs', '--threshold', String(plan.threshold), '--daily-limit', String(plan.targetCompanies), '--dry-run']);
    output.prepared = true;
    output.scoreOutput = JSON.parse(scoreOutput);
    output.reviewOutput = JSON.parse(reviewOutput);
    output.applyDryRun = JSON.parse(applyDryRun);
  } else {
    output.prepared = false;
  }

  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
