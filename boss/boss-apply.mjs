#!/usr/bin/env node

import { chromium } from 'playwright';
import {
  QUEUE_PATH,
  appendApplication,
  appendSentLog,
  countSentCompaniesToday,
  loadProfile,
  loadSentCompanyKeys,
  loadSentKeys,
  parseArgs,
  readJson,
  uniqueCompanyKey,
  uniqueJobKey,
} from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';

// 评分阈值统一来自数据库（控制台 boss_city_control）；DB 不可用时退化到 profile.yml 默认值。
const BOSS_CONTROL = await loadBossControl().catch(() => ({}));
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const RECENT_COMPANY_DEDUPE_DAYS = 30;

async function loadCookies(context, cookiesPath) {
  if (!cookiesPath || !existsSync(cookiesPath)) return;
  const parsed = JSON.parse(readFileSync(cookiesPath, 'utf-8'));
  await context.addCookies(parsed.cookies || parsed);
}

async function saveCookies(context, cookiesPath) {
  if (!cookiesPath) return;
  mkdirSync(dirname(cookiesPath), { recursive: true });
  writeFileSync(cookiesPath, JSON.stringify({ cookies: await context.cookies() }, null, 2), 'utf-8');
}

async function sendOne(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const apply = page.getByRole('link', { name: /立即沟通/ });
  if (!await apply.isVisible().catch(() => false)) throw new Error('未找到“立即沟通”按钮');
  await apply.click({ delay: 100 });
  const dialog = page.locator('.dialog-container');
  await dialog.waitFor({ timeout: 10000 });
  const input = dialog.locator('.input-area');
  await input.fill(job.greeting);
  const send = dialog.locator('.send-message:not(.disable)');
  await send.waitFor({ timeout: 10000 });
  await send.click({ delay: 120 });
  await page.waitForTimeout(1000);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-apply.mjs --threshold 4.0 --daily-limit 20 [--dry-run]\n       node boss-apply.mjs --threshold 4.0 --daily-limit 20 --confirmed-review');
    return;
  }
  const profile = loadProfile();
  const queue = readJson(args.input || QUEUE_PATH, []);
  const threshold = Number(args.threshold ?? BOSS_CONTROL.send_threshold ?? profile?.boss?.send_threshold ?? 4.0);
  const limit = Number(args['daily-limit'] ?? profile?.boss?.daily_limit ?? 20);
  const cookiesPath = args.cookies || profile?.boss?.cookies_path || 'data/boss-cookies.json';
  const sentJobs = loadSentKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const recentSentCompanies = loadSentCompanyKeys({ lookbackDays: RECENT_COMPANY_DEDUPE_DAYS });
  const sentToday = countSentCompaniesToday();
  const remainingToday = Math.max(0, limit - sentToday);
  const seenCompanies = new Set();
  const candidates = queue
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .filter((job) => Number(job.score) >= threshold)
    .filter((job) => !sentJobs.has(uniqueJobKey(job)))
    .filter((job) => {
      const key = uniqueCompanyKey(job);
      if (recentSentCompanies.has(key)) return false;
      if (seenCompanies.has(key)) return false;
      seenCompanies.add(key);
      return true;
    })
    .slice(0, remainingToday);

  if (args['dry-run']) {
    console.log(JSON.stringify({
      dryRun: true,
      threshold,
      dailyLimit: limit,
      sentCompaniesToday: sentToday,
      dedupeDays: RECENT_COMPANY_DEDUPE_DAYS,
      recentSentCompanies: recentSentCompanies.size,
      remainingToday,
      uniqueCompanyMode: true,
      willSend: candidates.map((job) => ({
        company: job.company,
        title: job.title,
        score: job.score,
        greeting_basis: job.greeting_basis,
        greeting: job.greeting,
      })),
    }, null, 2));
    return;
  }

  if (!args['confirmed-review']) {
    throw new Error('真实发送前必须先向用户展示 data/boss-review.md 的前 20 家确认清单，并在用户明确确认后加 --confirmed-review。');
  }

  if (remainingToday <= 0) {
    console.log(JSON.stringify({ sentCompaniesToday: sentToday, dailyLimit: limit, skipped: 'daily limit reached' }, null, 2));
    return;
  }

  const browser = await chromium.launch({ headless: false, args: ['--no-proxy-server'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await loadCookies(context, cookiesPath);
  try {
    for (const job of candidates) {
      try {
        await sendOne(page, job);
        appendSentLog({ job, status: 'sent', message: job.greeting });
        appendApplication({ job, score: `${job.score}/5`, status: 'Applied', report: job.report || '—', notes: 'BOSS 自动打招呼' });
        console.log(`sent: ${job.company} - ${job.title}`);
      } catch (err) {
        appendSentLog({ job, status: 'failed', message: job.greeting, error: err.message });
        console.error(`failed: ${job.company} - ${job.title}: ${err.message}`);
        break;
      }
    }
  } finally {
    await saveCookies(context, cookiesPath).catch(() => {});
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`boss-apply failed: ${err.message}`);
  process.exit(1);
});
