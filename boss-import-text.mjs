#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { CANDIDATES_PATH, countUniqueCompanies, mergeJobs, parseArgs, readJson, writeJson } from './boss-common.mjs';

const BAD_JOB = /外包|派遣|猎头|驻场|某[^\\n]{0,12}公司/;
const NOISE = /^(首页|职位|公司|校园|海归|APP|消息|简历|搜索|热门职位|筛选|推荐|最新|登录|注册|客服|隐私政策|用户协议|反馈)$/;
const SALARY = /(\d+(?:\.\d+)?\s*[-~—至]\s*\d+(?:\.\d+)?\s*[Kk千]|薪资面议|\d+\s*[Kk千]\s*以上|\d+\s*[-~—至]\s*\d+\s*元)/;
const META = /(经验不限|在校|应届|本科|大专|硕士|博士|学历不限|\d+[-~—至]\d+年|无需经验|天前|小时前|分钟前|刚刚|活跃|在线)/;
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

function decodeBossText(text) {
  return String(text || '')
    .replace(/[\uE031-\uE03A]/g, (ch) => BOSS_SALARY_MAP.get(ch) || ch)
    .replace(/\uFFFC/g, '\n');
}

function readInput(args) {
  if (args.clipboard) return execFileSync('pbpaste', { encoding: 'utf-8' });
  const file = args.input || args._?.[0];
  if (!file) throw new Error('请提供 --input <file>，或使用 --clipboard 从剪贴板导入。');
  if (!existsSync(file)) throw new Error(`input file not found: ${file}`);
  return readFileSync(file, 'utf-8');
}

function cleanLines(text) {
  return decodeBossText(text)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !NOISE.test(line));
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/.*(清空|推荐|搜索|融资阶段)/, '')
    .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '')
    .trim();
}

function parseCompanyCity(raw) {
  const text = String(raw || '').replace(/\s+/g, '').replace(/\n+/g, '\n').trim();
  const cityMatch = text.match(/(深圳(?:·[\u4e00-\u9fa5A-Za-z0-9]+){0,2}|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)/);
  if (!cityMatch) return { company: text.split('\n').find(Boolean) || '', city: '' };
  const before = text.slice(0, cityMatch.index).split('\n').filter(Boolean);
  return { company: before[before.length - 1] || '', city: cityMatch[0] };
}

function splitCarriedCompany(raw) {
  const text = String(raw || '').replace(/\s+/g, '');
  const markerIndex = ['公司法务', '法务', '合规']
    .map((marker) => ({ marker, index: text.lastIndexOf(marker) }))
    .filter((item) => item.index > 0)
    .sort((a, b) => b.index - a.index)[0];
  if (!markerIndex) return { title: cleanTitle(text), carriedCompany: '', carriedCity: '' };
  const prefix = text.slice(0, markerIndex.index);
  const parsed = parseCompanyCity(prefix);
  if (!parsed.company || !parsed.city) return { title: cleanTitle(text), carriedCompany: '', carriedCity: '' };
  return {
    title: cleanTitle(text.slice(markerIndex.index)),
    carriedCompany: parsed.company,
    carriedCity: parsed.city,
  };
}

function normalizeCompactJob(job) {
  const split = splitCarriedCompany(job.title);
  if (split.carriedCompany) {
    return {
      ...job,
      title: split.title,
      company: job.company || split.carriedCompany,
      city: job.city || split.carriedCity,
    };
  }
  return job;
}

function parseCompactText(text, args = {}) {
  const compact = decodeBossText(text).replace(/\s+/g, '');
  const pattern = /(?<title>[\u4e00-\u9fa5A-Za-z0-9/（）()·\-]{2,48}?)(?<salary>\d+(?:\.\d+)?[-~—至]\d+(?:\.\d+)?K(?:·\d+薪)?)(?<exp>经验不限|无需经验|\d+[-~—至]\d+年)(?<degree>学历不限|大专|本科|硕士|博士)/g;
  const matches = [...compact.matchAll(pattern)];
  if (!matches.length) return [];

  const jobs = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const groups = match.groups || {};
    const next = matches[i + 1];
    const tail = compact.slice(match.index + match[0].length, next ? next.index : compact.length);
    const { title, carriedCompany, carriedCity } = splitCarriedCompany(groups.title);
    if (i > 0 && carriedCompany) {
      jobs[jobs.length - 1].company ||= carriedCompany;
      jobs[jobs.length - 1].city ||= carriedCity;
      jobs[jobs.length - 1].desc = `${jobs[jobs.length - 1].desc}\n${carriedCompany}\n${carriedCity}`.trim();
      jobs[jobs.length - 1].tags = [...jobs[jobs.length - 1].tags, carriedCompany, carriedCity].filter(Boolean);
    }
    const parsedTail = parseCompanyCity(tail);
    const company = next ? '' : parsedTail.company;
    const city = next ? '' : parsedTail.city;
    const blockText = `${title}\n${groups.salary}\n${groups.exp} ${groups.degree}\n${company}\n${city}\n${tail}`.trim();
    if (BAD_JOB.test(blockText)) continue;
    if (!title || title.length > 48) continue;
    jobs.push({
      source: 'boss-text',
      company,
      title,
      salary: groups.salary,
      city: args.city || city,
      desc: blockText,
      hr_active: tail.match(/刚刚活跃|在线|活跃|分钟前|小时前|天前/)?.[0] || '',
      tags: [title, groups.salary, groups.exp, groups.degree, city, company].filter(Boolean),
      url: args.url || '',
      can_chat: /立即沟通/.test(compact),
      already_contacted: false,
      scanned_at: new Date().toISOString(),
    });
  }
  return dedupeJobs(jobs.map(normalizeCompactJob).filter((job) => !BAD_JOB.test(`${job.company}\n${job.title}\n${job.desc}`)));
}

function isTitle(line) {
  return line.length <= 40 && !SALARY.test(line) && !META.test(line) && !BAD_JOB.test(line);
}

function pickTitle(lines, salaryIndex) {
  const index = pickTitleIndex(lines, salaryIndex);
  return index === -1 ? '' : lines[index];
}

function pickTitleIndex(lines, salaryIndex) {
  for (let i = salaryIndex - 1; i >= Math.max(0, salaryIndex - 6); i--) {
    if (isTitle(lines[i])) return i;
  }
  return -1;
}

function pickCompany(lines, salaryIndex, nextSalaryIndex) {
  const end = nextSalaryIndex === -1 ? Math.min(lines.length, salaryIndex + 14) : nextSalaryIndex;
  for (let i = salaryIndex + 1; i < end; i++) {
    const line = lines[i];
    if (!isTitle(line)) continue;
    if (/法务|合规|经理|主管|专员|律师|顾问|总监|负责人|岗|实习/.test(line)) continue;
    return line;
  }
  return '';
}

function pickCity(lines, salaryIndex, nextSalaryIndex) {
  const end = nextSalaryIndex === -1 ? Math.min(lines.length, salaryIndex + 10) : nextSalaryIndex;
  for (let i = salaryIndex; i < end; i++) {
    const match = lines[i].match(/(深圳|北京|上海|广州|杭州|成都|南京|苏州|武汉|西安|长沙|重庆|天津|长春|全国)(?:[·\s-][\u4e00-\u9fa5A-Za-z0-9]+)?/);
    if (match) return match[0];
  }
  return '';
}

function parseText(text, args = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  }

  const compactJobs = parseCompactText(trimmed, args);
  if (compactJobs.length >= 2) return compactJobs;

  const lines = cleanLines(trimmed);
  const salaryIndexes = lines
    .map((line, index) => (SALARY.test(line) ? index : -1))
    .filter((index) => index !== -1);

  const jobs = [];
  for (let s = 0; s < salaryIndexes.length; s++) {
    const salaryIndex = salaryIndexes[s];
    const nextSalaryIndex = salaryIndexes[s + 1] ?? -1;
    const titleIndex = pickTitleIndex(lines, salaryIndex);
    const start = titleIndex === -1 ? Math.max(0, salaryIndex - 1) : titleIndex;
    const end = nextSalaryIndex === -1 ? Math.min(lines.length, salaryIndex + 28) : Math.max(salaryIndex + 1, nextSalaryIndex - 1);
    const block = lines.slice(start, end);
    const blockText = block.join('\n');
    if (BAD_JOB.test(blockText)) continue;

    const title = titleIndex === -1 ? '' : lines[titleIndex];
    const salary = lines[salaryIndex].match(SALARY)?.[0] || lines[salaryIndex];
    const company = pickCompany(lines, salaryIndex, nextSalaryIndex);
    if (!title && !company) continue;

    jobs.push({
      source: 'boss-text',
      company,
      title,
      salary,
      city: args.city || pickCity(lines, salaryIndex, nextSalaryIndex),
      desc: blockText,
      hr_active: block.find((line) => /活跃|在线|刚刚|分钟前|小时前|天前/.test(line)) || '',
      tags: block.filter((line) => line.length <= 16).slice(0, 20),
      url: args.url || '',
      can_chat: false,
      already_contacted: false,
      scanned_at: new Date().toISOString(),
    });
  }

  return dedupeJobs(jobs);
}

function dedupeJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = `${job.company}::${job.title}::${job.salary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-import-text.mjs --input boss-page.txt [--output data/boss-candidates.json] [--append]\n       node boss-import-text.mjs --clipboard');
    return;
  }
  const text = readInput(args);
  const jobs = parseText(text, args);
  const output = args.output || CANDIDATES_PATH;
  const finalJobs = args.append ? mergeJobs(readJson(output, []), jobs) : jobs;
  writeJson(output, finalJobs);
  console.log(JSON.stringify({
    imported: jobs.length,
    total: finalJobs.length,
    uniqueCompanies: countUniqueCompanies(finalJobs),
    appended: Boolean(args.append),
    output,
    preview: finalJobs.slice(0, 5).map((job) => ({
      company: job.company,
      title: job.title,
      salary: job.salary,
      city: job.city,
    })),
  }, null, 2));
}

main().catch((err) => {
  console.error(`boss-import-text failed: ${err.message}`);
  process.exit(1);
});
