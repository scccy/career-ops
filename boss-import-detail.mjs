#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { CANDIDATES_PATH, countUniqueCompanies, mergeJobs, parseArgs, readJson, writeJson } from './boss-common.mjs';

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

function decodeBossText(text) {
  return String(text || '')
    .replace(/[\uE031-\uE03A]/g, (ch) => BOSS_SALARY_MAP.get(ch) || ch)
    .replace(/\uFFFC/g, '\n')
    .replace(/\r/g, '\n');
}

function readInput(args) {
  if (args.clipboard) return execFileSync('pbpaste', { encoding: 'utf-8' });
  const file = args.input || args._?.[0];
  if (!file) throw new Error('请提供 --input <file>，或使用 --clipboard 从剪贴板导入。');
  if (!existsSync(file)) throw new Error(`input file not found: ${file}`);
  return readFileSync(file, 'utf-8');
}

function getField(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`^\\s*${name}\\s*[:：]\\s*(.+)$`, 'm'));
    if (match) return match[1].trim();
  }
  return '';
}

function getDesc(block) {
  const marker = block.match(/^\s*(?:职位描述|岗位详情|完整JD|JD|描述|岗位职责|工作职责)\s*[:：]?\s*$/m);
  if (marker) return block.slice(marker.index + marker[0].length).trim();
  const firstHeading = block.search(DETAIL_HEADING);
  if (firstHeading !== -1) return block.slice(firstHeading).trim();
  return '';
}

function asBool(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (/^(true|yes|y|1|是|可|可以|有)$/i.test(text)) return true;
  if (/^(false|no|n|0|否|不可|没有|无)$/i.test(text)) return false;
  return fallback;
}

function validateDetail(job) {
  const desc = String(job.desc || '').replace(/\s+/g, '');
  if (desc.length < 180) return '岗位描述过短，疑似没有读取右侧详情 JD';
  if (!DETAIL_HEADING.test(desc)) return '未识别到岗位职责/任职要求等 JD 结构';
  if (!job.company || !job.title) return '缺少公司名或岗位名';
  return '';
}

function normalizeJob(raw, args = {}) {
  const job = {
    source: raw.source || 'boss-detail',
    company: raw.company || '',
    title: raw.title || raw.job || '',
    salary: decodeBossText(raw.salary || ''),
    city: raw.city || raw.location || args.city || '',
    desc: decodeBossText(raw.desc || raw.description || ''),
    hr_active: raw.hr_active || raw.hrActive || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    url: raw.url || '',
    can_chat: raw.can_chat !== undefined ? asBool(raw.can_chat, true) : asBool(args['can-chat'], true),
    already_contacted: asBool(raw.already_contacted, false),
    scanned_at: raw.scanned_at || new Date().toISOString(),
  };
  job.jd_detail = { ok: !validateDetail(job), reason: validateDetail(job) || '已包含右侧完整岗位详情' };
  return job;
}

function parseBlock(block, args) {
  const alreadyContacted = asBool(getField(block, ['是否已沟通', '已沟通', 'already_contacted']), false);
  const canChat = asBool(getField(block, ['是否可立即沟通', '可沟通', 'can_chat']), asBool(args['can-chat'], true));
  return normalizeJob({
    company: getField(block, ['公司', '公司名', 'company']),
    title: getField(block, ['岗位', '职位', '岗位名', 'title']),
    salary: getField(block, ['薪资', 'salary']),
    city: getField(block, ['城市', '地点', 'city']),
    hr_active: getField(block, ['HR活跃', '活跃时间', 'hr_active']),
    url: getField(block, ['URL', '链接', 'url']),
    can_chat: canChat,
    already_contacted: alreadyContacted,
    desc: getDesc(block),
  }, args);
}

function parseInput(text, args) {
  const decoded = decodeBossText(text).trim();
  if (!decoded) return [];
  if (decoded.startsWith('[')) return JSON.parse(decoded).map((job) => normalizeJob(job, args));
  return decoded
    .split(/\n\s*---+\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => parseBlock(block, args));
}

function dedupeJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = `${job.company}::${job.title}::${job.url || job.salary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`Usage:
node boss-import-detail.mjs --input boss-details.txt
node boss-import-detail.mjs --input boss-details.txt --append
node boss-import-detail.mjs --input data/boss-candidates-detailed.json --output data/boss-candidates.json

Text block format:
公司：公司名
岗位：岗位名
薪资：20-30K
城市：深圳
HR活跃：今日活跃
URL：https://www.zhipin.com/...
是否可立即沟通：是
职位描述：
岗位职责：
...
任职要求：
...
---`);
    return;
  }

  const jobs = dedupeJobs(parseInput(readInput(args), args));
  const invalid = jobs
    .map((job, index) => ({ index: index + 1, job, reason: validateDetail(job) }))
    .filter((item) => item.reason);
  if (invalid.length && !args['allow-incomplete']) {
    const details = invalid
      .slice(0, 8)
      .map((item) => `#${item.index} ${item.job.company || '未知公司'} - ${item.job.title || '未知岗位'}：${item.reason}`)
      .join('\n');
    throw new Error(`存在未读取完整 JD 的岗位，已停止导入：\n${details}`);
  }

  const output = args.output || CANDIDATES_PATH;
  const before = readJson(output, []);
  const finalJobs = args.append ? mergeJobs(before, jobs) : jobs;
  writeJson(output, finalJobs);
  console.log(JSON.stringify({
    imported: jobs.length,
    total: finalJobs.length,
    uniqueCompanies: countUniqueCompanies(finalJobs),
    appended: Boolean(args.append),
    invalid: invalid.length,
    output,
    preview: finalJobs.slice(0, 5).map((job) => ({
      company: job.company,
      title: job.title,
      salary: job.salary,
      city: job.city,
      jd_detail: job.jd_detail,
    })),
  }, null, 2));
}

main().catch((err) => {
  console.error(`boss-import-detail failed: ${err.message}`);
  process.exit(1);
});
