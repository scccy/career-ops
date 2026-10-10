#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  CANDIDATES_PATH,
  list,
  loadProfile,
  loadSentCompanyKeys,
  loadSentKeys,
  parseArgs,
  readJson,
  isCandidatesPath,
  loadCandidates,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';

// 评分阈值统一来自数据库（控制台 boss_city_control）；DB 不可用时退化到 profile.yml 默认值。
const BOSS_CONTROL = await loadBossControl().catch(() => ({}));
import { planQuota } from './boss-quota.mjs';

const DEFAULT_TARGET_COMPANIES = 20;
const DEFAULT_BATCH_COMPANIES = 30;
const RECENT_COMPANY_DEDUPE_DAYS = 30;

// 兄弟脚本用「本文件所在目录」解析，而不是 CWD——脚本位于 boss/ 子目录，
// 裸文件名会在仓库根解析失败（2026-09-30 迁移后修复）。
function siblingScript(name) {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

function runNode(args) {
  return execFileSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// 子脚本的契约是「stdout 只放最终 JSON、诊断走 stderr」，但历史上有日志误用 console.log
// 混进 stdout（boss-score / boss-chrome-apply 的 [boss-db]/[过滤统计] 行，2026-09-30 已改为 stderr）。
// 这里按「取最后一个完整 JSON 对象」解析，避免一行日志把整个 --prepare 拖垮。
function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch { /* fallthrough */ }
    }
    throw new Error(`${label} 的输出不是合法 JSON（stdout 可能混入了日志行）：\n${text.slice(0, 500)}`);
  }
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

async function main() {
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
  const jobs = isCandidatesPath(input) ? await loadCandidates() : readJson(input, []);
  const plan = planQuota(jobs, profile, {
    targetCompanies: Number(args['target-companies'] ?? profile?.boss?.daily_limit ?? DEFAULT_TARGET_COMPANIES),
    batchCompanies: Number(args['batch-companies'] ?? DEFAULT_BATCH_COMPANIES),
    threshold: Number(args.threshold ?? BOSS_CONTROL.send_threshold ?? profile?.boss?.send_threshold ?? 4.0),
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
    const scoreOutput = runNode([siblingScript('boss-score.mjs'), '--input', input, '--threshold', String(plan.threshold)]);
    const reviewOutput = runNode([siblingScript('boss-review.mjs'), '--limit', String(plan.targetCompanies), '--threshold', String(plan.threshold)]);
    const applyDryRun = runNode([siblingScript('boss-chrome-apply.mjs'), '--threshold', String(plan.threshold), '--daily-limit', String(plan.targetCompanies), '--dry-run']);
    output.prepared = true;
    output.scoreOutput = parseJsonOutput(scoreOutput, 'boss-score.mjs');
    output.reviewOutput = parseJsonOutput(reviewOutput, 'boss-review.mjs');
    output.applyDryRun = parseJsonOutput(applyDryRun, 'boss-chrome-apply.mjs');
  } else {
    output.prepared = false;
  }

  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
