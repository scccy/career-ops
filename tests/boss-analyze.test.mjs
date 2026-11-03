// tests/boss-analyze.test.mjs — LLM 深解析（cv.md + JD → 标准 JSON）契约
//
// 2026-10-30 用户要求：「简历 md 和岗位 JD 一起发给模型，给一个标准模板，一次性全部解析存下来」，
// 并且「流程直接合并到评分里面」（点控制台「扫描」的一条龙里就做完）。
//
// 这里钉住五件最容易静默坏掉的事：
//   1. 标准模板能校验：模型返回半截/缺段/分数非法必须整条判失败，不许把脏数据写进库；
//   2. 提示词里既有简历原文也有 JD，且明确禁止编造（否则招呼语会变成编故事）；
//   3. 并进评分时只解析「过阈值」那批、增量跳过已解析的、有上限（否则一次扫描烧掉几百条 credit）；
//   4. 深解析给了文案就不再额外调用轻量招呼语（不重复付费）；
//   5. 落库位置是 raw.llm + llm_score 列，且**不动 score**（规则分仍是发送资格唯一权威）。
//
// Run: node test-all.mjs --only boss-analyze

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import {
  ANALYSIS_SCHEMA,
  ANALYSIS_SCHEMA_VERSION,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  extractJsonObject,
  normalizeAnalysis,
} from '../boss/boss-llm-schema.mjs';

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8');
const scoreSrc = read('boss', 'boss-score.mjs');
const analyzeSrc = read('boss', 'boss-analyze.mjs');
const commonSrc = read('boss', 'boss-common.mjs');
const schemaSrc = read('boss', 'pg-schema.mjs');
const serverSrc = read('boss', 'boss-web', 'server.mjs');
const html = read('boss', 'boss-web', 'index.html');

const validRaw = {
  job: {
    company: '示例数仓公司', title: '高级大数据开发工程师', city: '上海', salary: '35-55K',
    seniority: '高级', employment_type: '全职', is_outsourcing: false, jd_completeness: 'full',
    years_required: 5, education_required: '本科', tech_stack: ['Hive', 'Spark', 'Flink'],
    responsibilities: ['离线数仓建设', '实时链路优化'], domain: ['数据中台'],
    red_flags: [{ type: '要求不明确', quote: '薪资面议', reason: '薪资区间缺失' }], risk_level: 'medium',
  },
  match: {
    score: 4.2, level: '较匹配',
    matched: [{ jd_requirement: '离线数仓', resume_evidence: '负责过离线数仓建设' }],
    gaps: [{ requirement: 'Team 管理', severity: 'soft', note: '无带团队经历' }],
    why: '技术栈高度重合，缺管理经验',
  },
  greeting: { text: '您好，我做过离线数仓与实时链路建设，想了解团队规模，方便沟通吗？', basis: ['离线数仓建设'] },
};

// ── 模板与提示词 ───────────────────────────────────────────────────────────
test('标准模板自带版本号，且三段结构完整', () => {
  assert.ok(Number.isInteger(ANALYSIS_SCHEMA_VERSION) && ANALYSIS_SCHEMA_VERSION >= 1);
  for (const key of ['"job"', '"match"', '"greeting"', 'seniority', 'red_flags', 'resume_evidence', 'gaps']) {
    assert.ok(ANALYSIS_SCHEMA.includes(key), `模板必须包含 ${key}（改字段就升版本号）`);
  }
});

test('提示词：简历放 system（固定前缀吃缓存）、JD 放 user，并明确禁止编造', () => {
  const cv = '# 我的简历\n- 负责过离线数仓建设\n';
  const sys = buildAnalysisSystemPrompt(cv);
  assert.match(sys, /负责过离线数仓建设/, 'system 必须包含简历原文');
  assert.match(sys, /不得编造/, '必须禁止编造');
  assert.match(sys, /只输出一个 JSON 对象/, '必须要求严格 JSON');
  assert.match(sys, /【模板】/, '必须带上模板');
  assert.match(sys, /【我的简历】/);

  const user = buildAnalysisUserPrompt({ company: 'A', title: 'B', city: 'C', salary: 'D', desc: 'JD正文' });
  assert.match(user, /A/);
  assert.match(user, /JD正文/);
  assert.ok(!user.includes('负责过离线数仓建设'), '简历不能重复出现在 user 段（否则前缀缓存失效）');

  // JD 过长要截断并标注，避免把整篇长文塞进请求
  const long = buildAnalysisUserPrompt({ desc: 'x'.repeat(9000) }, { jdMaxChars: 100 });
  assert.match(long, /JD 过长已截断/);
});

// ── 校验 ───────────────────────────────────────────────────────────────────
test('合法返回：三段齐全、分数在 1–5 内即通过，并裁剪超长字段', () => {
  const r = normalizeAnalysis(validRaw);
  assert.equal(r.ok, true);
  assert.equal(r.data.schema_version, ANALYSIS_SCHEMA_VERSION);
  assert.equal(r.data.match.score, 4.2);
  assert.equal(r.data.job.seniority, '高级');
  assert.equal(r.data.job.risk_level, 'medium');
  assert.equal(r.data.greeting.text.length <= 160, true, '招呼语必须封顶 160 字');
  assert.deepEqual(r.data.job.tech_stack, ['Hive', 'Spark', 'Flink']);
});

test('缺段 / 分数非法 / 空招呼语：整条判失败（不写库），并说明原因', () => {
  const noGreeting = { ...validRaw, greeting: {} };
  const r1 = normalizeAnalysis(noGreeting);
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join('；'), /greeting\.text/);

  const badScore = { ...validRaw, match: { ...validRaw.match, score: 9 } };
  const r2 = normalizeAnalysis(badScore);
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join('；'), /match\.score/);

  const noMatch = { job: validRaw.job, greeting: validRaw.greeting };
  const r3 = normalizeAnalysis(noMatch);
  assert.equal(r3.ok, false);
  assert.match(r3.errors.join('；'), /缺少 match 段/);

  assert.equal(normalizeAnalysis(null).ok, false);
  assert.equal(normalizeAnalysis('不是对象').ok, false);
});

test('未知枚举回落默认值，不因模型写「资深」这类词就整条失败', () => {
  const r = normalizeAnalysis({
    ...validRaw,
    job: { ...validRaw.job, seniority: '资深', employment_type: '顾问', risk_level: '极高' },
    match: { ...validRaw.match, level: '挺合适' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.job.seniority, '未知');
  assert.equal(r.data.job.employment_type, '未知');
  assert.equal(r.data.job.risk_level, 'medium');
  assert.equal(r.data.match.level, '一般');
});

test('JSON 抠取：容忍代码围栏与前后废话，解析不了的返回 null', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('好的，结果如下：{"a":1} 以上。'), { a: 1 });
  assert.equal(extractJsonObject('完全不是 JSON'), null);
  assert.equal(extractJsonObject(''), null);
});

// ── 并进评分：花钱闸 + 复用 + 落库位置 ─────────────────────────────────────
test('并进评分：待处理岗位按「每批岗位数」切片，一个批次一次请求', () => {
  assert.match(scoreSrc, /const llmSummary = await applyLlmPass\(scored, profile, \{ args \}\)/, 'main 必须跑这一趟 LLM');
  assert.match(scoreSrc, /selectLlmTargets\(jobs, \{ force, cap, city \}\)/, '目标选择走统一的 selectLlmTargets');
  assert.match(scoreSrc, /analyzeJobsChunked\(\{/, '按批切片调用');
  assert.match(scoreSrc, /待处理 \$\{targets\.length\} 条 ÷ 每批 \$\{batchSize\} = \$\{batches\} 次请求/, '批次数由脚本算并打印出来');
  assert.match(scoreSrc, /args\['no-llm'\]/, '必须支持 --no-llm 关掉');
  assert.match(scoreSrc, /args\['llm-force'\]/, '必须支持 --llm-force 重跑');
  assert.match(scoreSrc, /args\['analyze-city'\]/, '单城扫描时只评估本城（--analyze-city）');
  assert.match(serverSrc, /--analyze-city/, '控制台单城扫描命令要带 --analyze-city');
});

test('增量：已有 LLM 结果的岗位不重复付费', () => {
  assert.match(scoreSrc, /job\.greeting_source = 'llm'/, '复用历史解析的文案统一标 llm（llm_analysis 只是历史标签）');
  assert.match(scoreSrc, /if \(!job\.llm\?\.match\) continue;/, '已有结果的先复用，不再调模型');
  assert.match(read('boss', 'boss-llm.mjs'), /const hasLlmResult = \(job\) => Boolean\(job\?\.llm && job\.llm\.match && job\.llm\.greeting\?\.text\)/, '选择函数要能识别「完整」结果（解析 + 文案）');
  assert.match(scoreSrc, /summary\.reused \+= 1/, '统计里要能看出复用了多少条');
});

test('落库：raw.llm + llm_score 列 + greetingSource，且不动 score 列', () => {
  assert.match(commonSrc, /export async function saveJobAnalysis/, '必须有 saveJobAnalysis');
  assert.match(commonSrc, /'llm', \?::jsonb/, '整份解析结果写进 raw.llm');
  assert.match(commonSrc, /llm_score = \?/, '匹配分写 llm_score 列');
  assert.match(commonSrc, /'greetingSource', \?::text/, '招呼语来源要落库');
  const saveSql = commonSrc.slice(commonSrc.indexOf('export async function saveJobAnalysis'), commonSrc.indexOf('评分回写'));
  // 只能写 llm_score，不能写规则分 score（lookbehind 排除 llm_score 的误匹配）
  assert.doesNotMatch(saveSql, /(?<!llm_)score = \?/, 'saveJobAnalysis 绝不能改规则分 score');
  // 列与新索引必须能对存量库幂等补上
  assert.match(schemaSrc, /ADD COLUMN IF NOT EXISTS llm_score NUMERIC\(4,2\)/, '存量库要有幂等补列');
  assert.match(schemaSrc, /idx_boss_jobs_llm_score/, 'llm_score 要有索引（排序/筛选）');
});

test('只有一个数量参数：控制台不再有「深解析上限 / 招呼语上限 / 解析预算」', () => {
  // 2026-10-30 用户明确要求：三个上限合成一个「每批岗位数」，批次数由脚本算
  assert.doesNotMatch(html, /id="fLlmAnalyzeLimit"/, '深解析上限输入框必须删掉');
  assert.doesNotMatch(html, /id="fLlmGreetingLimit"/, '招呼语上限输入框必须删掉');
  assert.doesNotMatch(html, /id="fLlmAnalyzeMaxTokens"/, '解析 max tokens 输入框必须删掉（自动推算）');
  assert.doesNotMatch(html, /id="fLlmAnalyzeTimeout"/, '解析超时输入框必须删掉（自动推算）');
  assert.match(html, /id="fLlmBatchSize"/, '保留唯一的「每批岗位数」');
  assert.match(html, /renderLlmBudget/, '页面上要把自动推算出来的预算/超时显示出来');
  assert.match(serverSrc, /\['batchSize', 'llm_analyze_batch_size', 1, 100\]/, '保存接口只校验这一个数量参数');
  assert.doesNotMatch(serverSrc, /body\.analyzeLimit/, '保存接口不该再接受 analyzeLimit');
  assert.doesNotMatch(serverSrc, /body\.greetingLimit/, '保存接口不该再接受 greetingLimit');
  assert.match(scoreSrc, /const batchSize = Math\.max\(1, Math\.min\(Number\(cfg\.batchSize\)/, '批大小只从 cfg.batchSize 来');
});

test('独立命令 boss:analyze 仍保留（补跑/点名解析），不依赖控制台', () => {
  assert.match(analyzeSrc, /export \{ selectJobs as selectAnalyzeJobs/, '筛选逻辑要可测');
  assert.match(analyzeSrc, /--limit/, '必须能限量');
  assert.match(analyzeSrc, /--key-hash/, '必须能点名');
  assert.match(analyzeSrc, /--dry-run/, '必须能只看不写');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['boss:analyze'], 'package.json 必须有 boss:analyze');
});

// ── 批量：一次请求 N 个岗位（用户 2026-10-30 要求）──────────────────────────
test('批量模板：编号用库里的 id（boss_jobs.id），没有 id 才退回序号', async () => {
  const { buildBatchAnalysisSystemPrompt, buildBatchAnalysisUserPrompt, BATCH_SCHEMA_VERSION, BATCH_SCHEMA, batchRefOf } =
    await import('../boss/boss-llm-schema.mjs');
  assert.equal(BATCH_SCHEMA_VERSION, 2);
  assert.match(BATCH_SCHEMA, /"analyses"/, '批量模板顶层必须是 analyses 数组');
  assert.match(BATCH_SCHEMA, /原样回填输入的岗位编号/, '模板要说明 id 是回填岗位编号');

  const sys = buildBatchAnalysisSystemPrompt('# 我的简历\n- 做过离线数仓');
  assert.match(sys, /做过离线数仓/);
  assert.match(sys, /不得编造/);
  assert.match(sys, /数组长度必须与输入岗位数完全一致/);

  // 有 dbId → 用库里的主键（日志/返回能直接回放；2026-10-30 用户提出）
  const withId = buildBatchAnalysisUserPrompt([
    { dbId: 82349, key_hash: 'a', company: 'A公司', title: '岗位1', desc: 'JD1' },
    { dbId: 82350, key_hash: 'b', company: 'B公司', title: '岗位2', desc: 'JD2' },
  ]);
  assert.match(withId, /【岗位 #82349】/);
  assert.match(withId, /【岗位 #82350】/);
  assert.ok(!withId.includes('【岗位 #1】'), '有主键时不要再用 1..N 序号');

  // 没有 dbId（手工 JSON 池）→ 退回序号
  const noId = buildBatchAnalysisUserPrompt([
    { key_hash: 'a', company: 'A公司', title: '岗位1', desc: 'JD1' },
    { key_hash: 'b', company: 'B公司', title: '岗位2', desc: 'JD2' },
  ]);
  assert.match(noId, /【岗位 #1】/);
  assert.match(noId, /【岗位 #2】/);
  assert.ok(!noId.includes('abc123hash'), 'id 不用长哈希：模型抄错一位就等于白花钱');

  assert.equal(batchRefOf({ dbId: 82349 }, 0), '82349');
  assert.equal(batchRefOf({}, 2), '3');
});

test('编号回填容错：模型抄错 5 位 id 时按位置对齐，不丢岗位', async () => {
  const { normalizeBatchAnalysis } = await import('../boss/boss-llm-schema.mjs');
  const jobs = [
    { dbId: 82349, key_hash: 'a', company: 'A' },
    { dbId: 82350, key_hash: 'b', company: 'B' },
    { dbId: 82351, key_hash: 'c', company: 'C' },
  ];
  const entry = (id, score) => ({ id, job: {}, match: { score, level: '一般', matched: [], gaps: [], why: 'x' }, greeting: { text: '您好，想了解一下这个岗位的情况，方便沟通吗？', basis: [] } });

  const exact = normalizeBatchAnalysis({ analyses: [entry('82349', 4), entry('82350', 3), entry('82351', 2)] }, jobs);
  assert.deepEqual(exact.items.map((i) => i.key_hash), ['a', 'b', 'c'], '按库里的 id 精确对齐');
  assert.equal(exact.errors.length, 0);

  // 第二条抄成 8235（少一位）：位置兜底认领，并留痕
  const typo = normalizeBatchAnalysis({ analyses: [entry('82349', 4), entry('8235', 3), entry('82351', 2)] }, jobs);
  assert.deepEqual(typo.items.map((i) => i.key_hash), ['a', 'b', 'c'], '抄错数字也要保住这条岗位');
  assert.equal(typo.missing.length, 0);
  assert.match(typo.errors.join('；'), /对不上，已按位置对齐/);
});

test('批量结果按 id 回填：遗漏的岗位进 missing，不整批静默丢弃', async () => {
  const { normalizeBatchAnalysis } = await import('../boss/boss-llm-schema.mjs');
  const jobs = [
    { key_hash: 'h1', company: 'A', title: 't1' },
    { key_hash: 'h2', company: 'B', title: 't2' },
    { key_hash: 'h3', company: 'C', title: 't3' },
  ];
  const entry = (id, score) => ({ id, job: {}, match: { score, level: '一般', matched: [], gaps: [], why: 'x' }, greeting: { text: '您好，想了解一下这个岗位的情况，方便沟通吗？', basis: [] } });

  const ok = normalizeBatchAnalysis({ analyses: [entry('1', 4), entry('2', 3), entry('3', 2)] }, jobs);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.items.map((i) => i.key_hash), ['h1', 'h2', 'h3']);
  assert.equal(ok.items[0].analysis.schema_version, 2);
  assert.equal(ok.missing.length, 0);

  const partial = normalizeBatchAnalysis({ analyses: [entry('1', 4), entry('3', 2)] }, jobs);
  assert.equal(partial.items.length, 2);
  assert.deepEqual(partial.missing, ['h2'], '漏掉的岗位必须报出来（交给上层拆批重试）');

  // 裸数组也认
  const bare = normalizeBatchAnalysis([entry('1', 4), entry('2', 3), entry('3', 2)], jobs);
  assert.equal(bare.items.length, 3);
  assert.equal(normalizeBatchAnalysis('不是对象', jobs).ok, false);
});

test('批量调用：按批大小切块；整批失败自动对半拆，直到单条', async () => {
  const { analyzeJobsChunked } = await import('../boss/boss-llm.mjs');
  const cfg = {
    enabled: true, protocol: 'chat', baseUrl: 'http://mock', model: 'm', apiKey: 'k',
    temperature: 0.3, maxTokens: 1000, batchSize: 30, reasoningEffort: 'high',
  };
  const jobs = Array.from({ length: 30 }, (_, i) => ({ key_hash: `h${i}`, company: `C${i}`, title: `t${i}`, desc: 'JD' }));

  // ① 全部成功：30 条 + 每批 30 → 1 次请求
  let calls = 0;
  const mkFetch = (responder) => async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const text = String(body.messages?.[1]?.content || '');
    const ids = [...text.matchAll(/【岗位 #(\d+)】/g)].map((m) => m[1]);
    const content = JSON.stringify(responder(ids, calls));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: {} }) };
  };
  const goodResp = (ids) => ({ analyses: ids.map((id) => ({ id, job: {}, match: { score: 4, level: '较匹配', matched: [], gaps: [], why: 'ok' }, greeting: { text: '您好，我做过数仓建设，方便沟通吗？', basis: [] } })) });

  const okRun = await analyzeJobsChunked({ jobs, cv: 'cv', cfg, fetchImpl: mkFetch(goodResp) });
  assert.equal(okRun.ok, 30);
  assert.equal(okRun.requests, 1, '30 条一批就应该只发 1 次请求');
  assert.equal(calls, 1);

  // ② 每批都失败：4 条 → 2+2 → 1+1（7 次），每条单条失败再二次补发 1 次（+4）= 11 次
  calls = 0;
  const boom = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'boom' } }) });
  const failRun = await analyzeJobsChunked({ jobs: jobs.slice(0, 4), cv: 'cv', cfg: { ...cfg, batchSize: 4 }, fetchImpl: boom });
  assert.equal(failRun.ok, 0);
  assert.equal(failRun.failed.length, 4);
  assert.equal(failRun.requests, 11, '4 条全失败 = 对半拆 7 次 + 每条二次补发 4 次');
  assert.equal(failRun.retries, 4, '每条只补发一次，不会无限重试');
  assert.equal(failRun.failed.length, 4, '补发仍失败才记 failed');
  assert.ok(failRun.fallbackSplits >= 3);

  // ③ 漏返回：只回 1 条 → 拆掉剩下 3 条继续要
  calls = 0;
  const partialRun = await analyzeJobsChunked({
    jobs: jobs.slice(0, 3), cv: 'cv', cfg: { ...cfg, batchSize: 3 },
    fetchImpl: mkFetch((ids) => ({ analyses: goodResp(ids).analyses.slice(0, 1) })),
  });
  assert.ok(partialRun.requests > 1, '模型漏返回时要拆批重试');
  assert.equal(partialRun.ok + partialRun.failed.length, 3, '每条岗位最终都要有结论');
});

test('批量落库：job.company/title 用库里的值补齐（批量模板不复述这类字段）', async () => {
  const { withJobIdentity } = await import('../boss/boss-llm-schema.mjs');
  const out = withJobIdentity({ job: { seniority: '高级' }, match: { score: 4 }, greeting: { text: 'hi' } }, { company: 'X公司', title: '岗位', city: '上海', salary: '20-30K' });
  assert.equal(out.job.company, 'X公司');
  assert.equal(out.job.title, '岗位');
  assert.equal(out.job.seniority, '高级');
});

// ── 思考链开关（省钱大头）──────────────────────────────────────────────────
test('关思维链：只对 chat/responses 生效，messages 协议不加该字段', async () => {
  const { buildLlmRequest } = await import('../boss/boss-llm.mjs');
  const base = { baseUrl: 'http://x', model: 'm', apiKey: 'k', maxTokens: 1000 };
  const off = buildLlmRequest({ ...base, protocol: 'chat', thinkingDisabled: true }, { system: 's', user: 'u', json: true });
  assert.deepEqual(off.body.thinking, { type: 'disabled' });
  assert.deepEqual(off.body.response_format, { type: 'json_object' });

  const on = buildLlmRequest({ ...base, protocol: 'chat', thinkingDisabled: false }, { system: 's', user: 'u' });
  assert.equal('thinking' in on.body, false, '没要求关就不能带这个网关扩展参数');

  const anthropic = buildLlmRequest({ ...base, protocol: 'messages', thinkingDisabled: true }, { system: 's', user: 'u' });
  assert.equal('thinking' in anthropic.body, false, 'messages 协议不用这个字段（Anthropic 语义不同）');

  // 配置归一：只有显式 true 才算打开
  const { normalizeLlmFields } = await import('../boss/boss-llm.mjs');
  assert.equal(normalizeLlmFields({ llm_thinking_disabled: true }).llm_thinking_disabled, true);
  assert.equal(normalizeLlmFields({ llm_thinking_disabled: 'yes' }).llm_thinking_disabled, false);
});

test('思维链吃光预算时，报错里要带上「本次预算 + 两条出路」', () => {
  const llmSrc = read('boss', 'boss-llm.mjs');
  assert.match(llmSrc, /本次预算 max tokens=\$\{autoBudgets\(1\)\.maxTokens\}/, '错误信息要报出本次预算');
  assert.match(llmSrc, /关闭思考链/, '要提示「关闭思考链」这条出路');
});

// ── 控制台详情弹窗（表格放不下招呼语全文，点开看）────────────────────────────
test('前端：招呼语/LLM 徽标可点击，弹窗拉 /api/jobs/llm 展示全文与解析明细', () => {
  assert.match(html, /id="jobMask"/, '必须有岗位详情弹窗');
  assert.match(html, /id="jmGreeting"/, '弹窗里要有招呼语全文容器');
  assert.match(html, /function openJobDetail\(keyHash\)/, '必须有 openJobDetail');
  assert.match(html, /fetch\('\/api\/jobs\/llm\?key_hash='/, '弹窗数据要按 key_hash 单条拉取');
  assert.match(html, /data-jm="\$\{esc\(m\.key_hash\)\}"/, '徽标必须带 key_hash 供点击');
  assert.match(html, /e\.target\.closest\('\[data-jm\]'\)/, '点击要用事件委托（表格每次渲染都会重建）');
  assert.match(html, /id="jmCopy"/, '弹窗要能复制招呼语');
  // 表格里不再塞整段文案，只留来源徽标
  assert.doesNotMatch(html, /title="\$\{esc\(text\)\}"/, '招呼语不应再靠 title 悬停看全文');
  assert.match(serverSrc, /url\.pathname === '\/api\/jobs\/llm'/, '服务端要有单岗位详情接口');
  assert.match(serverSrc, /greetingSource: r\.greeting_source/, '详情接口要返回招呼语来源');
});

test('llm_score 是派生列：整池重写不能把它写丢，且启动时幂等回填', () => {
  assert.match(commonSrc, /'score', 'llm_score', 'status'/, 'JOB_COLUMNS 必须含 llm_score（否则 TRUNCATE+INSERT 会清空）');
  assert.match(commonSrc, /export function llmScoreOrNull/, '要有从 raw.llm.match.score 反推的兜底');
  assert.match(commonSrc, /llmScoreOrNull\(job\)/, 'jobRow 必须用兜底值');
  assert.match(schemaSrc, /UPDATE boss_jobs SET llm_score = \(raw->'llm'->'match'->>'score'\)::numeric/, '启动时要回填历史空值');
  assert.match(serverSrc, /coalesce\(llm_score, \(raw->'llm'->'match'->>'score'\)::numeric\) AS llm_score/, '列表读取也要 coalesce 兜底');
});

test('已发送/已联系的岗位一律跳过（省下来的都是真金白银）', () => {
  const llmSrc = read('boss', 'boss-llm.mjs');
  assert.match(llmSrc, /if \(isContacted\(job\)\) \{ summary\.skippedContacted \+= 1; return false; \}/,
    'selectLlmTargets 必须先排除已联系的岗位');
  assert.match(scoreSrc, /selectLlmTargets\(jobs, \{ force, cap, city \}\)/, 'boss-score 必须走这个选择函数');
  const analyzeSrc = read('boss', 'boss-analyze.mjs');
  assert.match(analyzeSrc, /if \(isContacted\(job\)\) return false/, '独立命令的 selectJobs 也要跳过已联系的');
  assert.match(llmSrc, /export function isContacted/, '判定逻辑集中在 boss-llm.mjs');
});

// ── 控制台 ─────────────────────────────────────────────────────────────────
test('控制台：只有一个数量参数，列表能看到 LLM 参考分', () => {
  for (const id of ['fLlmAnalyze', 'fLlmBatchSize', 'fLlmReasoningEffort']) {
    assert.match(html, new RegExp(`id="${id}"`), `控制台缺少 ${id}`);
  }
  assert.match(html, /analyzeEnabled:document\.getElementById\('fLlmAnalyze'\)\.checked/, '载荷必须带 analyzeEnabled');
  assert.match(html, /batchSize:num\('fLlmBatchSize'/, '载荷必须带 batchSize（唯一数量参数）');
  assert.match(html, /function llmBadge\(m\)/, '列表必须有 LLM 参考分徽标');
  assert.match(html, /data-sort="llm"[^>]*>LLM<i class="sarw"><\/i><\/th>/, '列表必须有 LLM 列（且可点排序）');
  assert.match(html, /value="llm_desc"/, '必须能按 LLM 匹配分排序');
  assert.match(html, /greetingSource==='llm_analysis'/, '招呼语徽标要区分「历史解析」来源');

  assert.match(serverSrc, /llmScore: r\.llm_score == null \? null : Number\(r\.llm_score\)/, '/api/jobs 必须带出 llmScore');
  assert.match(serverSrc, /analyze: 'npm run boss:analyze/, '执行白名单要有补跑入口');
  assert.match(serverSrc, /\['batchSize', 'llm_analyze_batch_size', 1, 100\]/, '每批条数必须有区间校验');
  assert.match(serverSrc, /body\.thinkingDisabled/, '保存接口必须接受 thinkingDisabled');
  assert.match(html, /id="fLlmNoThinking"/, '控制台要有「关闭思考链」开关');
});

// ── 入库规则审计（2026-10-30）：文案不能倒退、残缺记录要重跑、写库要核对命中行数 ──
test("入库规则：整池评分不得用模板文案覆盖已有的 LLM 文案", () => {
  const start = commonSrc.indexOf("export async function persistJobScores");
  const sql = commonSrc.slice(start, commonSrc.indexOf("export async function saveCandidates", start));
  assert.match(sql, /'greeting', CASE/, "greeting 必须有条件更新，不能无条件覆盖");
  assert.match(sql, /WHEN \?::text = 'template' AND COALESCE\(raw->>'greetingSource', ''\) IN \('llm', 'llm_analysis'\)/,
    "只有当本轮是模板、且库里已是 LLM 文案时才保留旧值");
  assert.match(sql, /'greetingSource', CASE/, "来源字段同样不能倒退");
  // 占位符数量必须与参数个数一致（CASE 里多加的 ? 很容易错位）
  const stmt = sql.match(/`UPDATE[\s\S]*?key_hash = \?`/)[0];
  assert.equal((stmt.match(/\?/g) || []).length, 11, "UPDATE 的 ? 数量必须与参数顺序一致（11 个）");
});

test("入库规则：残缺记录（有解析没文案）要被重跑，不能永久跳过", () => {
  const llmSrc = read("boss", "boss-llm.mjs");
  assert.match(llmSrc, /const hasLlmResult = \(job\) => Boolean\(job\?\.llm && job\.llm\.match && job\.llm\.greeting\?\.text\)/,
    "「已完成」必须是完整记录");
});

test("入库规则：写库 0 行命中要计失败，不能把「日志成功、库里没有」当成功", () => {
  assert.match(scoreSrc, /const affected = await saveJobAnalysis\(/, "必须拿到 affectedRows");
  assert.match(scoreSrc, /if \(affected\) stored = true;/, "命中才算成功");
  assert.match(scoreSrc, /else summary\.failed \+= 1;/, "未命中要计入失败");
});

test("整池写入：不再 TRUNCATE，按 key_hash 幂等 upsert（id 才稳定）", () => {
  const start = commonSrc.indexOf("export async function saveCandidates");
  const fn = commonSrc.slice(start, commonSrc.indexOf("export async function upsertJobs", start));
  assert.doesNotMatch(fn, /TRUNCATE TABLE boss_jobs/, "不能再整表清空：那会让 id 每次重写都变（实测 2629 行 id 已到 8 万多）");
  assert.match(fn, /ON CONFLICT \(key_hash\) DO UPDATE SET/, "同一岗位必须命中同一行");
  assert.match(fn, /COALESCE\(boss_jobs\.raw/, "raw 必须与旧值合并，否则扫描会抹掉 llm/greeting");
  assert.match(fn, /\|\| EXCLUDED\.raw/, "合并方向：旧值在前，新扫描的键覆盖同名键");
  assert.match(fn, /unique\.flatMap\(jobRow\)/, "参数必须与去重后的行对齐（否则参数错位）");
  assert.match(fn, /c === 'score' \|\| c === 'llm_score'\) return `\$\{c\} = COALESCE\(EXCLUDED\.\$\{c\}, boss_jobs\.\$\{c\}\)`/,
    "score / llm_score 都要 COALESCE：扫描对象不带分数时不能把旧值写成 NULL");
  assert.match(fn, /const preserved = new Set\(\[/, "人工维护的列要显式列出保持旧值");
  for (const col of ["greeted", "contact_state", "status", "availability", "manual_excluded"]) {
    assert.ok(fn.includes(`'${col}'`), `${col} 必须保持旧值（由发送/复核流程维护，扫描不该重置）`);
  }
  assert.match(fn, /byKey\.set\(candidateKeyHash\(job\), job\)/, "同批次重复 key_hash 要先去重（否则 ON CONFLICT 会报错）");
});

// ── 点列头排序（2026-10-30 用户要求）──────────────────────────────────────
test('控制台：分数/LLM/薪资列头可点击排序，升序时没分的仍沉底', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../boss/boss-web/index.html', import.meta.url), 'utf-8');
  const server = readFileSync(new URL('../boss/boss-web/server.mjs', import.meta.url), 'utf-8');

  // 列头
  for (const col of ['llm', 'score', 'salary']) {
    assert.match(html, new RegExp(`th class="sortable" data-sort="${col}"`), `${col} 列表头必须可点`);
  }
  assert.match(html, /const SORT_COLUMNS = \{ salary: \["salary_desc","salary_asc"\], score: \["score_desc","score_asc"\], llm: \["llm_desc","llm_asc"\] \}/, '升降序成对定义');
  assert.match(html, /function toggleSortByColumn\(name\)/, '点一次翻转升降序');
  assert.match(html, /th\.sortable \.sarw/, '要有箭头样式');
  assert.match(html, /syncSortHeaders/, '下拉与列头箭头要同步');

  // 后端排序分支
  for (const key of ['llm_desc', 'llm_asc', 'score_asc', 'salary_asc']) {
    assert.match(server, new RegExp(`${key}: `), `orderMap 要有 ${key}`);
  }
  // NULLS LAST 语义：升序也不能把空值顶到最前
  assert.match(server, /llm_asc: `\(coalesce\(llm_score[^`]*\)\) IS NULL,/, 'llm_asc 必须 IS NULL 前置');
  assert.match(server, /score_asc: 'score IS NULL, score ASC/, 'score_asc 必须 IS NULL 前置');
});
