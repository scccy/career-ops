#!/usr/bin/env node

import { pathToFileURL } from 'url';
import {
  CANDIDATES_PATH,
  list,
  loadProfile,
  loadSentCompanyKeys,
  loadSentKeys,
  parseArgs,
  readJson,
  uniqueCompanyKey,
  uniqueJobKey,
  isCandidatesPath,
  loadCandidates,
} from './boss-common.mjs';
import { evaluateJob } from './boss-score.mjs';

const DEFAULT_TARGET_COMPANIES = 20;
const DEFAULT_BATCH_COMPANIES = 30;
const RECENT_COMPANY_DEDUPE_DAYS = 30;

function uniqueByCompany(jobs) {
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    const key = uniqueCompanyKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }
  return out;
}

export function planQuota(jobs, profile, {
  targetCompanies = DEFAULT_TARGET_COMPANIES,
  batchCompanies = DEFAULT_BATCH_COMPANIES,
  threshold = 4.0,
  sentJobs = new Set(),
  recentSentCompanies = new Set(),
} = {}) {
  const scored = jobs.map((job) => {
    const result = evaluateJob(job, profile);
    if (sentJobs.has(uniqueJobKey(result))) result.eligible = false;
    if (recentSentCompanies.has(uniqueCompanyKey(result))) result.eligible = false;
    if (result.score < threshold) result.eligible = false;
    return result;
  });
  const candidateCompanies = uniqueByCompany(scored).length;
  const eligibleByCompany = uniqueByCompany(scored
    .filter((job) => job.eligible)
    .sort((a, b) => b.score - a.score));
  const eligibleCompanies = eligibleByCompany.length;
  const additionalEligibleCompanies = Math.max(0, targetCompanies - eligibleCompanies);
  const currentBatchTarget = Math.max(batchCompanies, Math.ceil(Math.max(candidateCompanies, 1) / batchCompanies) * batchCompanies);
  const nextBatchTarget = candidateCompanies < currentBatchTarget
    ? currentBatchTarget
    : currentBatchTarget + batchCompanies;
  const shouldContinueReading = eligibleCompanies < targetCompanies;
  const additionalReadCount = shouldContinueReading ? Math.max(0, nextBatchTarget - candidateCompanies) : 0;
  const action = shouldContinueReading
    ? candidateCompanies < currentBatchTarget ? 'complete_current_batch' : 'read_next_batch'
    : 'stop_and_apply_top_companies';

  const rejectionSummary = {};
  for (const job of scored) {
    if (job.eligible) continue;
    const reason = job.risk_hits?.length ? `风险词：${job.risk_hits.join('、')}`
      : job.jd_detail?.ok === false ? '缺少完整JD'
      : job.can_chat === false ? '不可立即沟通'
      : job.already_contacted ? '已沟通'
      : recentSentCompanies.has(uniqueCompanyKey(job)) ? '最近30天已沟通该公司'
      : sentJobs.has(uniqueJobKey(job)) ? '该岗位已沟通'
      : Number(job.score) < threshold ? '评分低于阈值'
      : '其他';
    rejectionSummary[reason] = (rejectionSummary[reason] || 0) + 1;
  }

  return {
    targetCompanies,
    threshold,
    batchCompanies,
    totalJobs: jobs.length,
    candidateCompanies,
    eligibleCompanies,
    dedupeDays: RECENT_COMPANY_DEDUPE_DAYS,
    recentSentCompanies: recentSentCompanies.size,
    additionalEligibleCompanies,
    currentBatchTarget,
    nextBatchTarget: shouldContinueReading ? nextBatchTarget : candidateCompanies,
    additionalReadCount,
    shouldContinueReading,
    action,
    enoughForToday: eligibleCompanies >= targetCompanies,
    targetCities: list(profile?.target?.cities),
    rejectionSummary,
    eligiblePreview: eligibleByCompany
      .slice(0, targetCompanies)
      .map((job) => ({
        company: job.company,
        title: job.title,
        score: job.score,
        city: job.city,
      })),
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-quota.mjs --input data/boss-candidates.json --target-companies 20 --threshold 4.0');
    return;
  }
  const profile = loadProfile({ allowUnconfirmed: Boolean(args['allow-unconfirmed']) });
  const input = args.input || CANDIDATES_PATH;
  const jobs = isCandidatesPath(input) ? await loadCandidates() : readJson(input, []);
  const plan = planQuota(jobs, profile, {
    targetCompanies: Number(args['target-companies'] ?? profile?.boss?.daily_limit ?? DEFAULT_TARGET_COMPANIES),
    batchCompanies: Number(args['batch-companies'] ?? DEFAULT_BATCH_COMPANIES),
    threshold: Number(args.threshold ?? profile?.boss?.send_threshold ?? 4.0),
    sentJobs: loadSentKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS }),
    recentSentCompanies: loadSentCompanyKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS }),
  });
  console.log(JSON.stringify({ input, ...plan }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
