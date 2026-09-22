#!/usr/bin/env node

import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import {
  QUEUE_PATH,
  ensureDirFor,
  parseArgs,
  readJson,
  todayIso,
  uniqueCompanyKey,
} from './boss-common.mjs';

const REVIEW_PATH = 'data/boss-review.md';
const REVIEW_JSON_PATH = 'data/boss-review.json';

function compactRequirement(job) {
  const desc = String(job.desc || '').replace(/\s+/g, ' ').trim();
  const parts = [];
  const duty = pickSection(desc, ['岗位职责', '工作职责', '职责描述', '主要职责', '工作内容']);
  const req = pickSection(desc, ['任职要求', '职位要求', '岗位要求', '任职资格', '职位描述']);
  const focus = [
    ...list(job.greeting_basis?.jd_focus),
    ...list(job.greeting_basis?.skills),
  ].slice(0, 4);
  if (focus.length) parts.push(`关键词：${[...new Set(focus)].join('、')}`);
  if (duty) parts.push(cleanSentence(duty));
  if (req) parts.push(cleanSentence(req));
  return parts.join('；').slice(0, 130) || desc.slice(0, 130);
}

function pickSection(text, headings) {
  for (const heading of headings) {
    const index = text.indexOf(heading);
    if (index === -1) continue;
    return text.slice(index + heading.length).replace(/^[:：\s]+/, '').slice(0, 180);
  }
  return '';
}

function cleanSentence(text) {
  return String(text || '')
    .replace(/\d+[、.．]\s*/g, '')
    .replace(/[；;。].*$/, '')
    .trim();
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function topCompanies(queue, limit) {
  const seen = new Set();
  return queue
    .slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .filter((job) => {
      const key = uniqueCompanyKey(job);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function renderMarkdown(jobs, { threshold, limit }) {
  const rows = jobs.map((job, index) => [
    index + 1,
    job.company || '',
    job.salary || '',
    job.title || '',
    `${job.score ?? ''}`,
    compactRequirement(job).replace(/\|/g, '/'),
  ]);
  return `# BOSS 打招呼前确认清单\n\n生成日期：${todayIso()}\n\n规则：按评分从高到低取前 ${limit} 家；最近 30 天已沟通过公司已排除；阈值 ${threshold}/5。\n\n请先把下表展示给用户，用户明确确认后，才允许进入真实发送。\n\n| # | 公司 | 薪资 | 岗位 | 评分 | 简要职位要求 |\n|---:|---|---|---|---:|---|\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n## 发送前确认\n\n- 状态：待用户确认\n- 确认后执行：\`npm run boss:chrome:apply -- --threshold ${threshold} --daily-limit ${limit} --confirmed-review\`\n`;
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log('Usage: node boss-review.mjs --input data/boss-queue.json --limit 20 --threshold 4.0');
    return;
  }
  const input = args.input || QUEUE_PATH;
  const limit = Number(args.limit || args['daily-limit'] || 20);
  const threshold = Number(args.threshold || 4.0);
  const queue = readJson(input, []);
  const jobs = topCompanies(queue, limit);
  const markdown = renderMarkdown(jobs, { threshold, limit });
  const output = args.output || REVIEW_PATH;
  const jsonOutput = args['json-output'] || REVIEW_JSON_PATH;
  ensureDirFor(output);
  writeFileSync(output, markdown, 'utf-8');
  writeFileSync(jsonOutput, `${JSON.stringify({
    date: todayIso(),
    threshold,
    limit,
    count: jobs.length,
    status: 'pending_user_confirmation',
    jobs: jobs.map((job, index) => ({
      rank: index + 1,
      company: job.company,
      title: job.title,
      salary: job.salary,
      city: job.city,
      score: job.score,
      requirement: compactRequirement(job),
      greeting: job.greeting,
    })),
  }, null, 2)}\n`, 'utf-8');
  console.log(JSON.stringify({
    input,
    output,
    jsonOutput,
    count: jobs.length,
    status: 'pending_user_confirmation',
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
