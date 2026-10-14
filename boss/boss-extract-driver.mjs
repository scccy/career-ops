#!/usr/bin/env node
// boss-extract-driver.mjs — 跨平台 BOSS 搜索页提取驱动；shell 入口也委托到这里
//
// 与 bash 版保持一致的语义：
//   - 城市列表来自 config/profile.yml 的 boss.daily_extract_cities
//   - 词表：--keywords 显式覆盖 > 每城词表(DB) > 统一词表(DB)，与 boss-extract-3cities.sh 的 city_keywords 一致
//   - 主轮 = 词表前 3 个；--all 追加补充轮（其余词）
//   - 单城扫描预算 = 该城每日配额 × BOSS_SCAN_BUDGET_FACTOR(默认 1.3)，按词数均分
//   - 关键词间隔 BOSS_KEYWORD_GAP_SECONDS(默认 300s)、城市间隔 BOSS_CITY_GAP_SECONDS(默认 600s)
//   - 每个关键词：CDP 导航搜索页 → sleep 3s → boss-chrome-extract.mjs --append
//
// 只负责「抓取」；评分/排队由调用方串联（控制台命令里已接 `&& npm run boss:score && npm run boss:fill -- --prepare`）。
// 需要在项目根目录运行，且环境变量 MYSQL_PASSWORD 正确（写库用）。
//
// 用法：
//   node boss/boss-extract-driver.mjs                          # 全部城市，主轮（每城前 3 词）
//   node boss/boss-extract-driver.mjs --all                    # 全部城市，主+补充轮
//   node boss/boss-extract-driver.mjs --city 上海 --all         # 只扫上海全部词
//   node boss/boss-extract-driver.mjs --city 上海 --keywords "大数据开发,数仓"
//   BOSS_KEYWORD_GAP_SECONDS=0 node boss/boss-extract-driver.mjs --city 上海 --all   # 调试用：关间隔

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { resolveBossCityCode } from './boss-common.mjs';
import { loadBossControl } from './boss-config-db.mjs';
import { gotoUrl, closeAllConnections } from './boss-cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_COUNT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 去掉 shell 残留的包裹引号：Windows cmd.exe 不会剥离双引号，
// `--city "上海"` 传到 argv 时会变成 `"上海"`（含引号），导致城市码查不到。
function unquote(v) {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function parseArgs(argv) {
  const args = { mode: 'main', city: '', keywords: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--city') args.city = unquote(argv[++i] || '');
    else if (a === '--all') args.mode = 'all';
    else if (a === '--main') args.mode = 'main';
    else if (a === '--keywords') args.keywords = unquote(argv[++i] || '');
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === 'main' || a === 'all') args.mode = a;
  }
  return args;
}

function loadProfileBoss() {
  try {
    const profile = yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8')) || {};
    return profile.boss || {};
  } catch (e) {
    throw new Error(`读取 config/profile.yml 失败：${e.message}`);
  }
}

// 该城生效词表：每城词表(非空) > 统一词表，与 bash 版 city_keywords 一致
function cityKeywords(city, control, fallbackQueries) {
  const byCity = control.daily_extract_keywords_by_city || {};
  const list = Array.isArray(byCity[city]) && byCity[city].length ? byCity[city] : (control.daily_extract_queries || []);
  return list.length ? list : fallbackQueries;
}

function cityQuota(city, control) {
  const m = control.daily_limit_per_city;
  if (!m || typeof m !== 'object') return null;
  const q = m[city];
  return typeof q === 'number' && q > 0 ? q : null;
}

async function extractOne({ city, code, query, companyLimit, maxCards, dryRun }) {
  const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=${code}`;
  console.log('');
  console.log(`=== [${city}] ${dryRun ? '（dry-run 预演）' : '提取中'}（query=${query}, city=${code}, company-limit=${companyLimit}, max-cards=${maxCards}）===`);
  if (dryRun) {
    console.log(`[dry-run] 将导航：${url}`);
    console.log(`[dry-run] 将执行：node boss/boss-chrome-extract.mjs --city ${city} --company-limit ${companyLimit} --max-cards ${maxCards} --click-gap-ms 1800 --append`);
    return;
  }
  const out = await gotoUrl(url);
  if (!out.ok) throw new Error(`导航失败：${out.reason || out.url}`);
  console.log(`[goto] ${out.title || ''} | ${out.url}`);
  await sleep(3000);
  await new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['boss/boss-chrome-extract.mjs', '--city', city, '--company-limit', String(companyLimit), '--max-cards', String(maxCards), '--click-gap-ms', '1800', '--append'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    proc.on('close', (code2) => (code2 === 0 ? resolve() : reject(new Error(`boss-chrome-extract.mjs 退出码 ${code2}`))));
    proc.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MYSQL_PASSWORD) {
    console.error('[warn] 未设置 MYSQL_PASSWORD：若 boss-common 默认密码与当前库不一致，写库会失败。');
  }

  const profileBoss = loadProfileBoss();
  const profileCities = Array.isArray(profileBoss.daily_extract_cities) ? profileBoss.daily_extract_cities : [];
  const profileQueries = Array.isArray(profileBoss.daily_extract_queries) ? profileBoss.daily_extract_queries : [];
  if (!profileCities.length) throw new Error('config/profile.yml 缺少 boss.daily_extract_cities');

  const control = await loadBossControl().catch(() => ({}));
  const cities = args.city ? [args.city] : profileCities;

  const keywordGapSec = Number(process.env.BOSS_KEYWORD_GAP_SECONDS ?? 300);
  const cityGapSec = Number(process.env.BOSS_CITY_GAP_SECONDS ?? 600);
  const factor = Number(process.env.BOSS_SCAN_BUDGET_FACTOR || 1.3);

  const kwOverride = args.keywords ? args.keywords.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (kwOverride.length && !args.city) throw new Error('--keywords 必须配合 --city 使用');
  const mainCount = kwOverride.length ? kwOverride.length : MAIN_COUNT;

  let cityIdx = 0;
  for (const city of cities) {
    cityIdx++;
    if (cityIdx > 1 && cityGapSec > 0) {
      console.log(`（城市间隔休息 ${cityGapSec}s，降低风控压力…）`);
      await sleep(cityGapSec * 1000);
    }

    const code = resolveBossCityCode(city);
    if (!code) {
      console.log(`⚠ 未知城市 [${city}]，跳过（可在 boss-common.mjs BOSS_CITY_CODES 补城市码）`);
      continue;
    }

    const queries = kwOverride.length ? kwOverride : cityKeywords(city, control, profileQueries);
    if (!queries.length) {
      console.log(`⚠ 城市 [${city}] 无可用词表，跳过`);
      continue;
    }

    const quota = cityQuota(city, control);
    let mainLimit;
    let mainMax;
    let suppLimit;
    let suppMax;
    if (quota) {
      const budget = Math.max(1, Math.round(quota * factor));
      const numKw = Math.max(1, queries.length);
      const perKw = Math.max(1, Math.round(budget / numKw));
      mainLimit = perKw; mainMax = perKw * 5;
      suppLimit = perKw; suppMax = perKw * 5;
      console.log(`（${city} 投递上限 ${quota}/日 → 扫描预算 ≈ ${budget} 家，按 ${numKw} 词均分 ≈ ${perKw} 家/词）`);
    } else {
      mainLimit = 40; mainMax = 200;
      suppLimit = 30; suppMax = 120;
    }

    // 主轮：词表前 mainCount 个
    for (let i = 0; i < mainCount && i < queries.length; i++) {
      if (i > 0 && keywordGapSec > 0) {
        console.log(`（关键词间隔休息 ${keywordGapSec}s，降低风控压力…）`);
        if (!args.dryRun) await sleep(keywordGapSec * 1000);
      }
      await extractOne({ city, code, query: queries[i], companyLimit: mainLimit, maxCards: mainMax, dryRun: args.dryRun });
    }

    // 补充轮：其余词（仅 --all）
    if (args.mode === 'all') {
      for (let i = mainCount; i < queries.length; i++) {
        if (keywordGapSec > 0) {
          console.log(`（关键词间隔休息 ${keywordGapSec}s，降低风控压力…）`);
          if (!args.dryRun) await sleep(keywordGapSec * 1000);
        }
        await extractOne({ city, code, query: queries[i], companyLimit: suppLimit, maxCards: suppMax, dryRun: args.dryRun });
      }
    }
  }

  console.log('');
  console.log('=== 抓取完成（评分/排队请接 `npm run boss:score && npm run boss:fill -- --prepare`）===');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => closeAllConnections())
    .catch((err) => {
      console.error(`boss-extract-driver failed: ${err.message}`);
      closeAllConnections();
      process.exit(1);
    });
}
