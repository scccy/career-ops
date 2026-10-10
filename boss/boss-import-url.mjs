#!/usr/bin/env node

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import {
  CANDIDATES_PATH,
  countUniqueCompanies,
  mergeJobs,
  parseArgs,
  readJson,
  writeJson,
  isCandidatesPath,
  loadCandidates,
  saveCandidates,
} from './boss-common.mjs';

const BOSS_SALARY_MAP = new Map([
  [String.fromCharCode(0xE031), '0'],
  [String.fromCharCode(0xE032), '1'],
  [String.fromCharCode(0xE033), '2'],
  [String.fromCharCode(0xE034), '3'],
  [String.fromCharCode(0xE035), '4'],
  [String.fromCharCode(0xE036), '5'],
  [String.fromCharCode(0xE037), '6'],
  [String.fromCharCode(0xE038), '7'],
  [String.fromCharCode(0xE039), '8'],
  [String.fromCharCode(0xE03a), '9'],
]);

const DETAIL_HEADING = /岗位职责|工作职责|职位描述|岗位描述|职责描述|任职要求|职位要求|岗位要求|工作内容/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBossText(text) {
  return String(text || '')
    .replace(/[\uE031-\uE03A]/g, (ch) => BOSS_SALARY_MAP.get(ch) || ch)
    .replace(/\uFFFC/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absoluteUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//.test(url)) return url;
  return `https://www.zhipin.com${url.startsWith('/') ? '' : '/'}${url}`;
}

function validateDetail(job) {
  const desc = String(job.desc || '').replace(/\s+/g, '');
  if (desc.length < 180) return '岗位描述过短，疑似未读取完整详情页 JD';
  if (!DETAIL_HEADING.test(desc)) return '未识别到岗位职责/任职要求等 JD 结构';
  if (!job.company || !job.title) return '缺少公司名或岗位名';
  return '';
}

async function goto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    const message = String(err?.message || err);
    if (!message.includes('net::ERR_ABORTED') || !page.url().includes('zhipin.com')) throw err;
  }
}

async function loadCookies(context, cookiesPath) {
  if (!cookiesPath || !existsSync(cookiesPath)) return false;
  const parsed = JSON.parse(readFileSync(cookiesPath, 'utf-8'));
  await context.addCookies(parsed.cookies || parsed);
  return true;
}

async function extractJob(page, url) {
  const raw = await page.evaluate(() => {
    const pick = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el?.innerText?.trim()) return el.innerText.trim();
      }
      return '';
    };
    const detailRoot = document.querySelector('.job-detail-box') || document;
    const detailTexts = [
      ...detailRoot.querySelectorAll('.job-sec, .job-detail-section, .job-sec-text, .detail-content, .text, .desc, section'),
    ]
      .map((el) => el.innerText || '')
      .filter(Boolean)
      .join('\n');
    const bodyText = document.body?.innerText || '';
    const tags = [...document.querySelectorAll('.job-tags span, .job-keyword-list span, .tag-list span')]
      .map((el) => el.innerText.trim())
      .filter(Boolean);
    return {
      title: pick(['.job-detail-box .job-name', '.job-banner .name', '.job-name', 'h1']),
      salary: pick(['.job-detail-box .salary', '.job-banner .salary', '.job-salary', '.salary']),
      company: pick(['.sider-company .company-info a', '.job-detail-company .name', '.company-name', '.company-info a']),
      desc: detailTexts || bodyText,
      tags,
      bodyText,
    };
  });

  const decodedBody = decodeBossText(raw.bodyText);
  const city = decodedBody.match(/(深圳(?:[·\s-][\u4e00-\u9fa5A-Za-z0-9]+){0,2}|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)/)?.[0] || '';
  const job = {
    source: 'boss-url',
    company: decodeBossText(raw.company),
    title: decodeBossText(raw.title),
    salary: decodeBossText(raw.salary),
    city: decodeBossText(city),
    desc: decodeBossText(raw.desc),
    hr_active: decodedBody.match(/刚刚活跃|今日活跃|今天活跃|\d+\s*分钟前活跃|\d+\s*小时前活跃|本周活跃/)?.[0] || '',
    tags: Array.isArray(raw.tags) ? raw.tags.map(decodeBossText).filter(Boolean) : [],
    url: absoluteUrl(url),
    can_chat: /立即沟通/.test(decodedBody),
    already_contacted: /已沟通|继续沟通/.test(decodedBody),
    scanned_at: new Date().toISOString(),
  };
  const reason = validateDetail(job);
  job.jd_detail = { ok: !reason, reason: reason || '已读取详情页完整 JD' };
  return job;
}

async function main() {
  const args = parseArgs();
  const url = args.url || args._?.[0];
  if (args.help || !url) {
    console.log(`Usage:
node boss-import-url.mjs "https://www.zhipin.com/job_detail/..." [--append]
node boss-import-url.mjs --url "https://www.zhipin.com/job_detail/..." --cookies data/boss-cookies.json

默认写入 data/boss-candidates.json。若详情页需要登录，先运行 npm run boss:login，或在 BOSS 正常登录后复制完整 JD 用 boss:import:detail 导入。`);
    return;
  }

  const cookiesPath = args.cookies || 'data/boss-cookies.json';
  const output = args.output || CANDIDATES_PATH;
  const browser = await chromium.launch({
    headless: args.headless === true,
    channel: args.channel || undefined,
    args: ['--no-proxy-server'],
  });

  try {
    const context = await browser.newContext({ viewport: null });
    await loadCookies(context, cookiesPath).catch(() => false);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await goto(page, url);
    await sleep(Number(args['wait-ms'] || 1800));

    const job = await extractJob(page, url);
    if (!job.jd_detail.ok && !args['allow-incomplete']) {
      throw new Error(`${job.jd_detail.reason}。请确认已登录 BOSS，或打开链接后复制完整页面文本，用 npm run boss:import:detail 导入。`);
    }

    const useDb = isCandidatesPath(output);
    const before = useDb ? await loadCandidates() : readJson(output, []);
    const finalJobs = args.append === false || args.replace ? [job] : mergeJobs(before, [job]);
    if (!args['dry-run']) {
      if (useDb) await saveCandidates(finalJobs);
      else writeJson(output, finalJobs);
    }

    console.log(JSON.stringify({
      imported: 1,
      total: finalJobs.length,
      uniqueCompanies: countUniqueCompanies(finalJobs),
      output: args['dry-run'] ? null : output,
      dryRun: Boolean(args['dry-run']),
      cvSource: existsSync('cv.md') ? 'cv.md' : null,
      preview: {
        company: job.company,
        title: job.title,
        salary: job.salary,
        city: job.city,
        jd_detail: job.jd_detail,
      },
    }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`boss-import-url failed: ${err.message}`);
  process.exit(1);
});
