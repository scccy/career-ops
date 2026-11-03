// boss/boss-llm.mjs — 用 LLM 生成 BOSS 打招呼文案（协议 / 地址 / 模型全部由控制台配置）
//
// 设计（2026-10-30 用户要求）：
//   - `npm run boss:score` 仍然先算出模板文案（buildGreeting），LLM 只是**升级**它：
//     LLM 未启用 / 超时 / 报错 / 吐空 / 吐得太短，一律保留模板文案 —— 绝不出现空招呼语。
//   - 三种协议任选（控制台下拉）：
//       chat       OpenAI 兼容 /chat/completions（DeepSeek、OpenAI、Ollama /v1、vLLM、各类中转）
//       responses  OpenAI /responses（新 Responses API）
//       messages   Anthropic /messages（x-api-key + anthropic-version）
//   - 配置存在 PostgreSQL boss_config（与其它操作配置同一行），**API Key 只在服务端使用**：
//     控制台读接口只回显掩码，绝不把明文回给浏览器。
//   - 除数据库配置外，还接受环境变量兜底（CLI 场景免建配置）：
//       BOSS_LLM_ENABLED / BOSS_LLM_BASE_URL / BOSS_LLM_MODEL / BOSS_LLM_API_KEY /
//       BOSS_LLM_PROTOCOL，以及通用别名 OPENAI_BASE_URL / OPENAI_MODEL / OPENAI_API_KEY。
//
// 本模块不碰数据库、不读文件：调用方把配置对象传进来，方便测试与复用。

export const LLM_PROTOCOLS = ['chat', 'responses', 'messages'];
export const LLM_PROTOCOL_LABELS = {
  chat: 'chat · /chat/completions（OpenAI 兼容）',
  responses: 'responses · /responses（OpenAI Responses）',
  messages: 'messages · /messages（Anthropic）',
};

// 各协议在 base url 后面要拼的路径
const PROTOCOL_PATHS = {
  chat: 'chat/completions',
  responses: 'responses',
  messages: 'messages',
};

// BOSS 打招呼输入框有限长；模板文案约 60–100 字，这里给 LLM 留一点空间但不允许长篇大论。
export const MAX_GREETING_CHARS = 160;
const MIN_GREETING_CHARS = 8;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const LLM_FALLBACK = {
  llm_enabled: false,
  llm_protocol: 'chat',
  llm_base_url: '',
  llm_model: '',
  llm_api_key: '',
  llm_temperature: 0.6,
  // 1500 而不是 400：现在主流模型（DeepSeek v4 / o 系 / glm-5 等）把思维链也算在 max_tokens 里，
  // 实测 cn:deepseek-v4.1-flash 在 max_tokens=400 时 reasoning 就把预算吃光、正文为空；900 起才稳定出文案。
  llm_max_tokens: 1500,
  llm_timeout_ms: 60000,
  llm_concurrency: 3,
  // 是否在评分里跑 LLM 评估（一个批次一次请求：匹配结构 + 招呼语）
  llm_analyze_enabled: true,
  // **唯一的数量参数**：一次请求带多少个岗位。批次数 = ⌈待处理数 ÷ 每批条数⌉，脚本自己算。
  // 实测 20 条/次：86 秒、2.57 credit（0.13 credit/条）；25 条是「单批别超过网关输出上限」的稳妥值。
  llm_analyze_batch_size: 25,
  // 可选的思考力度：c.n:deepseek-v4.1-flash 实际支持 low/high/max（没有 medium），默认 high
  llm_reasoning_effort: 'high',
  // 是否要求关闭思维链（thinking:{type:'disabled'}）。实测这家网关：同一份深解析
  // 开思考 28.6s / 0.78 credit，关思考 5.5s / 0.21 credit，JSON 一样完整。
  // 属于网关扩展参数，**不是所有中转都认**（不认会 400），所以默认关，按需打开。
  llm_thinking_disabled: false,
  // 空 = 用下面的内置提示词；控制台可整体改写
  llm_prompt: '',
};

function intIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min || i > max) return fallback;
  return i;
}

// 与 intIn 相同，但 0 是合法值（例如「每次最多解析 0 条」= 不解析）
function numIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.trunc(n);
}

function floatIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

// base url 归一：允许用户贴成 https://api.deepseek.com/v1/ 或 .../v1/chat/completions，
// 都收敛成不带末尾斜杠的形式；非 http(s) 一律当作「没填」。
export function normalizeBaseUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  return text.replace(/\/+$/, '');
}

// 只归一 LLM 相关字段（供 boss-config-db.mjs 的 normalize() 合并，保证仍然只有一份配置行）。
export function normalizeLlmFields(v = {}) {
  const src = v && typeof v === 'object' ? v : {};
  const protocol = String(src.llm_protocol || '').trim().toLowerCase();
  return {
    llm_enabled: src.llm_enabled === true,
    llm_protocol: LLM_PROTOCOLS.includes(protocol) ? protocol : LLM_FALLBACK.llm_protocol,
    llm_base_url: normalizeBaseUrl(src.llm_base_url),
    llm_model: String(src.llm_model == null ? '' : src.llm_model).trim().slice(0, 200),
    llm_api_key: String(src.llm_api_key == null ? '' : src.llm_api_key).trim().slice(0, 500),
    llm_temperature: floatIn(src.llm_temperature, LLM_FALLBACK.llm_temperature, 0, 2),
    // 0 = 不传 max_tokens（交给网关/模型默认），与仓库里「0 = 不限」的既有约定一致
    llm_max_tokens: numIn(src.llm_max_tokens, LLM_FALLBACK.llm_max_tokens, 0, 8192),
    llm_timeout_ms: intIn(src.llm_timeout_ms, LLM_FALLBACK.llm_timeout_ms, 1000, 300000),
    llm_concurrency: intIn(src.llm_concurrency, LLM_FALLBACK.llm_concurrency, 1, 16),
    // 只有显式 false 才关闭（默认与用户要求一致：并进评分）
    llm_analyze_enabled: src.llm_analyze_enabled === false ? false : true,
    // 唯一的数量参数：每批岗位数（批次数由脚本按待处理岗位数算出来，不再有第二、第三个上限）
    llm_analyze_batch_size: intIn(src.llm_analyze_batch_size, LLM_FALLBACK.llm_analyze_batch_size, 1, 100),
    // 思考力度：缺省用默认（high）；显式空串 = 不传该参数（各家中转通用性最好）
    llm_reasoning_effort: src.llm_reasoning_effort === undefined
      ? LLM_FALLBACK.llm_reasoning_effort
      : (['', 'low', 'high', 'max'].includes(String(src.llm_reasoning_effort).toLowerCase())
        ? String(src.llm_reasoning_effort).toLowerCase()
        : LLM_FALLBACK.llm_reasoning_effort),
    llm_thinking_disabled: src.llm_thinking_disabled === true,
    llm_prompt: String(src.llm_prompt == null ? '' : src.llm_prompt).trim().slice(0, 4000),
  };
}

// 数据库配置（snake_case）→ 运行时配置（camelCase，含环境变量兜底）。
// 环境变量只补**空**字段：控制台填了值就以数据库为准。
export function resolveLlmConfig(dbConfig = {}, env = process.env) {
  const db = normalizeLlmFields(dbConfig || {});
  const pick = (...names) => {
    for (const name of names) {
      const value = env?.[name];
      if (value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };
  const baseUrl = db.llm_base_url || normalizeBaseUrl(pick('BOSS_LLM_BASE_URL', 'OPENAI_BASE_URL'));
  const model = db.llm_model || pick('BOSS_LLM_MODEL', 'OPENAI_MODEL');
  const apiKey = db.llm_api_key || pick('BOSS_LLM_API_KEY', 'OPENAI_API_KEY');
  const protocolRaw = String(pick('BOSS_LLM_PROTOCOL')).toLowerCase();
  const protocol = LLM_PROTOCOLS.includes(protocolRaw) ? protocolRaw : db.llm_protocol;
  const envEnabled = String(env?.BOSS_LLM_ENABLED || '').toLowerCase() === 'true';
  return {
    enabled: db.llm_enabled === true || envEnabled,
    protocol,
    baseUrl,
    model,
    apiKey,
    keySource: db.llm_api_key ? 'db' : (apiKey ? 'env' : ''),
    temperature: db.llm_temperature,
    maxTokens: db.llm_max_tokens,
    timeoutMs: db.llm_timeout_ms,
    concurrency: db.llm_concurrency,
    analyzeEnabled: db.llm_analyze_enabled !== false,
    // 唯一的数量参数：每批岗位数（输出预算/超时按它自动推算，见 autoBudgets）
    batchSize: db.llm_analyze_batch_size,
    reasoningEffort: db.llm_reasoning_effort,
    thinkingDisabled: db.llm_thinking_disabled === true,
    prompt: db.llm_prompt,
  };
}

// 能不能真的发请求（本地模型可以不要 key，所以 key 不是硬条件）
export function llmReadiness(cfg = {}) {
  if (cfg.enabled !== true) return { ok: false, reason: '未启用 LLM 招呼语' };
  if (!cfg.baseUrl) return { ok: false, reason: '缺少 base url（例如 https://api.deepseek.com）' };
  if (!cfg.model) return { ok: false, reason: '缺少模型名（例如 deepseek-chat）' };
  // 协议缺省按 chat 处理（调用方只关心「能不能发」，不该因为没写协议就判未就绪）
  const protocol = cfg.protocol || 'chat';
  if (!LLM_PROTOCOLS.includes(protocol)) return { ok: false, reason: `协议非法：${cfg.protocol}` };
  return { ok: true, reason: '就绪' };
}

// 控制台读接口用：明文 key 只留在服务端，回给浏览器的永远是掩码。
export function maskKey(key) {
  const text = String(key || '');
  if (!text) return '';
  if (text.length <= 8) return '***';
  return `${text.slice(0, 3)}***${text.slice(-4)}`;
}

export function llmStatusForClient(cfg = {}) {
  const ready = llmReadiness(cfg);
  return {
    enabled: cfg.enabled === true,
    protocol: cfg.protocol || LLM_FALLBACK.llm_protocol,
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    hasKey: Boolean(cfg.apiKey),
    keyMask: maskKey(cfg.apiKey),
    keySource: cfg.keySource || '',
    temperature: cfg.temperature ?? LLM_FALLBACK.llm_temperature,
    maxTokens: cfg.maxTokens ?? LLM_FALLBACK.llm_max_tokens,
    timeoutMs: cfg.timeoutMs ?? LLM_FALLBACK.llm_timeout_ms,
    concurrency: cfg.concurrency ?? LLM_FALLBACK.llm_concurrency,
    analyzeEnabled: cfg.analyzeEnabled !== false,
    // 唯一的数量参数：每批岗位数
    batchSize: cfg.batchSize ?? LLM_FALLBACK.llm_analyze_batch_size,
    // 控制台只是显示，不再是可填参数：输出预算/超时按每批条数自动推算
    autoBudget: autoBudgets(cfg.batchSize ?? LLM_FALLBACK.llm_analyze_batch_size),
    reasoningEffort: cfg.reasoningEffort || '',
    thinkingDisabled: cfg.thinkingDisabled === true,
    prompt: cfg.prompt || '',
    defaultPrompt: DEFAULT_SYSTEM_PROMPT,
    ready: ready.ok,
    reason: ready.reason,
  };
}

// ---------------------------------------------------------------------------
// 请求构造 / 响应解析（纯函数，便于测试）
// ---------------------------------------------------------------------------

export function resolveEndpoint(baseUrl, protocol) {
  const base = normalizeBaseUrl(baseUrl);
  const path = PROTOCOL_PATHS[protocol] || PROTOCOL_PATHS.chat;
  if (!base) return '';
  // 用户直接把完整端点贴进来（.../v1/chat/completions）就不再重复拼接
  if (base.toLowerCase().endsWith('/' + path)) return base;
  return `${base}/${path}`;
}

export function buildLlmRequest(cfg = {}, { system, user, json = false } = {}) {
  const protocol = LLM_PROTOCOLS.includes(cfg.protocol) ? cfg.protocol : 'chat';
  const url = resolveEndpoint(cfg.baseUrl, protocol);
  const headers = { 'content-type': 'application/json' };
  const body = { model: cfg.model };
  // 输出预算：0 = 不传该参数（由网关/模型自己决定上限）。Anthropic 的 /messages 必填 max_tokens，
  // 那个协议下 0 回落到内置默认值——绝不发一个注定 400 的请求。
  const budget = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 0;
  // 可选：压低推理模型的思考预算（各家档位不同；本网关的 v4.1-flash 是 low/high/max）
  // 已经要求「关闭思维链」时不再传 effort：两个参数打架只会让网关行为不可预期
  const effort = cfg.thinkingDisabled === true ? '' : String(cfg.reasoningEffort || '').trim();
  const effortBody = ['low', 'high', 'max'].includes(effort) ? { reasoning_effort: effort } : {};

  if (protocol === 'messages') {
    // Anthropic：key 走 x-api-key，版本头必填；max_tokens 也是必填
    if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body.max_tokens = budget || LLM_FALLBACK.llm_max_tokens;
    if (Number.isFinite(Number(cfg.temperature))) body.temperature = Number(cfg.temperature);
    if (system) body.system = String(system);
    body.messages = [{ role: 'user', content: String(user || '') }];
  } else if (protocol === 'responses') {
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    if (system) body.instructions = String(system);
    body.input = String(user || '');
    if (budget) body.max_output_tokens = budget;
    // 刻意不带 temperature：部分推理模型（o 系列 / gpt-5 系）会直接 400 拒绝该参数
  } else {
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    body.messages = [
      ...(system ? [{ role: 'system', content: String(system) }] : []),
      { role: 'user', content: String(user || '') },
    ];
    if (Number.isFinite(Number(cfg.temperature))) body.temperature = Number(cfg.temperature);
    if (budget) body.max_tokens = budget;
  }
  // 要求「只输出 JSON」时带上 JSON 模式（支持的网关会强制合法 JSON；不支持的会忽略该字段，无害）
  if (json && protocol !== 'messages') body.response_format = { type: 'json_object' };
  Object.assign(body, effortBody);
  // 关思维链：同一深解析任务实测省 ~4 倍费用 / 5 倍时间。属网关扩展参数，只在该部署确认支持时才开
  if (cfg.thinkingDisabled === true && protocol !== 'messages') body.thinking = { type: 'disabled' };
  return { url, headers, body };
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (typeof part === 'string' ? part : part?.text ?? part?.content?.text ?? ''))
    .filter(Boolean)
    .join('');
}

// 空正文最常见的原因不是模型坏，而是「思维链把 max tokens 吃完了」（DeepSeek v4 / o 系 / glm 等
// 都是 reasoning 模型，reasoning_tokens 计入 completion_tokens）。这里把它翻成人话，
// 否则用户只会看到「LLM 返回内容为空」然后以为服务没配好。
function emptyContentHint(payload, protocol) {
  const usage = payload?.usage || {};
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (reasoning > 0 && (completion === 0 || reasoning >= completion * 0.9)) {
    return `LLM 只输出了思考内容（reasoning_tokens=${reasoning}，completion_tokens=${completion}）；` +
      '这是思维链模型把 max tokens 用在了思考上，把「max tokens」调到 1500 以上再试';
  }
  const finish = payload?.choices?.[0]?.finish_reason || payload?.stop_reason || '';
  if (finish === 'length' || finish === 'max_tokens') {
    return `LLM 输出被 max tokens 截断（finish_reason=${finish}），把「max tokens」调大再试`;
  }
  return `LLM 返回内容为空（${protocol}）`;
}

export function parseLlmResponse(protocol, json) {
  const payload = json || {};
  if (payload.error) {
    const msg = payload.error.message || payload.error.type || JSON.stringify(payload.error).slice(0, 200);
    throw new Error(`LLM 返回错误：${msg}`);
  }
  if (protocol === 'messages') {
    const text = (Array.isArray(payload.content) ? payload.content : [])
      .filter((part) => !part?.type || part.type === 'text')
      .map((part) => part?.text || '')
      .join('');
    if (!text.trim()) throw new Error(emptyContentHint(payload, 'messages'));
    return text;
  }
  if (protocol === 'responses') {
    // 官方 SDK 的便利字段是 output_text；部分网关只给 output[]，这里两种都认
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
    const text = (Array.isArray(payload.output) ? payload.output : [])
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => part?.text || '')
      .join('');
    if (!text.trim()) throw new Error(emptyContentHint(payload, 'responses'));
    return text;
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text ?? '';
  const text = Array.isArray(content) ? textFromParts(content) : String(content || '');
  if (!text.trim()) throw new Error(emptyContentHint(payload, 'chat'));
  return text;
}

// ---------------------------------------------------------------------------
// 文案清洗
// ---------------------------------------------------------------------------

// LLM 常见的「包装」：代码块、引号、「文案：」前缀、分点、markdown。
export function coerceGreeting(raw, { maxChars = MAX_GREETING_CHARS } = {}) {
  let text = String(raw == null ? '' : raw)
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/\r/g, '')
    .trim();
  // 去掉最外层引号/书名号包装（成对出现的才去）
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['「', '」'], ['《', '》']];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
      text = text.slice(1, -1).trim();
      break;
    }
  }
  // 去掉「打招呼文案：」之类的前缀
  text = text.replace(/^\s*(?:打招呼(?:文案|语|消息)?|文案|消息|回复|输出)\s*[:：]\s*/u, '');
  // 压成一段话：换行 → 空格，去掉分点符号与 markdown 强调
  text = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^[\s]*(?:[-*•·]|\d+[.、)])\s*/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。；、！？：])/g, '$1')
    // 换行压成空格后，句号后面会留下空格——中文句子之间不要这个空格
    .replace(/([，。；、！？：])\s+/g, '$1')
    .trim();
  if (text.length < MIN_GREETING_CHARS) return '';
  if (text.length > maxChars) {
    const head = text.slice(0, maxChars);
    // 尽量在句子边界截断，避免半句话
    const cut = Math.max(head.lastIndexOf('？'), head.lastIndexOf('！'), head.lastIndexOf('。'), head.lastIndexOf('，'));
    text = cut >= MIN_GREETING_CHARS ? head.slice(0, cut + 1) : head;
  }
  return text;
}

// ---------------------------------------------------------------------------
// 深度解析（cv.md + JD → 标准 JSON）。与「写一条招呼语」共用同一套协议/鉴权/超时，
// 只有两点不同：JSON 模式（response_format）+ 更宽的输出预算（含思维链）。
// ---------------------------------------------------------------------------

// 结构化请求（JSON 模式）：解析/合并请求共用一条通路，只有预算与超时不同。
async function requestStructured(cfg = {}, prompts = {}, { maxTokens, timeoutMs, fetchImpl = globalThis.fetch } = {}) {
  const ready = llmReadiness(cfg);
  if (!ready.ok) throw new Error(ready.reason);
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch（需要 Node 18+）');
  const scoped = { ...cfg, maxTokens: maxTokens ?? cfg.maxTokens ?? LLM_FALLBACK.llm_max_tokens };
  const { url, headers, body } = buildLlmRequest(scoped, { ...prompts, json: true });
  // 批量请求一次要几十秒到几分钟，不能用「写一条招呼语」那档 60 秒超时
  const timeout = Number(timeoutMs) || Number(cfg.timeoutMs) || LLM_FALLBACK.llm_timeout_ms;
  const payload = await httpPostJson(url, headers, body, timeout, fetchImpl);
  const content = parseLlmResponse(cfg.protocol || 'chat', payload);
  const usage = payload?.usage || {};
  return {
    content,
    usage: {
      prompt: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
      completion: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
      reasoning: Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0),
      cacheHit: Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0),
      credit: Number(usage.credit ?? 0),
    },
  };
}

// 单条评估（保留给补跑 / 单岗重试用）：预算与超时按「一批 1 条」自动推算
export async function requestAnalysis(cfg = {}, prompts = {}, { fetchImpl = globalThis.fetch } = {}) {
  const budget = autoBudgets(1);
  return requestStructured(cfg, prompts, { maxTokens: budget.maxTokens, timeoutMs: budget.timeoutMs, fetchImpl });
}

// 深度解析单岗位：一次调用拿回「结构化字段 + 招呼语」，失败返回 {ok:false} 交给调用方决定。
export async function analyzeJob({ job = {}, cv = '', cfg = {}, fetchImpl } = {}) {
  const { buildAnalysisSystemPrompt, buildAnalysisUserPrompt, normalizeAnalysis, extractJsonObject } =
    await import('./boss-llm-schema.mjs');
  const startedAt = Date.now();
  const ready = llmReadiness(cfg);
  if (!ready.ok) return { ok: false, error: ready.reason, latencyMs: 0 };
  try {
    const { content, usage } = await requestAnalysis(cfg, {
      system: buildAnalysisSystemPrompt(cv),
      user: buildAnalysisUserPrompt(job),
    }, { fetchImpl });
    const parsed = extractJsonObject(content);
    if (!parsed) {
      return {
        ok: false,
        error: `返回内容不是合法 JSON（前 120 字：${String(content).slice(0, 120).replace(/\s+/g, ' ')}）`,
        latencyMs: Date.now() - startedAt,
        usage,
      };
    }
    const normalized = normalizeAnalysis(parsed);
    if (!normalized.ok) {
      return { ok: false, error: `结构校验失败：${normalized.errors.join('；')}`, latencyMs: Date.now() - startedAt, usage };
    }
    return { ok: true, analysis: normalized.data, usage, latencyMs: Date.now() - startedAt };
  } catch (err) {
    const message = String(err?.message || err);
    // 思维链吃光预算时，把「这次到底给了多少预算」和可行出路一起说出来，别让人猜
    const hint = /reasoning_tokens/.test(message)
      ? `（本次预算 max tokens=${autoBudgets(1).maxTokens}：调大每批条数或勾「关闭思考链」`
        + '——实测同一任务省约 4 倍费用 / 5 倍时间）'
      : '';
    return { ok: false, error: message + hint, latencyMs: Date.now() - startedAt };
  }
}

// ---------------------------------------------------------------------------
// 批量评估（2026-10-30 用户定的口径，替换掉「偏解析 + 招呼语」两套流程）：
//   **一个批次 = 一次请求**：带 cv.md + 这一批每个岗位的 JD，
//   返回每个岗位的「匹配结构（job/match） + 招呼语（greeting）」。
//   批次数 = ⌈待处理岗位数 ÷ 每批岗位数⌉，脚本自己算，只此一个参数。
//   输出预算与超时按每批条数**自动**推算（autoBudgets），不再让用户填第二、第三个数字。
//   整批失败或模型漏项 → 对半拆开重试，直到单条；仍失败的交回调用方回落模板文案。
// ---------------------------------------------------------------------------

// 每批条数 → 单批超时；**不再推算 max_tokens**。
// 2026-10-30 实测（`GET /v1/models` 元数据）：cn:deepseek-v4.1-flash 的 `max_output_tokens = 393216`；
// 不传 max_tokens 时 20 条一批也正常跑完（completion 11728、finish=stop、20/20 全中）。
// 所以这里只保留超时（防止单批挂死），token 上限交还给模型/网关 —— 不再让用户看一个没意义的数字。
export function autoBudgets(batchSize) {
  const n = Math.max(1, Math.min(Number(batchSize) || LLM_FALLBACK.llm_analyze_batch_size, 100));
  return {
    // 0 = **不传** max_tokens（上限由模型决定，实测 393k，20 条一批只需 11.7k）
    maxTokens: 0,
    timeoutMs: Math.min(1800000, n * 20000),
  };
}

// 一次请求 = 一批。返回 { ok, items:[{key_hash, analysis}], missing, errors, usage, latencyMs, repaired }
export async function analyzeBatchOnce({ jobs = [], cv = '', cfg = {}, retryNote = false, fetchImpl } = {}) {
  const { buildBatchAnalysisSystemPrompt, buildBatchAnalysisUserPrompt, normalizeBatchAnalysis, extractJsonObject } =
    await import('./boss-llm-schema.mjs');
  const list = Array.isArray(jobs) ? jobs : [];
  const startedAt = Date.now();
  const ready = llmReadiness(cfg);
  if (!ready.ok) return { ok: false, items: [], missing: list.map((j) => j.key_hash), errors: [ready.reason], latencyMs: 0 };
  if (!list.length) return { ok: true, items: [], missing: [], errors: [], latencyMs: 0 };
  const budget = autoBudgets(list.length);
  try {
    // 二次补发时在用户消息末尾加一句明确的「这次只输出这几条、务必完整」，模型漏项率明显下降
    const userPrompt = retryNote
      ? `${buildBatchAnalysisUserPrompt(list)}\n\n【重试】上一次的返回不完整。这一次只针对上面这 ${list.length} 个岗位，务必输出完整 JSON（analyses 数组长度必须等于 ${list.length}）。`
      : buildBatchAnalysisUserPrompt(list);
    const { content, usage } = await requestStructured(cfg, {
      system: buildBatchAnalysisSystemPrompt(cv),
      user: userPrompt,
    }, { maxTokens: budget.maxTokens, timeoutMs: budget.timeoutMs, fetchImpl });
    const parsed = extractJsonObject(content);
    if (!parsed) {
      return {
        ok: false,
        items: [],
        missing: list.map((j) => j.key_hash),
        errors: [`返回内容不是合法 JSON（前 120 字：${String(content).slice(0, 120).replace(/\s+/g, ' ')}）`],
        latencyMs: Date.now() - startedAt,
        usage,
      };
    }
    const repaired = parsed.__repaired || null;
    const normalized = normalizeBatchAnalysis(parsed, list);
    const errors = [...normalized.errors];
    if (repaired) errors.unshift(`返回被截断，已本地修复（丢掉尾部 ${repaired.info.droppedChars} 字符，补 ${repaired.info.closers}）`);
    return {
      ok: normalized.items.length > 0,
      items: normalized.items,
      missing: normalized.missing,
      errors,
      repaired,
      latencyMs: Date.now() - startedAt,
      usage,
    };
  } catch (err) {
    const message = String(err?.message || err);
    const hint = /reasoning_tokens/.test(message)
      ? `（本批 ${list.length} 条，输出预算 max tokens=${budget.maxTokens}：调大每批预算或减小每批条数）`
      : '';
    return { ok: false, items: [], missing: list.map((j) => j.key_hash), errors: [message + hint], latencyMs: Date.now() - startedAt };
  }
}

// 分块 + 三层兜底：本地修复截断 → 对半拆批 → 单条二次补发。
// 顺序跑：一次请求本身就是并发了，再叠并发只会把网关打满。
export async function analyzeJobsChunked({ jobs = [], cv = '', cfg = {}, onItem, fetchImpl } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const batchSize = Math.max(1, Math.min(Number(cfg.batchSize) || LLM_FALLBACK.llm_analyze_batch_size, 100));
  const summary = {
    ok: 0,
    requests: 0,
    fallbackSplits: 0,
    repaired: 0,
    retries: 0,
    failed: [],
    errors: [],
    usage: { prompt: 0, completion: 0, reasoning: 0, cacheHit: 0, credit: 0 },
  };
  // 二次补发预算：最多补 min(20, 待处理条数) 次，避免一个坏批次把费用翻倍
  const retryBudget = Math.max(1, Math.min(20, list.length));
  const retried = new Set();
  const addUsage = (u) => {
    if (!u) return;
    for (const key of Object.keys(summary.usage)) summary.usage[key] += Number(u[key] || 0);
  };

  const applyResult = async (r, chunk) => {
    for (const item of r.items) {
      summary.ok += 1;
      if (typeof onItem === 'function') await onItem(item, chunk);
    }
  };

  const runChunk = async (chunk, { retryNote = false } = {}) => {
    const r = await analyzeBatchOnce({ jobs: chunk, cv, cfg, retryNote, fetchImpl });
    summary.requests += 1;
    addUsage(r.usage);
    if (r.repaired) {
      summary.repaired += 1;
      console.error(`[boss-llm] 返回被截断，已本地修复保住 ${r.items.length} 条（${r.errors[0] || ''}）`);
    }
    await applyResult(r, chunk);
    const failedJobs = chunk.filter((job) => r.missing.includes(job.key_hash));
    if (!failedJobs.length) return;

    if (failedJobs.length === 1) {
      const job = failedJobs[0];
      // 单条二次补发：只重发这一条，并明确要求「这次只输出这条」
      if (!retried.has(job.key_hash) && summary.retries < retryBudget) {
        retried.add(job.key_hash);
        summary.retries += 1;
        console.error(`[boss-llm] 二次补发 1 条：${job.company || '?'} / ${job.title || '?'}`);
        await runChunk([job], { retryNote: true });
        return;
      }
      summary.failed.push({ job, error: (r.errors && r.errors[0]) || '模型漏返回该岗位' });
      return;
    }
    // 整批都没回来 = 请求本身有问题（超时/预算/网关）；只回来一部分 = 模型漏了。两种都拆半重试
    summary.fallbackSplits += 1;
    const line = `批量 ${chunk.length} 条中有 ${failedJobs.length} 条未拿到结果${r.errors?.[0] ? `（${r.errors[0].slice(0, 120)}）` : ''}，已对半拆开重试`;
    summary.errors.push(line);
    console.error(`[boss-llm] ${line}`); // 即时打印：不要等整轮跑完才让人看到
    const mid = Math.ceil(failedJobs.length / 2);
    await runChunk(failedJobs.slice(0, mid));
    await runChunk(failedJobs.slice(mid));
  };

  let cursor = 0;
  while (cursor < list.length) {
    const chunk = list.slice(cursor, cursor + batchSize);
    cursor += chunk.length;
    // 每批先打印「岗位编号 = 公司」映射：模型返回的 id 拿这个能直接回库里的行
    const refs = chunk.slice(0, 8).map((job, idx) => `${job.dbId ?? idx + 1}=${job.company || '?'}`).join(' · ');
    console.error(`[boss-llm] 发送第 ${Math.ceil(cursor / batchSize)}/${Math.ceil(list.length / batchSize)} 批：${chunk.length} 条 · ${refs}${chunk.length > 8 ? ' …' : ''}`);
    await runChunk(chunk);
    if (typeof cfg.onBatch === 'function') cfg.onBatch(cursor, list.length);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

export const DEFAULT_SYSTEM_PROMPT = [
  '你是求职者本人，正在 BOSS 直聘上给招聘方发第一条打招呼消息。',
  '硬性规则：',
  '1. 只能使用我给你的「我的画像」里的事实。绝对不要编造公司、学历、工作年限、项目名或任何数字指标。',
  '2. 不要复述简历，只挑 1–2 个与该岗位要求最贴合的点。',
  '3. 语气像真人：礼貌、具体、不油腻。禁用「贵公司」「您好，我是一名…」这类模板腔，不使用表情符号。',
  '4. 60–120 字，一段话，不分点、不用 markdown。',
  '5. 结尾用一个自然的问题邀请对方沟通。',
  '6. 只输出这条消息的正文，不要任何前缀、解释或引号。',
].join('\n');

const STYLE_HINTS = {
  稳重专业: '稳重、专业，突出与岗位要求的匹配度，不夸张。',
  简洁直接: '尽量短，一句话说清我在做什么、想聊什么，不铺垫。',
  偏岗位匹配: '围绕 JD 里的具体职责/关键词说明我做过什么，落到岗位需求上。',
  积极主动: '主动一些，表达愿意进一步了解团队和职责。',
  偏技术细节: '点出一个具体的技术点或做法，体现动手能力。',
  偏业务价值: '谈这件事对业务的价值/结果，而不是工具本身。',
};

function clip(text, max) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function buildGreetingPrompt({ job = {}, profile = {}, context = {}, style = '' } = {}) {
  const skills = (context.skills || []).slice(0, 4);
  const focus = (context.jd_focus || []).slice(0, 4);
  const evidence = (context.evidence || []).slice(0, 2);
  const coreSkills = (Array.isArray(profile?.skills?.core) ? profile.skills.core : []).slice(0, 6);
  const target = (Array.isArray(profile?.target?.roles) ? profile.target.roles : [])[0] || '';
  const currentTitle = profile?.candidate?.current_title || '';
  const jd = clip(job.desc || job.description || '', 1200);
  const styleHint = STYLE_HINTS[style] || STYLE_HINTS['稳重专业'];

  const lines = [
    '【岗位】',
    `公司：${job.company || '未知'}`,
    `职位：${job.title || '未知'}`,
    `城市：${job.city || job.location || '未知'}`,
    `薪资：${job.salary || '未知'}`,
  ];
  if (focus.length) lines.push(`JD 关键词：${focus.join('、')}`);
  if (jd) lines.push(`JD 摘录：${jd}`);
  lines.push('', '【我的画像（只可用这些事实）】');
  if (currentTitle) lines.push(`当前职位：${currentTitle}`);
  if (target) lines.push(`目标方向：${target}`);
  lines.push(`核心技能：${(coreSkills.length ? coreSkills : skills).join('、') || '未提供'}`);
  if (skills.length) lines.push(`与该岗位匹配的技能：${skills.join('、')}`);
  if (evidence.length) lines.push(`相关的经历亮点：${evidence.join('；')}`);
  lines.push('', `【写作风格】${styleHint}`, '【输出】只输出这条打招呼消息的正文（60–120 字，一段话）。');
  return { system: DEFAULT_SYSTEM_PROMPT, user: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

async function httpPostJson(url, headers, body, timeoutMs, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch（需要 Node 18+）');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const detail = json ? (json.error?.message || JSON.stringify(json)) : String(text || '').slice(0, 300);
      throw new Error(`HTTP ${res.status}：${String(detail).slice(0, 300)}`);
    }
    if (!json) throw new Error('LLM 返回的不是 JSON（可能 base url 拼错或选错协议）');
    return json;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`LLM 请求超时（>${timeoutMs}ms）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 发一次请求拿文案；失败抛错，由 resolveGreeting 决定回落模板。
export async function requestGreeting(cfg, prompt, { fetchImpl = globalThis.fetch } = {}) {
  const ready = llmReadiness(cfg);
  if (!ready.ok) throw new Error(ready.reason);
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch（需要 Node 18+）');
  const { url, headers, body } = buildLlmRequest(cfg, prompt);
  const json = await httpPostJson(url, headers, body, Number(cfg.timeoutMs) || LLM_FALLBACK.llm_timeout_ms, fetchImpl);
  return parseLlmResponse(cfg.protocol, json);
}

// 单岗位：LLM 优先，任何失败都回落模板文案（job.greeting / 传入的模板）。
// 返回 { text, source: 'llm'|'template', error, latencyMs }，调用方无需 try/catch。
export async function resolveGreeting({ job = {}, profile = {}, context = {}, cfg = {}, fetchImpl } = {}) {
  const template = String(job.greeting || '').trim();
  const startedAt = Date.now();
  const ready = llmReadiness(cfg);
  if (!ready.ok) {
    return { text: template, source: 'template', error: ready.reason, latencyMs: 0 };
  }
  const style = profile?.boss?.greeting_style || '稳重专业';
  const prompt = buildGreetingPrompt({ job, profile, context, style });
  if (cfg.prompt) prompt.system = cfg.prompt;
  try {
    const raw = await requestGreeting(cfg, prompt, { fetchImpl });
    const text = coerceGreeting(raw);
    if (!text) throw new Error('LLM 文案被清洗后为空（可能只返回了拒绝或格式说明）');
    return { text, source: 'llm', error: '', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      text: template,
      source: 'template',
      error: String(err?.message || err),
      latencyMs: Date.now() - startedAt,
    };
  }
}

// 并发受限的批量 map（LLM 调用一多，全量并发会被服务端限流/打爆）
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      out[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

// 这个岗位是否已经联系过（打过招呼 / 手动确认 / 平台默认招呼已发）。
// 深解析与招呼语生成都要跳过这类岗位：文案已经发出去了，再生成一遍纯浪费钱
// （2026-10-30 用户指出：已发送的不用管）。
export function isContacted(job = {}) {
  if (job?.greeted === true || Number(job?.greeted) === 1) return true;
  const state = String(job?.contactState || job?.contact_state || '');
  return ['custom_sent', 'auto_greeted_unverified', 'manual_contact_confirmed', 'legacy_contact_unknown'].includes(state);
}

// 这一轮要给哪些岗位做评估（匹配 + 招呼语，一次请求一批）。抽成纯函数，好测也好解释：
//   - 已联系过的岗位一律跳过（force 也不覆盖：消息都发出去了，再评估纯浪费钱）；
//   - 已经有 LLM 结果的岗位（raw.llm 已在库里）默认跳过 —— 这就是增量；
//   - 排序：先「本轮可发送」的，再按规则分从高到低；
//   - cap = 本次最多处理多少条，只给测试/补跑用（0 = 不限，正常流程走全量）。
// 注意：这里没有第二、第三个上限 —— 待处理多少就是多少，批次数由 batchSize 算。
export function selectLlmTargets(jobs = [], { force = false, cap = 0, city = '' } = {}) {
  const summary = { skippedExisting: 0, skippedContacted: 0, skippedOtherCity: 0, skippedExcluded: 0, capped: 0 };
  const list = Array.isArray(jobs) ? jobs : [];
  const scope = String(city || '').trim();
  const inCity = (job) => !scope || String(job?.city || job?.location || '').split('·')[0] === scope;
  // 「已评估完成」必须是**完整记录**：既有匹配结构、也有文案。
  // 只判 llm.match 会让历史残缺记录（有解析、greeting.text 为空）被永久跳过，永远拿不到 LLM 文案。
  const hasLlmResult = (job) => Boolean(job?.llm && job.llm.match && job.llm.greeting?.text);
  // 人工排除 = 用户明确「不发送」，这类岗位不该再花模型钱。
  // 2026-10-30 实测：587 条被排除的岗位里有 461 条还躺在待评估队列，跑全量会白花 ≈88 credit。
  const isExcluded = (job) => Boolean(job?.manualExcluded || job?.manual_excluded);
  const pending = list.filter((job) => {
    if (isContacted(job)) { summary.skippedContacted += 1; return false; }
    // 人工排除 = 用户明确「任何情况都不需要这些岗位」：没有任何开关能放它回来
    if (isExcluded(job)) { summary.skippedExcluded += 1; return false; }
    // 单城扫描（控制台点某个城市的「扫描」）只评估这个城市的岗位，
    // 不然点南京会把上海/厦门的待处理岗位一起烧掉——那是另一笔钱。
    if (!inCity(job)) { summary.skippedOtherCity += 1; return false; }
    if (!force && hasLlmResult(job)) { summary.skippedExisting += 1; return false; }
    return true;
  });
  const sorted = pending.slice().sort((a, b) => {
    if (Boolean(b.eligible) !== Boolean(a.eligible)) return b.eligible ? 1 : -1;
    return Number(b.score ?? 0) - Number(a.score ?? 0);
  });
  const max = Number.isFinite(Number(cap)) ? Math.max(0, Math.trunc(Number(cap))) : 0;
  const targets = max === 0 ? sorted : sorted.slice(0, max);
  summary.capped = sorted.length - targets.length;
  return { targets, total: sorted.length, ...summary };
}

// 控制台「测试连通」用：最小请求，确认 base url / 协议 / 模型 / key 四处都对。
export async function testLlmConnection(cfg, { fetchImpl } = {}) {
  const ready = llmReadiness(cfg);
  if (!ready.ok) throw new Error(ready.reason);
  const startedAt = Date.now();
  const prompt = { system: '你是一个连通性测试接口。', user: '只回复两个字：可用' };
  const json = await (async () => {
    const { url, headers, body } = buildLlmRequest(cfg, prompt);
    return httpPostJson(url, headers, body, Number(cfg.timeoutMs) || LLM_FALLBACK.llm_timeout_ms, fetchImpl);
  })();
  const text = parseLlmResponse(cfg.protocol, json);
  return { ok: true, latencyMs: Date.now() - startedAt, sample: clip(text, 60) };
}








