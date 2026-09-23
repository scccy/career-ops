#!/usr/bin/env node

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  CANDIDATES_PATH,
  countUniqueCompanies,
  loadProfile,
  mergeJobs,
  parseArgs,
  readJson,
  resolveBossSearchCity,
  uniqueCandidateKey,
  uniqueCompanyKey,
  writeJson,
  isCandidatesPath,
  loadCandidates,
  mergeIntoCandidates,
  saveCandidates,
} from './boss-common.mjs';

const BASE_URL = 'https://www.zhipin.com';
const LOGIN_URL = `${BASE_URL}/web/user/?ka=header-login`;
const LOGIN_REQUIRED_PATH = 'data/boss-login-required.json';
const DEFAULT_FILTER = /外包|派遣|猎头|驻场|催收|电催|贷后|信用卡逾期|纯销售|电话销售|不缴社保|无社保/;
const SALARY_MAP = new Map([
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

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function decodeSalary(text = '') {
  return [...String(text)].map((ch) => SALARY_MAP.get(ch) || ch).join('');
}

function parseCityFromText(text = '') {
  const match = String(text).match(/(深圳|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)(?:[·\s-][\u4e00-\u9fa5A-Za-z0-9]+){0,2}/);
  return match ? match[0].trim() : '';
}

function buildUrl({ query = '', city = '100010000', salary = '' }) {
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (city) params.set('city', city);
  if (salary) params.set('salary', salary);
  return `${BASE_URL}/web/geek/jobs?${params.toString()}`;
}

async function goto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    const message = String(err?.message || err);
    if (message.includes('net::ERR_ABORTED') && page.url().includes('zhipin.com')) return;
    throw err;
  }
}

async function loadCookies(context, cookiesPath) {
  if (!cookiesPath || !existsSync(cookiesPath)) return;
  const parsed = JSON.parse(readFileSync(cookiesPath, 'utf-8'));
  await context.addCookies(parsed.cookies || parsed);
}

async function saveCookies(context, cookiesPath) {
  if (!cookiesPath) return;
  const cookies = await context.cookies();
  mkdirSync(dirname(cookiesPath), { recursive: true });
  writeFileSync(cookiesPath, JSON.stringify({ cookies }, null, 2), 'utf-8');
}

async function hasBossLoginCookie(context) {
  const cookies = await context.cookies(BASE_URL).catch(() => []);
  return cookies.some((cookie) => ['wt2', 'wbg', 'zp_at', 'sid'].includes(cookie.name));
}

async function isLoggedIn(page, context) {
  if (await page.locator('.nav-figure').isVisible().catch(() => false)) return true;
  return hasBossLoginCookie(context);
}

async function preferCodeLogin(page) {
  const candidates = [/验证码登录/, /短信登录/, /手机验证码/, /手机号登录/, /账号登录/, /其他方式登录/];
  for (const pattern of candidates) {
    const item = page.getByText(pattern).first();
    if (await item.isVisible().catch(() => false)) {
      await item.click({ delay: 80 }).catch(() => {});
      await sleep(500);
      return true;
    }
  }
  return false;
}

function writeLoginRequiredState({ reason, url = '', nextCommand = 'npm run boss:chrome:extract -- --company-limit 30 --max-cards 120 --click-gap-ms 2200 --append' }) {
  mkdirSync(dirname(LOGIN_REQUIRED_PATH), { recursive: true });
  writeFileSync(LOGIN_REQUIRED_PATH, `${JSON.stringify({
    status: 'login_required',
    reason,
    url,
    next_step: '请用户用正常 Chrome 登录 BOSS，并进入深圳法务/合规岗位列表页；用户确认已登录后，再执行 next_command。',
    next_command: nextCommand,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf-8');
}

function loginRequiredMessage(reason) {
  return `${reason}。已记录到 ${LOGIN_REQUIRED_PATH}。请先用正常 Chrome 登录 BOSS，进入目标岗位列表页；登录完成后告诉我，再继续用 boss:chrome:extract 读取当前页面。`;
}

async function createBossSession(args) {
  const browser = await chromium.launch({
    channel: args.channel || undefined,
    headless: false,
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.bringToFront().catch(() => {});
  return { browser, context, page };
}

async function ensureLogin(page, context, cookiesPath) {
  await loadCookies(context, cookiesPath);
  await goto(page, LOGIN_URL);
  if (await isLoggedIn(page, context)) {
    await saveCookies(context, cookiesPath);
    return;
  }
  await preferCodeLogin(page).catch(() => false);
  writeLoginRequiredState({ reason: 'BOSS cookie 已失效或需要安全验证', url: page.url() });
  throw new Error(loginRequiredMessage('BOSS cookie 已失效或需要安全验证'));
}

function jobContainer(page) {
  return page.locator('.job-list-container').first();
}

async function waitForContainer(page, timeoutMs) {
  const container = jobContainer(page);
  await container.waitFor({ state: 'visible', timeout: timeoutMs });
  return container;
}

async function waitForManualSearch(page) {
  console.error('请用正常 Chrome 手动完成 BOSS 登录和岗位搜索；登录后告诉我，再用 boss:chrome:extract 读取当前页面。');
  if (page.url() === 'about:blank' || !page.url().includes('zhipin.com')) {
    writeLoginRequiredState({ reason: '当前自动化页面不是可用的 BOSS 页面', url: page.url() });
    throw new Error(loginRequiredMessage('当前自动化页面不是可用的 BOSS 页面'));
  }
  if (await jobContainer(page).isVisible().catch(() => false)) {
    console.error(`已发现岗位列表：${page.url()}`);
    return jobContainer(page);
  }
  writeLoginRequiredState({ reason: '未发现岗位列表，需要用户手动登录并搜索', url: page.url() });
  throw new Error(loginRequiredMessage(`未发现岗位列表，当前页面：${page.url()}`));
}

async function openSearch(page, args) {
  if (args.manual) {
    await goto(page, BASE_URL);
    return waitForManualSearch(page);
  }

  const profile = loadProfile({ allowUnconfirmed: true });
  const city = resolveBossSearchCity({ explicitCity: args.city, profile });
  if (city.source === 'profile') {
    console.error(`使用求职画像中的目标城市：${city.city}（BOSS city=${city.code}）`);
  } else if (city.source === 'args') {
    console.error(`使用命令行指定城市：${args.city}（BOSS city=${city.code}）`);
  } else {
    console.error(`未识别到求职画像目标城市，使用默认城市：${city.city}（BOSS city=${city.code}）`);
  }
  args.city = city.code;

  await goto(page, buildUrl(args));
  console.error(`当前搜索页面：${page.url()}`);
  try {
    return await waitForContainer(page, 30000);
  } catch (err) {
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    console.error(`未自动进入岗位列表，当前页面：${page.url()}；标题：${title}；页面文本：${body.slice(0, 120).replace(/\s+/g, ' ')}`);
    writeLoginRequiredState({ reason: '未自动进入岗位列表，需要用户在正常 Chrome 登录并搜索', url: page.url() });
    throw new Error(loginRequiredMessage('未自动进入岗位列表，需要用户在正常 Chrome 登录并搜索'));
  }
}

async function scrollJobs(page, container, scrollN) {
  await container.hover().catch(() => {});
  let previousCount = await container.locator('.job-card-box').count().catch(() => 0);
  for (let i = 0; i < scrollN; i++) {
    const box = await container.boundingBox().catch(() => null);
    await page.mouse.wheel(0, Math.max(700, Math.floor(box?.height || 900)));
    const loading = container.locator('.loading-wait').first();
    await loading.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
    await loading.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await sleep(600);
    const currentCount = await container.locator('.job-card-box').count().catch(() => previousCount);
    if (currentCount <= previousCount) break;
    previousCount = currentCount;
  }
}

async function firstText(locator, fallback = '') {
  return locator.first().innerText().catch(() => fallback);
}

async function firstAttr(locator, name, fallback = '') {
  return locator.first().getAttribute(name).catch(() => fallback);
}

async function parseJobCard(page, card, args) {
  const cardText = await card.innerText().catch(() => '');
  const tagAlt = await firstAttr(card.locator('.job-tag-icon'), 'alt');
  if (DEFAULT_FILTER.test(cardText) || DEFAULT_FILTER.test(tagAlt)) return null;
  if (/已沟通/.test(cardText)) return null;

  await card.click({ delay: 80 }).catch(() => {});
  const detail = page.locator('.job-detail-box').first();
  await detail.locator('.desc').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  const desc = await firstText(detail.locator('.desc'));
  if (!desc) return null;

  const bossInfo = detail.locator('.job-boss-info').first();
  const hrActive = await firstText(bossInfo.locator('.boss-active-time'), await firstText(detail.locator('.boss-active-time')));
  if (/[周月年]/.test(hrActive)) return null;

  const chatButton = page.getByRole('link', { name: /立即沟通/ }).first();
  const canChat = await chatButton.isVisible().catch(() => false);
  if (!canChat) return null;

  const rawUrl = await firstAttr(card.locator('.job-name'), 'href');
  const company = await firstText(detail.locator('.company-name'),
    await firstText(card.locator('.company-name'),
      await firstText(card.locator('.company-text'))));

  return {
    source: 'boss',
    company,
    title: await firstText(detail.locator('.job-name'), await firstText(card.locator('.job-name'))),
    salary: decodeSalary(await firstText(detail.locator('.job-salary'), await firstText(card.locator('.salary')))),
    city: parseCityFromText(cardText),
    desc,
    hr_active: hrActive,
    tags: cardText.split(/\s+/).filter(Boolean).slice(0, 20),
    url: rawUrl?.startsWith('http') ? rawUrl : `${BASE_URL}${rawUrl || ''}`,
    can_chat: canChat,
    already_contacted: false,
    scanned_at: new Date().toISOString(),
  };
}

async function scan(args) {
  const limit = Number(args.limit || 50);
  const companyLimit = Number(args['company-limit'] || args['target-companies'] || 0);
  const scrollN = Number(args.scroll || args.scroll_n || 8);
  const maxCards = Number(args['max-cards'] || Math.max(limit * 4, companyLimit * 4, 120));
  const cookiesPath = args.cookies || 'data/boss-cookies.json';
  const { browser, context, page } = await createBossSession(args);
  try {
    await ensureLogin(page, context, cookiesPath);
    if (args['login-only']) {
      console.log(JSON.stringify({ login: 'ok', cookies: cookiesPath }, null, 2));
      return [];
    }

    const container = await openSearch(page, args);
    const jobs = [];
    const seenJobs = new Set();
    const seenCompanies = new Set();
    let index = 0;
    let stagnantScrolls = 0;
    await scrollJobs(page, container, Math.max(1, Math.min(scrollN, 2)));

    while (index < maxCards) {
      const cards = container.locator('.job-card-box');
      const count = await cards.count().catch(() => 0);
      while (index < count) {
        if (companyLimit > 0 && seenCompanies.size >= companyLimit) return jobs;
        if (!companyLimit && jobs.length >= limit) return jobs;
        const card = cards.nth(index);
        index += 1;
        await page.waitForTimeout(Number(args['click-gap-ms'] || 900));
        await card.scrollIntoViewIfNeeded().catch(() => {});
        const job = await parseJobCard(page, card, args);
        if (!job) continue;
        const jobKey = uniqueCandidateKey(job);
        if (seenJobs.has(jobKey)) continue;
        seenJobs.add(jobKey);
        jobs.push(job);
        seenCompanies.add(uniqueCompanyKey(job));
      }

      if (companyLimit > 0 && seenCompanies.size >= companyLimit) break;
      if (!companyLimit && jobs.length >= limit) break;

      const before = await cards.count().catch(() => count);
      await scrollJobs(page, container, 1);
      const after = await cards.count().catch(() => before);
      stagnantScrolls = after <= before ? stagnantScrolls + 1 : 0;
      if (stagnantScrolls >= 3) break;
    }
    return jobs;
  } finally {
    await saveCookies(context, cookiesPath).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-scan.mjs --query "法务" --company-limit 30 [--append]\n       node boss-scan.mjs --query "法务" --limit 50 [--dry-run]\n       node boss-scan.mjs --query "法务" --city 深圳 --company-limit 30\n       node boss-scan.mjs --manual --company-limit 30\n       node boss-scan.mjs --login-only');
    return;
  }
  if (args['record-login-required']) {
    writeLoginRequiredState({
      reason: String(args.reason || 'BOSS 要求登录或安全验证'),
      url: String(args.url || ''),
    });
    console.log(JSON.stringify(readJson(LOGIN_REQUIRED_PATH, {}), null, 2));
    return;
  }
  if (args['login-only']) {
    await scan(args);
    return;
  }
  const jobs = await scan(args);
  const output = args.output || CANDIDATES_PATH;
  const useDb = isCandidatesPath(output);
  const appending = args.append && !args['dry-run'];
  let finalJobs;
  if (useDb) {
    finalJobs = appending
      ? await mergeIntoCandidates(jobs)
      : (args['dry-run'] ? jobs : await saveCandidates(jobs));
  } else {
    finalJobs = appending ? mergeJobs(readJson(output, []), jobs) : jobs;
    if (!args['dry-run']) writeJson(output, finalJobs);
  }
  console.log(JSON.stringify({
    scanned: jobs.length,
    total: finalJobs.length,
    uniqueCompanies: countUniqueCompanies(finalJobs),
    appended: Boolean(args.append),
    dryRun: Boolean(args['dry-run']),
    output: args['dry-run'] ? null : output,
  }, null, 2));
}

main().catch((err) => {
  console.error(`boss-scan failed: ${err.message}`);
  process.exit(1);
});
