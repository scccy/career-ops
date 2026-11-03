// tests/boss-llm.test.mjs — LLM 招呼语：配置归一 / 三种协议 / 失败回落模板 / 控制台接线
//
// 2026-10-30 用户要求：「npm run boss:score 生成的招呼语改成 LLM 写」，且控制台可选
// base url + 模型 + 协议（chat / responses / messages）。这里钉住四件最容易静默坏掉的事：
//   1. 协议 → 端点/请求体/鉴权头的映射（选错协议只会 400，不会报错到用户面前）；
//   2. LLM 任何失败都必须回落模板文案 —— 空招呼语会被 boss:chrome:apply 拒发，等于整天白扫；
//   3. API Key 绝不能出现在回给浏览器的 JSON 里（控制台无鉴权、局域网可访问）；
//   4. 配置必须仍然只存在 PostgreSQL boss_config 这一行（不新增第二个来源）。
//
// Run: node test-all.mjs --only boss-llm

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import {
  DEFAULT_SYSTEM_PROMPT,
  LLM_FALLBACK,
  analyzeJobsChunked,
  autoBudgets,
  buildGreetingPrompt,
  buildLlmRequest,
  coerceGreeting,
  llmReadiness,
  llmStatusForClient,
  mapWithConcurrency,
  maskKey,
  normalizeBaseUrl,
  normalizeLlmFields,
  parseLlmResponse,
  resolveEndpoint,
  resolveGreeting,
  resolveLlmConfig,
} from '../boss/boss-llm.mjs';
import { normalize as normalizeControl } from '../boss/boss-config-db.mjs';

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf-8');
const html = read('boss', 'boss-web', 'index.html');
const serverSrc = read('boss', 'boss-web', 'server.mjs');
const scoreSrc = read('boss', 'boss-score.mjs');

const baseCfg = {
  enabled: true,
  protocol: 'chat',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test-1234567890',
  temperature: 0.6,
  maxTokens: 400,
  timeoutMs: 5000,
  concurrency: 2,
  prompt: '',
};

// ── 配置归一 ───────────────────────────────────────────────────────────────
test('配置归一：缺省值 / 协议白名单 / base url 校验 / 数值区间', () => {
  const empty = normalizeLlmFields({});
  assert.deepEqual(empty, LLM_FALLBACK, '空配置必须等于内置默认值');

  assert.equal(normalizeLlmFields({ llm_protocol: 'messages' }).llm_protocol, 'messages');
  assert.equal(normalizeLlmFields({ llm_protocol: 'MESSAGES' }).llm_protocol, 'messages', '协议大小写不敏感');
  assert.equal(normalizeLlmFields({ llm_protocol: 'grpc' }).llm_protocol, 'chat', '未知协议回落 chat，不能留空');

  assert.equal(normalizeLlmFields({ llm_base_url: 'https://x.com/v1/' }).llm_base_url, 'https://x.com/v1', '去掉末尾斜杠');
  assert.equal(normalizeLlmFields({ llm_base_url: 'x.com' }).llm_base_url, '', '没有 http(s) 前缀视为没填');
  assert.equal(normalizeBaseUrl('  http://127.0.0.1:11434/v1  '), 'http://127.0.0.1:11434/v1');

  assert.equal(normalizeLlmFields({ llm_temperature: 9 }).llm_temperature, LLM_FALLBACK.llm_temperature, '温度越界回落默认');
  assert.equal(normalizeLlmFields({ llm_concurrency: 0 }).llm_concurrency, LLM_FALLBACK.llm_concurrency, '并发至少 1');
  assert.equal(normalizeLlmFields({ llm_timeout_ms: 10 }).llm_timeout_ms, LLM_FALLBACK.llm_timeout_ms, '超时下限 1000ms');
  assert.ok(LLM_FALLBACK.llm_max_tokens >= 1000, '默认 max tokens 必须够推理模型用（实测 400 会被思维链吃光）');
  assert.equal(normalizeLlmFields({ llm_enabled: 'true' }).llm_enabled, false, '只有布尔 true 才算启用（字符串不算）');
});

test('配置仍然只存 boss_config 一行：normalize() 带上全部 llm_* 字段', () => {
  const cfg = normalizeControl({ llm_enabled: true, llm_protocol: 'responses', llm_model: 'gpt-4o-mini' });
  assert.equal(cfg.llm_enabled, true);
  assert.equal(cfg.llm_protocol, 'responses');
  assert.equal(cfg.llm_model, 'gpt-4o-mini');
  for (const key of Object.keys(LLM_FALLBACK)) {
    assert.ok(key in cfg, `boss_config 归一结果必须含 ${key}（否则保存后被 normalize 抹掉）`);
  }
  // 原有字段不能被 llm_* 的合并挤掉
  assert.ok('send_threshold' in cfg && 'skip_words' in cfg);
});

test('环境变量只补空字段：控制台填过的值优先', () => {
  const fromEnv = resolveLlmConfig({}, {
    BOSS_LLM_BASE_URL: 'https://env.example/v1',
    BOSS_LLM_MODEL: 'env-model',
    BOSS_LLM_API_KEY: 'sk-env',
    BOSS_LLM_PROTOCOL: 'messages',
    BOSS_LLM_ENABLED: 'true',
  });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.baseUrl, 'https://env.example/v1');
  assert.equal(fromEnv.model, 'env-model');
  assert.equal(fromEnv.protocol, 'messages');
  assert.equal(fromEnv.keySource, 'env');

  const dbWins = resolveLlmConfig(
    { llm_enabled: true, llm_base_url: 'https://db.example/v1', llm_model: 'db-model', llm_api_key: 'sk-db' },
    { BOSS_LLM_BASE_URL: 'https://env.example/v1', BOSS_LLM_MODEL: 'env-model', BOSS_LLM_API_KEY: 'sk-env' },
  );
  assert.equal(dbWins.baseUrl, 'https://db.example/v1', 'DB 填了就不能被环境变量盖掉');
  assert.equal(dbWins.model, 'db-model');
  assert.equal(dbWins.keySource, 'db');

  // 没启用就是不启用：环境变量有值也不会自动打开（避免意外产生费用）
  assert.equal(resolveLlmConfig({ llm_base_url: 'https://db.example' }, { BOSS_LLM_API_KEY: 'k' }).enabled, false);
});

test('未就绪原因要说人话，且本地模型可以不配 key', () => {
  assert.match(llmReadiness({ enabled: false }).reason, /未启用/);
  assert.match(llmReadiness({ enabled: true, baseUrl: '', model: 'm' }).reason, /base url/);
  assert.match(llmReadiness({ enabled: true, baseUrl: 'https://x', model: '' }).reason, /模型/);
  assert.equal(llmReadiness({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen' }).ok, true,
    '本地 Ollama 没有 key 也必须算就绪');
});

// ── 三种协议 ───────────────────────────────────────────────────────────────
test('端点拼接：三种协议 + 贴完整端点时不重复拼接', () => {
  assert.equal(resolveEndpoint('https://api.deepseek.com', 'chat'), 'https://api.deepseek.com/chat/completions');
  assert.equal(resolveEndpoint('https://api.openai.com/v1', 'chat'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(resolveEndpoint('https://api.openai.com/v1', 'responses'), 'https://api.openai.com/v1/responses');
  assert.equal(resolveEndpoint('https://api.anthropic.com/v1', 'messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(resolveEndpoint('https://x.com/v1/chat/completions', 'chat'), 'https://x.com/v1/chat/completions');
  assert.equal(resolveEndpoint('', 'chat'), '');
});

test('chat 协议：Bearer 鉴权 + system/user 两条消息', () => {
  const { url, headers, body } = buildLlmRequest(baseCfg, { system: 'S', user: 'U' });
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(headers.authorization, 'Bearer sk-test-1234567890');
  assert.equal(body.model, 'deepseek-chat');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  assert.equal(body.max_tokens, 400);
  assert.equal(body.temperature, 0.6);
});

test('responses 协议：instructions + input，且不带 temperature（推理模型会 400）', () => {
  const { url, headers, body } = buildLlmRequest({ ...baseCfg, protocol: 'responses' }, { system: 'S', user: 'U' });
  assert.equal(url, 'https://api.deepseek.com/responses');
  assert.equal(headers.authorization, 'Bearer sk-test-1234567890');
  assert.equal(body.instructions, 'S');
  assert.equal(body.input, 'U');
  assert.equal(body.max_output_tokens, 400);
  assert.ok(!('temperature' in body), 'responses 不得带 temperature');
  assert.ok(!('messages' in body));
});

test('messages 协议：x-api-key + anthropic-version + 顶层 system', () => {
  const { url, headers, body } = buildLlmRequest({ ...baseCfg, protocol: 'messages' }, { system: 'S', user: 'U' });
  assert.equal(url, 'https://api.deepseek.com/messages');
  assert.equal(headers['x-api-key'], 'sk-test-1234567890');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(body.system, 'S');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'U' }]);
  assert.ok(body.max_tokens > 0, 'Anthropic 必填 max_tokens');
  assert.ok(!('authorization' in headers));
});

test('响应解析：三种协议的形状都能取到正文，错误形状抛出可读信息', () => {
  assert.equal(parseLlmResponse('chat', { choices: [{ message: { content: '你好' } }] }), '你好');
  assert.equal(parseLlmResponse('chat', { choices: [{ message: { content: [{ type: 'text', text: '分块' }] } }] }), '分块');
  assert.equal(parseLlmResponse('responses', { output_text: '你好' }), '你好');
  assert.equal(
    parseLlmResponse('responses', { output: [{ content: [{ type: 'output_text', text: '你好' }] }] }),
    '你好',
  );
  assert.equal(parseLlmResponse('messages', { content: [{ type: 'text', text: '你好' }] }), '你好');
  assert.throws(() => parseLlmResponse('chat', { error: { message: 'invalid api key' } }), /invalid api key/);
  assert.throws(() => parseLlmResponse('chat', { choices: [] }), /为空/);
});

// 推理模型（DeepSeek v4 / o 系 / glm-5）把思维链算在 max_tokens 里：预算太小 → 正文为空但 HTTP 200。
// 这种失败必须说清是「max tokens 太小」，否则用户只会看到「返回内容为空」并以为服务没配好。
test('空正文要能诊断出「思维链吃光 max tokens」', () => {
  const reasoningOnly = {
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
    usage: { completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 400 } },
  };
  assert.throws(
    () => parseLlmResponse('chat', reasoningOnly),
    /reasoning_tokens=400[\s\S]*1500/,
    '必须给出可执行建议（调大 max tokens）',
  );
  const truncated = { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} };
  assert.throws(() => parseLlmResponse('chat', truncated), /截断/);
  // 正常回复不受影响
  assert.equal(parseLlmResponse('chat', { choices: [{ message: { content: '正常文案' } }] }), '正常文案');
});

// ── 文案清洗 ───────────────────────────────────────────────────────────────
test('文案清洗：去包装/前缀/分点，长度封顶，太短视为无效', () => {
  assert.equal(coerceGreeting('“您好，我做过数仓建设，方便沟通吗？”'), '您好，我做过数仓建设，方便沟通吗？');
  assert.equal(coerceGreeting('```text\n您好，我做过数仓建设，方便沟通吗？\n```'), '您好，我做过数仓建设，方便沟通吗？');
  assert.equal(coerceGreeting('打招呼文案：您好，我做过数仓建设，方便沟通吗？'), '您好，我做过数仓建设，方便沟通吗？');
  assert.equal(
    coerceGreeting('- 您好，我做过数仓建设。\n- 想了解这个岗位。'),
    '您好，我做过数仓建设。想了解这个岗位。',
    '分点必须压成一段话（BOSS 输入框里多行很难看）',
  );
  assert.equal(coerceGreeting('好的'), '', '太短（可能是拒绝或格式说明）必须判无效');
  assert.equal(coerceGreeting(''), '');
  const long = '您好，'.repeat(80);
  assert.ok(coerceGreeting(long).length <= 160, '超长必须截断到 160 字以内');
});

// ── 失败回落 ───────────────────────────────────────────────────────────────
const okFetch = (content) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
});
const failFetch = (status = 401, message = 'invalid api key') => async () => ({
  ok: false,
  status,
  text: async () => JSON.stringify({ error: { message } }),
});

test('LLM 成功：用模型文案，来源标 llm', async () => {
  const job = { greeting: '模板文案模板文案模板文案', greeting_basis: { skills: ['数仓'], jd_focus: [], evidence: [] } };
  const r = await resolveGreeting({
    job, profile: { skills: { core: ['数仓'] } }, cfg: baseCfg,
    fetchImpl: okFetch('您好，我做过离线数仓建设，想了解这个岗位的数据规模，方便沟通吗？'),
  });
  assert.equal(r.source, 'llm');
  assert.match(r.text, /离线数仓/);
  assert.ok(!r.text.includes('模板文案'));
});

test('LLM 失败/超时/返回空：必须回落模板文案，绝不返回空字符串', async () => {
  const job = { greeting: '您好，我做过数仓相关工作，方便沟通吗？' };
  for (const impl of [failFetch(), okFetch('   '), (async () => { throw new Error('timeout'); })]) {
    const r = await resolveGreeting({ job, profile: {}, cfg: baseCfg, fetchImpl: impl });
    assert.equal(r.source, 'template');
    assert.equal(r.text, job.greeting, '回落时必须原样使用模板文案');
    assert.ok(r.error, '必须给出失败原因，别让用户以为 LLM 生效了');
  }
});

test('未启用 LLM：不发起任何请求，直接用模板', async () => {
  let called = false;
  const r = await resolveGreeting({
    job: { greeting: '模板文案' },
    cfg: { ...baseCfg, enabled: false },
    fetchImpl: async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; },
  });
  assert.equal(called, false, '没启用就不该产生网络请求/费用');
  assert.equal(r.text, '模板文案');
  assert.equal(r.source, 'template');
});

test('提示词：带上岗位信息与画像事实，并禁止编造', () => {
  const { system, user } = buildGreetingPrompt({
    job: { company: '某公司', title: '数仓工程师', city: '上海', salary: '30-50K', desc: '岗位职责：建设离线数仓' },
    profile: { candidate: { current_title: '数据开发' }, target: { roles: ['数仓工程师'] }, skills: { core: ['Hive', 'Spark'] }, boss: { greeting_style: '简洁直接' } },
    context: { skills: ['Hive'], jd_focus: ['数仓'], evidence: ['负责过离线链路'] },
    style: '简洁直接',
  });
  assert.match(user, /某公司/);
  assert.match(user, /数仓工程师/);
  assert.match(user, /Hive/);
  assert.match(user, /只可用这些事实/);
  assert.match(system, /编造/);
  assert.equal(system, DEFAULT_SYSTEM_PROMPT);
});

test('token 上限填 0 = 不限制（不传该参数），不是回落到默认值', () => {
  // 与仓库里 max_dom_cards: 0 = 不限 的约定保持一致（2026-10-30 用户要求）
  assert.equal(normalizeLlmFields({ llm_max_tokens: 0 }).llm_max_tokens, 0, '0 必须原样保留，不能回落 1500');
  assert.equal(normalizeLlmFields({ llm_max_tokens: -5 }).llm_max_tokens, LLM_FALLBACK.llm_max_tokens, '负数才回落默认');

  const base = { baseUrl: 'http://x', model: 'm', apiKey: 'k' };
  for (const protocol of ['chat', 'responses']) {
    const { body } = buildLlmRequest({ ...base, protocol, maxTokens: 0 }, { system: 's', user: 'u' });
    assert.equal('max_tokens' in body, false, `${protocol}：0 时不得带 max_tokens`);
    assert.equal('max_output_tokens' in body, false, `${protocol}：0 时不得带 max_output_tokens`);
  }
  // Anthropic 的 max_tokens 是必填：0 要回落默认值，不能发注定 400 的请求
  const anthropic = buildLlmRequest({ ...base, protocol: 'messages', maxTokens: 0 }, { system: 's', user: 'u' });
  assert.ok(anthropic.body.max_tokens > 0, 'messages 协议 0 要回落默认值');
  // 正常值照旧传递
  const normal = buildLlmRequest({ ...base, protocol: 'chat', maxTokens: 1500 }, { system: 's', user: 'u' });
  assert.equal(normal.body.max_tokens, 1500);
});

test('只有一个数量参数：每批岗位数，输出预算与超时按批自动推算', () => {
  // 2026-10-30 用户要求：不要「深解析上限 / 招呼语上限 / 每批岗位数」三个数字，只留每批岗位数
  const keys = Object.keys(LLM_FALLBACK);
  assert.equal(keys.includes('llm_analyze_limit'), false, '深解析上限必须删掉');
  assert.equal(keys.includes('llm_greeting_limit'), false, '招呼语上限必须删掉');
  assert.equal(keys.includes('llm_analyze_max_tokens'), false, '解析 max tokens 必须删掉（自动推算）');
  assert.equal(keys.includes('llm_analyze_batch_size'), true, '每批岗位数要在');

  // 2026-10-30 实测：模型 max_output_tokens = 393216，不传 max_tokens 时 20 条一批也能正常跑完
  // （completion 11728 / finish=stop / 20 条全中）→ 不再自己推算预算，只留单批超时
  assert.deepEqual(autoBudgets(25), { maxTokens: 0, timeoutMs: 500000 }, 'max_tokens 恒为 0（不传），只按条数算超时');
  assert.equal(autoBudgets(3).maxTokens, 0, '不再有「每条 × 额度」的公式');
  assert.equal(autoBudgets(1000).timeoutMs, 1800000, '超时封顶 30 分钟');
  const { body: noBudgetBody } = buildLlmRequest({ baseUrl: 'http://x', model: 'm', apiKey: 'k', protocol: 'chat', maxTokens: 0 }, { system: 's', user: 'u' });
  assert.equal('max_tokens' in noBudgetBody, false, 'body 里不能出现 max_tokens');
});

test('LLM 目标选择：增量跳过已有结果，取消费/已联系不覆盖，cap 只给测试用', async () => {
  const { selectLlmTargets } = await import('../boss/boss-llm.mjs');
  const mk = (i, over = {}) => ({ key_hash: `h${i}`, score: 3 + (i % 5) / 10, eligible: i % 2 === 0, ...over });
  const done = { match: { score: 4 }, greeting: { text: '您好，我做过数仓，方便沟通吗？' } };
  const jobs = [
    mk(0, { llm: done }),  // 完整记录（解析 + 文案）→ 增量跳过
    mk(1, { llm: done }),
    mk(2),                                     // 没结果 → 要跑
    mk(3, { greetingSource: 'template' }),      // 只有模板文案（没解析）→ 要跑
    mk(4, { llm: { match: { score: 4 } } }),    // 残缺记录：有解析没文案 → 也要跑（否则永远拿不到文案）
  ];
  const r = selectLlmTargets(jobs);
  assert.equal(r.skippedExisting, 2, '两条完整记录要跳过');
  assert.equal(r.targets.length, 3);
  assert.deepEqual(r.targets.map((j) => j.key_hash).sort(), ['h2', 'h3', 'h4']);
  assert.equal(r.total, 3, '待处理总数要单独报出来（用来算批次数）');

  const forced = selectLlmTargets(jobs, { force: true });
  assert.equal(forced.skippedExisting, 0);
  assert.equal(forced.targets.length, 5, '--llm-force 才重跑已有结果');

  // cap 是测试/补跑用的硬上限（0 = 不限）；可发送的排前面
  const capped = selectLlmTargets(jobs, { cap: 1 });
  assert.equal(capped.targets.length, 1);
  assert.equal(capped.capped, 2, '超出 cap 的要报出来（3 条待处理只取 1 条）');
  assert.equal(capped.targets[0].eligible, true, '可发送岗位优先');
  assert.equal(selectLlmTargets(jobs, { cap: 0 }).targets.length, 3, 'cap 0 = 不限');
});

test('已发送/已联系的岗位一律跳过（force 也不覆盖）', async () => {
  const { isContacted, selectLlmTargets } = await import('../boss/boss-llm.mjs');
  assert.equal(isContacted({ greeted: true }), true);
  assert.equal(isContacted({ greeted: 1 }), true);
  assert.equal(isContacted({ greeted: 0, contactState: 'custom_sent' }), true);
  assert.equal(isContacted({ contactState: 'auto_greeted_unverified' }), true);
  assert.equal(isContacted({ contactState: 'manual_contact_confirmed' }), true);
  assert.equal(isContacted({ contactState: 'legacy_contact_unknown' }), true);
  assert.equal(isContacted({ greeted: 0, contactState: 'never_contacted' }), false);
  assert.equal(isContacted({}), false);

  const jobs = [
    { key_hash: 'a', greeted: 1, score: 5, eligible: false },              // 已发送
    { key_hash: 'b', contactState: 'custom_sent', score: 5 },              // 已发自定义招呼
    { key_hash: 'c', greeted: 0, contactState: 'never_contacted', score: 4, eligible: true },
  ];
  const r = selectLlmTargets(jobs);
  assert.equal(r.skippedContacted, 2, '已联系的必须计数跳过');
  assert.deepEqual(r.targets.map((j) => j.key_hash), ['c']);
  // force 只覆盖「已有 LLM 结果」，不覆盖「已发送」
  const forced = selectLlmTargets(jobs, { force: true });
  assert.equal(forced.skippedContacted, 2);
  assert.deepEqual(forced.targets.map((j) => j.key_hash), ['c']);
});

test('并发限流：mapWithConcurrency 不会一次性拉起全部任务', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 3, async (item) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 2;
  });
  assert.equal(peak <= 3, true, `并发峰值应 ≤ 3，实际 ${peak}`);
  assert.deepEqual(out, items.map((i) => i * 2), '结果顺序必须与输入一致');
});

// ── 安全 ───────────────────────────────────────────────────────────────────
test('API Key 只以掩码形式离开服务端', () => {
  assert.equal(maskKey('sk-abcdefghijklmn'), 'sk-***klmn');
  assert.equal(maskKey('short'), '***');
  assert.equal(maskKey(''), '');
  const client = llmStatusForClient(baseCfg);
  const json = JSON.stringify(client);
  assert.ok(!json.includes(baseCfg.apiKey), '回给浏览器的 JSON 里不能出现明文 key');
  assert.equal(client.hasKey, true);
  assert.equal(client.keyMask, 'sk-***7890');
  assert.equal(client.ready, true);
  assert.ok(client.defaultPrompt, '前端要能展示内置默认提示词');
});

// ── 接线契约 ───────────────────────────────────────────────────────────────
test('控制台有「LLM 招呼语」面板：开关 / 协议 / base url / 模型 / key / 保存 / 测试', () => {
  for (const id of ['fLlmEnabled', 'fLlmProtocol', 'fLlmBaseUrl', 'fLlmModel', 'fLlmKey', 'fLlmTemp', 'fLlmMaxTokens', 'fLlmTimeout', 'fLlmConcurrency', 'fLlmPrompt']) {
    assert.match(html, new RegExp(`id="${id}"`), `控制台缺少 ${id}`);
  }
  for (const id of ['btnSaveLlm', 'btnTestLlm', 'btnLlmClearKey']) {
    assert.match(html, new RegExp(`id="${id}"`), `控制台缺少按钮 ${id}`);
  }
  assert.match(html, /value="chat"[\s\S]*value="responses"[\s\S]*value="messages"/, '协议下拉必须含三种协议');
  assert.match(html, /\/api\/llm\/test/, '前端必须调用 /api/llm/test');
  assert.match(html, /fillLlmInputs/, 'LLM 配置必须能从 /api/overview 回填');
  assert.match(html, /greetingBadge/, '列表必须能区分 LLM 文案与模板文案');
});

test('服务端：/api/llm 读写 + 测试连通，且不把明文 key 写进响应', () => {
  assert.match(serverSrc, /url\.pathname === '\/api\/llm'/, '缺少 /api/llm 路由');
  assert.match(serverSrc, /url\.pathname === '\/api\/llm\/test'/, '缺少 /api/llm/test 路由');
  assert.match(serverSrc, /llm: llmStatusForClient\(resolveLlmConfig\(c\)\)/, 'loadBossConfig 必须返回掩码状态');
  assert.match(serverSrc, /if \(body\.clearKey === true\) partial\.llm_api_key = ''/, '清空 key 必须显式 clearKey');
  assert.match(serverSrc, /else if \(body\.apiKey != null && String\(body\.apiKey\)\.trim\(\)\)/, 'key 留空必须保持原值');
  assert.match(serverSrc, /LLM_PROTOCOLS\.includes\(p\)/, '协议必须走白名单校验');
  assert.doesNotMatch(serverSrc, /llm_api_key:\s*String\(body\.apiKey\)\s*,\s*\n\s*\}\);/, '不得无条件覆盖已保存的 key');
});

test('复核清单要写清文案来源（模板文案必须提醒逐条看）', () => {
  const reviewSrc = read('boss', 'boss-review.mjs');
  assert.match(reviewSrc, /文案来源：LLM \$\{llmCount\} 条 \/ 内置模板/, '复核清单必须标出 LLM / 模板条数');
  assert.match(reviewSrc, /greetingSource: job\.greeting_source \|\| 'template'/, '复核 JSON 必须带来源字段');
});

test('评分脚本：LLM 生成招呼语并记录来源，失败回落模板', () => {
  assert.match(scoreSrc, /from '\.\/boss-llm\.mjs'/, 'boss-score 必须复用 boss-llm.mjs');
  assert.match(scoreSrc, /greeting_source = 'template'/, '默认来源必须是模板');
  assert.match(scoreSrc, /greeting_template/, '必须保留模板文案作为兜底');
  assert.match(scoreSrc, /job\.greeting_source = 'llm'/, 'LLM 成功必须标记来源');
  assert.match(scoreSrc, /job\.greeting = job\.greeting_template \|\| job\.greeting/, '回落时必须显式取模板文案');
  assert.match(scoreSrc, /applyLlmPass\(scored, profile, \{ args \}\)/, 'main 必须对本次评分岗位跑 LLM 一趟流');
  assert.match(scoreSrc, /analyzeJobsChunked\(/, '一个批次一次请求（匹配 + 招呼语一起回来）');
  assert.match(scoreSrc, /待处理 \$\{targets\.length\} 条 ÷ 每批 \$\{batchSize\} = \$\{batches\} 次请求/, '日志要把批次数算给用户看');
  assert.match(scoreSrc, /'--no-llm'/, 'must support --no-llm'); // 允许关闭
  assert.match(scoreSrc, /args\.limit/, '--limit 只给测试/补跑用（正常流程不设上限）');
  // 报告要在 LLM 之后写，否则报告里的文案与真正发出去的不一致
  const llmIdx = scoreSrc.indexOf('applyLlmPass(scored, profile');
  const reportIdx = scoreSrc.indexOf('job.report = writeReport(job)');
  assert.ok(llmIdx > 0 && reportIdx > llmIdx, '报告必须写在 LLM 生成之后');
});



// ── 一个批次 = 一次请求（匹配结构 + 招呼语一起返回）────────────────────────
const mkJob = (i, extra = {}) => ({
  key_hash: `k${i}`, company: `公司${i}`, title: `岗位${i}`, city: "上海", salary: "30-50K",
  desc: `岗位职责：数据平台建设 ${i}`, eligible: true, score: 4.5, greeting: `模板文案${i}文案文案文案`,
  greeting_basis: { skills: ["Hive"], jd_focus: ["数仓"], evidence: ["做过离线链路"] }, ...extra,
});

const analysisPayload = (score = 4.2) => ({
  job: { seniority: "高级", employment_type: "全职", is_outsourcing: false, jd_completeness: "full", years_required: 3, education_required: "本科", tech_stack: ["Hive"], responsibilities: ["建数仓"], domain: ["电商"], red_flags: [], risk_level: "low" },
  match: { score, level: "强匹配", matched: [{ jd_requirement: "数仓", resume_evidence: "离线数仓" }], gaps: [], why: "贴合" },
  greeting: { text: "您好，我做过离线数仓，方便沟通吗？", basis: ["离线数仓"] },
});

test("一个批次一次请求：10 个岗位只发 1 次，每个岗位都拿到匹配 + 文案", async () => {
  const jobs = Array.from({ length: 10 }, (_, i) => mkJob(i + 1));
  let calls = 0;
  let sawMaxTokens = null;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    sawMaxTokens = body.max_tokens ?? null;
    const content = JSON.stringify({ analyses: jobs.map((job, i) => ({ id: String(i + 1), ...analysisPayload(3 + (i % 3)) })) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 400, credit: 0.5 } }) };
  };
  const got = new Map();
  const summary = await analyzeJobsChunked({
    jobs, cv: "简历正文".repeat(60), cfg: { ...baseCfg, batchSize: 10 },
    onItem: ({ key_hash, analysis }) => { got.set(key_hash, analysis); },
    fetchImpl,
  });
  assert.equal(calls, 1, "10 条 / 每批 10 条 = 1 次请求");
  assert.equal(summary.requests, 1);
  assert.equal(summary.ok, 10);
  assert.equal(summary.fallbackSplits, 0);
  assert.equal(got.size, 10);
  assert.equal(got.get("k1").match.score, 3, "匹配结构要按 id 回到对应岗位");
  assert.equal(got.get("k1").greeting.text.length > 0, true, "文案和匹配在同一条记录里");
  assert.equal(sawMaxTokens, null, "不传 max_tokens（上限交给模型：实测 393k）");
});

test("批次数 = ⌈待处理 ÷ 每批⌉：23 条 / 每批 10 条 = 3 次请求", async () => {
  const jobs = Array.from({ length: 23 }, (_, i) => mkJob(i + 1));
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const ids = [...JSON.stringify(body).matchAll(/【岗位 #(\d+)】/g)].map((m) => m[1]);
    const content = JSON.stringify({ analyses: ids.map((id) => ({ id, ...analysisPayload() })) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  const batches = [];
  const summary = await analyzeJobsChunked({
    jobs, cv: "简历".repeat(200), cfg: { ...baseCfg, batchSize: 10, onBatch: (done, total) => batches.push(`${done}/${total}`) },
    onItem: () => {},
    fetchImpl,
  });
  assert.equal(calls, 3, "23 条按每批 10 条要拆成 3 批");
  assert.equal(summary.requests, 3);
  assert.deepEqual(batches, ["10/23", "20/23", "23/23"], "每批结束要报进度");
});

test("漏项自动对半拆重试；单条仍失败才交回调用方兜底", async () => {
  const jobs = [mkJob(1), mkJob(2), mkJob(3), mkJob(4)];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const ids = [...JSON.stringify(body).matchAll(/【岗位 #(\d+)】/g)].map((m) => m[1]);
    const all = ids.map((id) => ({ id, ...analysisPayload() }));
    // 第一次只回一半：模拟模型漏项
    const payload = calls === 1 ? { analyses: all.slice(0, 2) } : { analyses: all };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  const seen = new Set();
  const summary = await analyzeJobsChunked({
    jobs, cv: "", cfg: { ...baseCfg, batchSize: 4 },
    onItem: ({ key_hash }) => { seen.add(key_hash); },
    fetchImpl,
  });
  assert.ok(calls > 1, "漏项必须触发拆批重试");
  assert.equal(summary.fallbackSplits >= 1, true);
  assert.equal(seen.size, 4, "重试后 4 条都要拿到结果");
  assert.equal(summary.failed.length, 0);
});

test("整批失败：调用方拿到 failed 列表，逐条回落模板", async () => {
  const jobs = [mkJob(1), mkJob(2)];
  const summary = await analyzeJobsChunked({
    jobs, cv: "简历".repeat(200), cfg: { ...baseCfg, batchSize: 2 },
    onItem: () => { throw new Error("不该被调用"); },
    fetchImpl: failFetch(500, "boom"),
  });
  assert.equal(summary.ok, 0);
  assert.equal(summary.failed.length, 2);
  assert.ok(summary.errors.length > 0);
});

// ── 解析加固（2026-10-30）：截断修复 + 漏项二次补发 ──────────────────────────
test("截断修复：输出被切断时保住已吐完的条目，而不是整批判废", async () => {
  const { extractJsonObject } = await import("../boss/boss-llm-schema.mjs");
  const payload = { analyses: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), job: {}, match: { score: 4 }, greeting: { text: "您好，我做过数仓，方便沟通吗？" } })) };
  const text = JSON.stringify(payload);

  // 断在第 3 条中间
  const cut = text.slice(0, text.indexOf('"id":"3"') + 10);
  const repaired = extractJsonObject(cut);
  assert.equal(repaired.analyses.length, 2, "前两条要救回来");
  assert.equal(repaired.__repaired.method, 'truncate-closers');
  assert.ok(repaired.__repaired.droppedChars > 0);
  assert.equal(JSON.stringify(repaired).includes('__repaired'), false, "修复标记不能进库（不可枚举）");

  // 完整 JSON 不得被误标
  assert.equal(extractJsonObject(text).__repaired, undefined);
  // 尾巴多一个逗号 / 纯废话
  assert.equal(extractJsonObject(text.replace('}}]}', '}}]},')).analyses.length, 5);
  assert.equal(extractJsonObject('今天天气不错'), null);
  assert.equal(extractJsonObject(''), null);
});

test("漏项二次补发：单条缺失会再发一次（带【重试】提示），仍失败才记 failed", async () => {
  const { analyzeJobsChunked } = await import("../boss/boss-llm.mjs");
  const jobs = [{ key_hash: "a", company: "A", title: "t1", desc: "jd", dbId: 1 }];
  const seen = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const user = String(body.messages?.find((m) => m.role === "user")?.content || "");
    seen.push(user);
    if (calls === 1) {
      // 第一次：模型没返回这一条
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"analyses":[]}' } }] }) };
    }
    const content = JSON.stringify({ analyses: [{ id: "1", job: {}, match: { score: 4, level: "较匹配", matched: [], gaps: [], why: "ok" }, greeting: { text: "您好，我做过数仓，方便沟通吗？", basis: [] } }] });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  const got = new Set();
  const summary = await analyzeJobsChunked({
    jobs, cv: "简历", cfg: { ...baseCfg, batchSize: 1 },
    onItem: ({ key_hash }) => { got.add(key_hash); }, fetchImpl,
  });
  assert.equal(calls, 2, "缺 1 条要二次补发（不是直接放弃）");
  assert.equal(summary.retries, 1);
  assert.equal(got.size, 1, "补发成功要拿到结果");
  assert.equal(summary.failed.length, 0);
  assert.match(seen[1], /【重试】/, "补发请求要明确告诉模型这次只输出这些岗位");
});

// ── 人工排除 = 不发送，也就不再花钱评估（2026-10-30）────────────────────────
test('人工排除的岗位彻底出局：不进 LLM 队列，也没有开关能放它回来', async () => {
  const { selectLlmTargets } = await import('../boss/boss-llm.mjs');
  const jobs = [
    { key_hash: 'a', score: 4.5, eligible: true, manualExcluded: true },
    { key_hash: 'b', score: 4.4, eligible: true, manual_excluded: 1 },
    { key_hash: 'c', score: 4.3, eligible: true },
  ];
  const r = selectLlmTargets(jobs);
  assert.equal(r.skippedExcluded, 2, '两条人工排除的要跳过并计数');
  assert.deepEqual(r.targets.map((j) => j.key_hash), ['c']);

  // 用户原话：「任何情况我都不需要这些岗位」→ 不留逃生口
  assert.equal(selectLlmTargets(jobs, { force: true }).targets.length, 1, '--llm-force 也不能把它们放回来');
  assert.equal(selectLlmTargets(jobs, { includeExcluded: true }).targets.length, 1, '传了也不生效');
});

test('人工排除的岗位不进队列（saveQueue 统一收口）', async () => {
  const { readFileSync } = await import('node:fs');
  const common = readFileSync(new URL('../boss/boss-common.mjs', import.meta.url), 'utf-8');
  const start = common.indexOf('export async function saveQueue');
  const fn = common.slice(start, common.indexOf('export async function loadQueue', start));
  assert.match(fn, /\.filter\(\(job\) => !\(job\?\.manualExcluded \|\| job\?\.manual_excluded\)\)/, '写队列前必须剔除人工排除的岗位');
});

test('控制台「原始候选」与「可发送」都不含人工排除', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../boss/boss-web/server.mjs', import.meta.url), 'utf-8');
  assert.match(server, /greeted=0 AND manual_excluded=0 AND score>=\?/, '原始候选要排除 manual_excluded');
});

test('评分脚本把 skippedExcluded 报出来', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../boss/boss-score.mjs', import.meta.url), 'utf-8');
  assert.match(src, /跳过 \$\{skippedExcluded\} 条人工排除的岗位/, '日志要说清跳过了多少');
  assert.match(src, /skippedExcluded: llmSummary\.skippedExcluded \|\| 0/, 'JSON 输出要带这个计数');
  assert.doesNotMatch(src, /include-excluded/, '不该再有把它放回来的开关');
});

test('评估范围默认只跑「可发送」，省钱且不影响发送判定', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../boss/boss-score.mjs', import.meta.url), 'utf-8');
  assert.match(src, /const llmScope = String\(args\['llm-scope'\] \|\| 'sendable'\)/, '默认 sendable');
  assert.match(src, /import \{ selectSendableJobs, readSendHistory \} from '\.\/boss-send-eligibility\.mjs'/, '要复用发送预检，不能另写一套判断');
  assert.match(src, /targets = picked\.filter\(\(job\) => sendableKeys\.has\(job\.key_hash\)\)/, '用发送预检的结果集过滤');
  assert.match(src, /skippedNotSendable = picked\.length - targets\.length/, '要统计被排除多少条');
  assert.match(src, /--llm-scope=all/, '要能显式恢复全量');
});
