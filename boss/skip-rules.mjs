#!/usr/bin/env node
// skip-rules.mjs — 跳词 / 排除规则：默认词表 + 「字符串数组 ↔ 正则」共用实现（2026-10-14 统一到控制台）
//
// 三处阶段各有一份规则，全部以 DB boss_config.boss_city_control 为唯一来源，控制台可编辑：
//   skip_words       提取阶段：命中卡片文本或 JD → 直接丢弃，岗位不入库（boss-chrome-extract.mjs）
//   risk_keywords    评分阶段：命中只作为风险信号参与评分，不影响入库（boss-score.mjs）
//   title_exclude    排队阶段：标题命中 → 从发送队列剔除（boss-filter-queue.mjs）
//   company_exclude  排队阶段：公司命中 → 从发送队列剔除（boss-filter-queue.mjs）
//
// 前三个（含 company_exclude）按**正则片段**逐项拼接后整体编译，所以像 `某[^\n]{0,16}公司`
// 这样的写法可用；risk_keywords 走纯子串匹配（用户写什么就匹配什么，不必懂正则）。
//
// 词表来源优先级（提取阶段）：BOSS_SKIP_WORDS 环境变量 > DB 配置 > 本文件默认值。
// 空数组是合法值——表示「这条规则不启用」，不会被默认值悄悄补回来。

// 提取阶段默认跳词（与 2026-10-08 起的硬编码规则逐字一致）
export const DEFAULT_SKIP_WORDS = [
  '外包', '派遣', '猎头', '驻场', '某[^\\n]{0,16}公司', '催收', '电催', '贷后',
  '信用卡逾期', '纯销售', '电话销售', '不缴社保', '无社保', '大小周',
];

// 评分阶段默认风险词（原 boss-score.mjs RISK_KEYWORDS）
export const DEFAULT_RISK_KEYWORDS = [
  '外包', '派遣', '猎头', '驻场', '外派', '长期出差', '大小周', '单休', '无社保', '不缴社保',
  '培训贷', '催收', '电催', '贷后', '信用卡逾期', '逾期账款', '纯销售', '电话销售', '销售岗',
  '业绩提成',
];

// 排队阶段默认标题排除（原 boss-filter-queue.mjs TITLE_EXCLUDE）
export const DEFAULT_TITLE_EXCLUDE = ['校招', '应届', '实习', '秋招', '春招', '毕业生'];

// 排队阶段默认公司排除（原 boss-filter-queue.mjs COMPANY_EXCLUDE）
export const DEFAULT_COMPANY_EXCLUDE = [
  '人力', '代招', 'FESCO', '外企德科', '科锐国际', '万宝盛华', '任仕达', '北京外企服务',
];

// 永远不匹配的正则：词表为空时用它占位，调用方不必到处判 null
export const NEVER_MATCH = /(?!)/;

/**
 * 按分隔符拆一行规则文本，**但保护正则里的逗号**。
 *
 * 分隔符：换行 / 逗号 / 顿号 / 分号（半角全角都算）。
 * 不拆的情况：`{m,n}` 量词、`[...]` 字符类、`\` 转义里的逗号——
 * 所以 `某[^\n]{0,16}公司` 是一条，不会被 `{0,16}` 里的逗号拆成两条。
 *
 * 为什么要宽容：控制台里把「校招,应届,实习」写在同一行是很自然的输入，
 * 若只按换行拆，它会变成一个正则片段（等于过滤静默失效）。
 *
 * @param {unknown} text
 * @returns {string[]} 去掉空白与空项后的规则数组
 */
export function splitRuleText(text) {
  const out = [];
  let cur = '';
  let depth = 0;      // { } 量词深度
  let inClass = false; // [ ] 字符类
  let escaped = false;
  for (const ch of String(text ?? '')) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\') { cur += ch; escaped = true; continue; }
    if (inClass) { cur += ch; if (ch === ']') inClass = false; continue; }
    if (ch === '[') { cur += ch; inClass = true; continue; }
    if (ch === '{') { cur += ch; depth += 1; continue; }
    if (ch === '}') { cur += ch; if (depth > 0) depth -= 1; continue; }
    if (depth === 0 && (ch === '\n' || ch === '\r' || ch === ',' || ch === '，' || ch === '、' || ch === ';' || ch === '；')) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 把「数组或分隔符字符串」统一成字符串数组。
 *
 * 控制台输入框里是 `外包, 猎头` 这样的文本（也允许一行一条），DB 里存的是数组；两者都要能读，
 * 且数组里的每一项也再过一次 splitRuleText——这样「一行写完」的历史数据在保存时会被自动拆开。
 *
 * @param {unknown} value 数组 / 字符串 / 其它
 * @returns {string[]|null} 规范化后的数组；既不是数组也不是字符串时返回 null（由调用方决定兜底）
 */
export function splitWordList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((v) => v != null && String(v).trim() !== '')
      .flatMap((v) => splitRuleText(v));
  }
  if (typeof value === 'string') return splitRuleText(value);
  return null;
}

/**
 * 词表 → 正则（每一项按正则片段处理）。
 *
 * @param {string[]} list
 * @returns {RegExp|null} 空词表返回 null（= 该规则不启用）；正则非法时也返回 null，绝不让扫描崩掉
 */
export function buildWordRegex(list) {
  const words = splitWordList(list);
  if (!words || words.length === 0) return null;
  try {
    return new RegExp(words.join('|'));
  } catch {
    return null;
  }
}

/**
 * 校验词表能否编译成合法正则——控制台保存前用，把非法正则挡在保存那一步，
 * 而不是等到扫描时静默回落默认值。
 *
 * @param {string[]} list
 * @returns {string|null} 错误信息，合法时为 null
 */
export function validateWordRegex(list) {
  const words = splitWordList(list);
  if (!words || words.length === 0) return null;
  try {
    new RegExp(words.join('|'));
    return null;
  } catch (err) {
    return String(err?.message || err);
  }
}

/**
 * 把 `preferences.reject` 的命中拆成两类。
 *
 * 2026-10-14 用户确认：reject 里的「北京 / 深圳 / 广州」本意是「不在这些城市投递」，
 * 但之前和风险词一起比对标题+正文，导致任何杭州岗位只要 JD 里出现「北京/上海/杭州」
 * 就被判不可发送、`score` 留空（杭州一天内有 15 条这样被误伤）。
 *
 * 拆分规则：
 *   - 词本身是城市名（在 cityWords 里）→ 只比对**岗位所在城市** `job.city`
 *   - 其它词（外包 / 派遣 / 海外…）→ 比对标题+正文，行为不变
 *
 * @param {object} params
 * @param {string[]} [params.reject] 原始 reject 词表
 * @param {string[]} [params.cityWords] 视为「城市名」的词表（一般取 BOSS_CITY_CODES 的键）
 * @param {string} [params.titleAndDesc] 标题 + 正文 + 标签
 * @param {string} [params.city] 岗位所在城市（如 `杭州·滨江区·长河`）
 * @returns {{textHits: string[], cityHits: string[]}}
 */
export function matchRejectHits({ reject = [], cityWords = [], titleAndDesc = '', city = '' } = {}) {
  const citySet = new Set((cityWords || []).map((c) => String(c ?? '').trim()).filter(Boolean));
  const textHits = [];
  const cityHits = [];
  for (const raw of reject || []) {
    const kw = String(raw ?? '').trim();
    if (!kw) continue;
    if (citySet.has(kw)) {
      if (String(city || '').includes(kw)) cityHits.push(kw);
    } else if (String(titleAndDesc || '').includes(kw)) {
      textHits.push(kw);
    }
  }
  return { textHits, cityHits };
}

/**
 * 取词表：显式配置（数组，含空数组）优先，否则用默认值。
 *
 * @param {unknown} value 来自 DB / 环境变量的值
 * @param {string[]} fallback 默认词表
 * @returns {string[]}
 */
export function resolveWordList(value, fallback) {
  const words = splitWordList(value);
  return words === null ? [...fallback] : words;
}

/**
 * 提取阶段跳词的解析：BOSS_SKIP_WORDS 环境变量 > DB 配置 > 内置默认。
 *
 * 环境变量里的多项用**换行或分号**分隔——刻意不按逗号拆，否则 `某[^\n]{0,16}公司`
 * 这类正则片段会被 `{0,16}` 里的逗号拆成两半。DB 里存的是数组，不经过这一层。
 *
 * DB 读失败不抛错（扫描不该因为读不到配置就停），而是回落内置默认并在返回值里带上原因。
 *
 * @param {object} deps
 * @param {string} [deps.envValue] BOSS_SKIP_WORDS 的值
 * @param {() => Promise<object>} deps.loadControl 读 DB 配置（boss-config-db 的 loadBossControl）
 * @returns {Promise<{words: string[], source: string, error?: string}>}
 */
export async function resolveExtractSkipWords({ envValue, loadControl } = {}) {
  const fromEnv = String(envValue || '')
    .split(/[\n;；]+/).map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return { words: fromEnv, source: 'env BOSS_SKIP_WORDS' };

  try {
    const cfg = await loadControl();
    if (Array.isArray(cfg?.skip_words)) return { words: cfg.skip_words, source: 'DB boss_config.skip_words' };
  } catch (err) {
    return {
      words: [...DEFAULT_SKIP_WORDS],
      source: '内置默认',
      error: String(err?.message || err),
    };
  }
  return { words: [...DEFAULT_SKIP_WORDS], source: '内置默认' };
}

/**
 * 提取阶段「标题排除」的解析：BOSS_TITLE_EXCLUDE 环境变量 > DB 配置 > 内置默认。
 *
 * 2026-10-15 用户要求：校招/应届/实习…这些岗位不要等到"排队/人工点一下"才剔除，
 * 扫描时就按**卡片标题**丢掉（不点击、不入库）。词表沿用控制台「排队·标题排除」
 * （DB `title_exclude`），所以配置处仍然只有一处，取空数组即等于关闭。
 *
 * 与 skip_words 的差别：skip_words 比对卡片文本 + JD 正文，要点了才丢；本规则只比对标题，
 * 在点击前就能丢弃，省一次点击、也不占候选池。详情页标题与卡片标题可能不同（卡片标题会截断），
 * 所以抽取器在点击后还会用同一个词表复核一次。
 *
 * @param {object} deps
 * @param {string} [deps.envValue] BOSS_TITLE_EXCLUDE 的值（逗号/换行/顿号分隔）
 * @param {() => Promise<object>} deps.loadControl 读 DB 配置（boss-config-db 的 loadBossControl）
 * @returns {Promise<{words: string[], source: string, error?: string}>}
 */
export async function resolveExtractTitleExclude({ envValue, loadControl } = {}) {
  const fromEnv = splitRuleText(envValue);
  if (fromEnv.length) return { words: fromEnv, source: 'env BOSS_TITLE_EXCLUDE' };

  try {
    const cfg = await loadControl();
    if (Array.isArray(cfg?.title_exclude)) {
      return { words: cfg.title_exclude, source: 'DB boss_config.title_exclude' };
    }
  } catch (err) {
    return {
      words: [...DEFAULT_TITLE_EXCLUDE],
      source: '内置默认',
      error: String(err?.message || err),
    };
  }
  return { words: [...DEFAULT_TITLE_EXCLUDE], source: '内置默认' };
}
