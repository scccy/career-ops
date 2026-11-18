// boss-apply-failure.mjs — 单条岗位失败分级 + 连续失败断路器
//
// 为什么有这个模块（2026-11-18 用户反馈）：
// 发送循环原来是「只要不是『职位已关闭』就 break」——一条页面异常的岗位就能把整批作废。
// 生产实测的典型现场是岗位页没渲染完 / 按钮结构变了，报
//   `未找到“立即沟通”按钮：[]`
// 然后队列里剩下的 19 家一条都不发。用户的原话：
//   「未找到沟通按钮应该执行下一个，现在好像是任务都一次性结束了」
//
// 但原 break 不是没理由的：风控、掉登录、发送未验证这几类故障下继续点，只会把账号做得更危险，
// 而且会把「不知道发没发出去」当成「没发」重复骚扰 HR。所以这里不改「停批次」的语义，
// 改的是**什么算环境故障**——把「这条岗位点不了」和「整批环境坏了」分开：
//
//   closed    岗位已下线            → 记 closed、标库出局，继续下一家（原行为）
//   auto_sent 继续沟通场景 BOSS 已自动发默认语 → 记 auto_sent，继续（原行为）
//   skip      这条岗位点不了        → 记 skipped，不计当日额度、不计 30 天去重，继续下一家
//   fatal     环境级故障/状态未知   → 立刻停批次（原语义，fail-safe）
//
// ⚠️ skip 的安全前提（对每条 SKIP_CODES 都成立，改这个集合前先验证）：
//    失败发生在**不可能已经发出消息**的时点 —— 页面没打开、按钮没找到、输入框没出现、
//    文案没填进去、发送按钮没点。一旦点过「立即沟通」（BOSS 会顺手自动发默认打招呼语）
//    或点过「发送」，结果就是 unknown，必须走 fatal，否则下一轮重复打招呼。
//    所以 CLICK_NO_RESPONSE（点了 3 次没反应）属于 unknown，不在 skip 里。
//
// 连续 N 条 skip 升级为致命：单条坏岗位是正常损耗，连着坏基本只有一个解释——
// 页面结构整体变了，或者风控在悄悄拦。继续点只会加重风控，所以到上限就停，
// N = --max-consecutive-failures（默认 3；0 关闭；--stop-on-first-failure 等价 N=1）。

// 页面出现这些字样 = 风控/登录态问题，与「这条岗位点不了」不是一回事。
// 只匹配足够强的信号（「请登录」而不是泛泛的「登录」，避免把正常页头误判成掉登录）。
// 注意：判定用的是**限定范围的**页面文本（弹窗/标题/URL/短页面），不是整页 body——
// 否则一个「风控算法工程师，处理验证码」的岗位 JD 自己就会把整批判成风控（2026-11-18 复核发现）。
export const RISK_CONTROL_RE = /安全验证|请完成验证|访问过于频繁|操作过于频繁|验证码|账号异常|请登录|重新登录|登录状态已失效|页面已被重置|about:blank/;
// 同一份词表交给浏览器端拼字符串用（避免两处词表漂移）
export const RISK_CONTROL_SOURCE = RISK_CONTROL_RE.source;

// 岗位级失败：页面/岗位本身的毛病，换下一家几乎必然正常；且失败时点保证「还没发出任何消息」。
const SKIP_CODES = new Set([
  'NO_CHAT_BUTTON',      // 岗位页没有「立即沟通/继续沟通/聊一聊」按钮（一次都没点过）
  'JOB_PAGE_TIMEOUT',    // 岗位页 25s 没加载完（页面都没打开）
  'NO_CHAT_INPUT',       // 点开沟通后没出现消息输入框（还没到填文案/发送）
  'FILL_INPUT_FAILED',   // 输入框在，但文案没填进去
  'NO_SEND_BUTTON',      // 文案填好了，「发送」按钮却不可点（没点过发送）
  'CONVERSATION_NOT_FOUND', // 消息页里搜不到这家公司的会话
  'MISSING_GREETING',    // 库里这条岗位没生成打招呼文案（还没碰浏览器）
]);

// 环境级失败：停批次。
const FATAL_CODES = new Set([
  // 「点了发送，但聊天记录里验证不到自定义文案」——可能已经发出去了。
  // 这时继续发下一条，等于在状态未知的情况下往前推，必须停（见 SKILL.md 发送验证检查点）。
  'UNVERIFIED_SEND',
  // 点了 3 次「立即沟通」页面毫无反应：点击本身可能已经触发 BOSS 自动发默认招呼，
  // 只是页面还没反应（网络/重渲染慢）。状态未知 → 停批次。
  'CLICK_NO_RESPONSE',
  'MESSAGE_PAGE_TIMEOUT', // 消息页（继续沟通兜底路径）都没打开
  'RISK_CONTROL',
  'CDP_DISCONNECTED',
  'UNKNOWN',
]);

const REASON_BY_CODE = {
  NO_CHAT_BUTTON: '岗位页没有可点的沟通按钮（页面结构变化或该岗位不可沟通）',
  JOB_PAGE_TIMEOUT: '岗位页加载超时',
  NO_CHAT_INPUT: '沟通窗口未出现消息输入框',
  FILL_INPUT_FAILED: '打招呼文案未填入输入框',
  NO_SEND_BUTTON: '「发送」按钮不可点',
  CONVERSATION_NOT_FOUND: '消息页找不到该公司会话',
  MISSING_GREETING: '该岗位没有生成打招呼文案',
  CLICK_NO_RESPONSE: '点击「立即沟通」3 次无反应，可能已触发自动招呼，状态未知，停止批量',
  MESSAGE_PAGE_TIMEOUT: 'BOSS 消息页加载超时，停止批量',
  UNVERIFIED_SEND: '点击发送后未在聊天记录验证到自定义文案，可能已发出，停止批量',
  RISK_CONTROL: '页面出现风控/登录验证信号，停止批量',
  CDP_DISCONNECTED: 'Chrome 调试端口/CDP 连接异常，停止批量',
  UNKNOWN: '未分类错误，按 fail-safe 停批次',
};

// 旧式字符串错误 → 错误码（历史调用点仍然抛纯文本 Error）
const MESSAGE_CODE_RULES = [
  [/^JOB_CLOSED/, 'JOB_CLOSED'],
  [/^AUTO_GREETED/, 'AUTO_GREETED'],
  [/未找到[“"]立即沟通[”"]按钮/, 'NO_CHAT_BUTTON'],
  [/岗位页面加载超时/, 'JOB_PAGE_TIMEOUT'],
  [/点击「立即沟通」\d+ 次均无反应/, 'CLICK_NO_RESPONSE'],
  [/未找到消息输入框/, 'NO_CHAT_INPUT'],
  [/未能填入/, 'FILL_INPUT_FAILED'],
  [/未找到可点击发送按钮|发送按钮未激活/, 'NO_SEND_BUTTON'],
  [/对应会话|会话在点击前消失|无法搜索联系人/, 'CONVERSATION_NOT_FOUND'],
  [/点击发送后未在.*验证到自定义文案/, 'UNVERIFIED_SEND'],
  [/CDP|连接已关闭|websocket/i, 'CDP_DISCONNECTED'],
];

// 抛带错误码的 Error，让判定与文案解耦（改文案不会改分级）。
export function applyError(code, message, meta = {}) {
  const err = new Error(String(message || code || 'apply failed'));
  err.applyCode = code;
  if (meta.pageState) err.pageState = meta.pageState;
  if (meta.cause) err.cause = meta.cause;
  return err;
}

export function codeOf(err) {
  if (err?.applyCode) return err.applyCode;
  const message = String(err?.message || '');
  for (const [re, code] of MESSAGE_CODE_RULES) {
    if (re.test(message)) return code;
  }
  return 'UNKNOWN';
}

// 错误链（重新包装过的错误会丢掉原始码/页面快照，例如
// `AUTO_GREETED: …补发失败：BOSS消息页加载超时` —— 只按外层的 AUTO_GREETED 判就会
// 把风控墙当成「默认语已发出」而继续点下一家）。
function errorChain(err) {
  const chain = [];
  let cur = err;
  for (let i = 0; cur && i < 5; i++) {
    chain.push(cur);
    cur = cur.cause;
  }
  return chain;
}

function detectRiskControl(chain, fallbackState) {
  // 只吃「页面端已经判定过的」riskText 与登录按钮，不再在这里重新扫 href/title：
  // 页面标题可以是「风控算法工程师（验证码）」，重新扫一遍等于把 JD 当成风控墙。
  const states = chain.map((item) => item?.pageState).concat([fallbackState]).filter(Boolean);
  const haystack = chain
    .map((item) => item?.message)
    .concat(states.map((state) => state.riskText))
    .filter(Boolean)
    .join(' ');
  const hit = String(haystack).match(RISK_CONTROL_RE);
  if (hit) return hit[0];
  // 页面上只剩「登录 / 登录·注册」按钮 = 登录态失效（正常已登录页面不显示它）
  if (states.some((state) => state.hasLoginButton)) return '登录/注册按钮（登录态失效）';
  return '';
}

/**
 * 把 sendOne 抛出的错误分成 closed / auto_sent / skip / fatal。
 * @param {Error} err
 * @param {{ pageState?: object }} [options] pageState 兜底（错误对象上没带时用）
 * @returns {{ kind: 'closed'|'auto_sent'|'skip'|'fatal', code: string, message: string, reason?: string, pageState: object|null }}
 */
export function classifyApplyFailure(err, { pageState = null } = {}) {
  const message = String(err?.message || '');
  const chain = errorChain(err);
  const code = codeOf(err);
  const state = pageState || err?.pageState || null;
  const base = { code, message, pageState: state };

  if (code === 'JOB_CLOSED' || /^JOB_CLOSED/.test(message)) {
    return { ...base, kind: 'closed', code: 'JOB_CLOSED', reason: '职位已关闭' };
  }
  // 风控优先于错误码：`未找到“立即沟通”按钮`、`AUTO_GREETED 补发失败` 都可能是风控把页面换掉了，
  // 这类不能算岗位级失败、也不能算「已自动发默认语」。
  const risk = detectRiskControl(chain, state);
  if (risk) {
    return { ...base, kind: 'fatal', code: 'RISK_CONTROL', reason: `${REASON_BY_CODE.RISK_CONTROL}（命中：${risk}）` };
  }
  if (code === 'AUTO_GREETED' || /^AUTO_GREETED/.test(message)) {
    return { ...base, kind: 'auto_sent', code: 'AUTO_GREETED', reason: 'BOSS 已自动发送默认打招呼语' };
  }
  if (FATAL_CODES.has(code)) {
    return { ...base, kind: 'fatal', reason: REASON_BY_CODE[code] || REASON_BY_CODE.UNKNOWN };
  }
  if (SKIP_CODES.has(code)) {
    return { ...base, kind: 'skip', reason: REASON_BY_CODE[code] || '岗位级失败' };
  }
  return { ...base, kind: 'fatal', reason: REASON_BY_CODE.UNKNOWN };
}

// 连续失败断路器。成功一条就清零；连续 skip 到上限才停批次。
export function createSkipBreaker({ maxConsecutiveSkips = 3 } = {}) {
  const raw = Number(maxConsecutiveSkips);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  let streak = 0;
  return {
    limit,
    get streak() {
      return streak;
    },
    recordSuccess() {
      streak = 0;
      return streak;
    },
    // { streak, limit, abort }；limit=0 时永不 abort（--max-consecutive-failures 0）
    recordFailure() {
      streak += 1;
      return { streak, limit, abort: limit > 0 && streak >= limit };
    },
  };
}

/**
 * 解析 --max-consecutive-failures / --stop-on-first-failure，冲突和取值错误在这里一次性说清楚。
 * @returns {{ maxConsecutiveSkips: number, notes: string[] }}
 */
export function resolveMaxConsecutiveSkips(args = {}) {
  const strict = Boolean(args['stop-on-first-failure']);
  const raw = args['max-consecutive-failures'];
  const notes = [];
  if (raw === true) throw new Error('--max-consecutive-failures 缺少取值（例：--max-consecutive-failures 3）');
  if (raw != null && !/^\d+$/.test(String(raw).trim())) {
    throw new Error(`--max-consecutive-failures 需要非负整数，收到：${raw}`);
  }
  const parsed = raw == null ? 3 : Number(raw);
  if (strict && raw != null) {
    notes.push('--stop-on-first-failure 与 --max-consecutive-failures 同时给出，按 --stop-on-first-failure（上限 1）执行。');
  }
  return { maxConsecutiveSkips: strict ? 1 : parsed, notes };
}

export function summarizeApplyResults(results = []) {
  const list = Array.isArray(results) ? results : [];
  const counts = { sent: 0, auto_sent: 0, closed: 0, skipped: 0, failed: 0 };
  for (const row of list) {
    const status = String(row?.status || '');
    if (counts[status] != null) counts[status] += 1;
  }
  return counts;
}
