// boss-config-db.mjs — BOSS 操作配置的**唯一**存储（PostgreSQL）
//
// 设计（2026-09-29 迁库；2026-10-23 收尾为单一基准；2026-10 由 MySQL 迁 PostgreSQL）：
//   - 单一配置行 boss_config.name = 'boss_city_control'，value 为 JSON 文本。
//   - **PostgreSQL 是唯一配置来源**：不再从 config/profile.yml 迁移、也不再回落 profile。连库失败直接抛错，
//     绝不用过期的文件值继续跑（历史事故：无数据库凭据时静默回落 profile，把厦门配额 120 写成 20）。
//   - 每次读取走共享连接池（pg-db.mjs），脚本运行结束自动关闭，进程可正常退出。
//
// 存储的键（即控制台「每日城市操作流程控制」管理的全部字段）：
//   send_threshold, daily_limit_per_city, daily_extract_queries, daily_extract_keywords_by_city
//   keyword_gap_seconds, city_gap_seconds, card_gap_min_ms, card_gap_max_ms, scan_budget_factor,
//   max_dom_cards, known_streak_limit,
//   require_full_jd, stale_hr_active_exclude, platform_daily_limit
//   skip_words / risk_keywords / title_exclude / company_exclude（跳词与排除规则，见 skip-rules.mjs）
//   llm_enabled, llm_protocol, llm_base_url, llm_model, llm_api_key, llm_temperature,
//   llm_max_tokens, llm_timeout_ms, llm_concurrency, llm_prompt（LLM 招呼语，见 boss-llm.mjs）
//
// 「扫哪些城市」不再单独存一份清单：**daily_limit_per_city 的键就是城市清单**
// （配额 0 = 只扫不发），避免清单与配额两份数据漂移。控制台「＋ 添加城市」写的就是这张表。
//
// 仍留 config/profile.yml 的只有**求职画像**（target_roles / location / compensation / narrative /
// boss.skills_core / boss.jd_focus_terms / boss.greeting_style / preferences）：那是"你要什么"，
// 由 boss-common.mjs 的 loadProfile() 读取，不属于操作配置。

import { query } from './pg-db.mjs';
import { ensureSchema } from './pg-schema.mjs';
import {
  DEFAULT_SKIP_WORDS,
  DEFAULT_RISK_KEYWORDS,
  DEFAULT_TITLE_EXCLUDE,
  DEFAULT_COMPANY_EXCLUDE,
  resolveWordList,
} from './skip-rules.mjs';
import { LLM_FALLBACK, normalizeLlmFields } from './boss-llm.mjs';

const CONFIG_ROW = 'boss_city_control';

const FALLBACK = {
  send_threshold: 3.0,
  // 空表 = 还没有配置任何城市。城市清单 = 本映射的键，故不再内置任何默认城市
  // （历史内置的 上海/杭州/南京/无锡/常州 只是迁库前副本，已随 2026-10-23 收尾删除）。
  daily_limit_per_city: {},
  daily_extract_queries: [],
  daily_extract_keywords_by_city: {},
  // BOSS 平台级每日沟通上限：0 = 不启用（用户自行通过城市配额管理，
  // 会员可解除平台限制）。仅在显式配置 >0 时才参与封顶。
  platform_daily_limit: 0,
  // 扫描节奏（防风控节流，2026-10-11 从环境变量常量改为控制台可调）：
  //   keyword_gap_seconds  同城关键词之间的休息秒数
  //   city_gap_seconds     城市之间的休息秒数（0 = 不休息）
  //   card_gap_min/max_ms  卡片之间的随机休息区间（毫秒）
  //   scan_budget_factor   扫描预算系数（单城扫描量 = 每日配额 × 该系数）
  keyword_gap_seconds: 300,
  city_gap_seconds: 600,
  card_gap_min_ms: 3000,
  card_gap_max_ms: 6000,
  scan_budget_factor: 1.3,
  // 单关键词扫描预算（2026-10-15 用户要求，控制台可调）：
  //   max_dom_cards       单个关键词最多**处理**多少张卡片（含被跳过/被点击的），0 = 不限。
  //                       注意不是 DOM 总数：点击卡片会 scrollIntoView → 触发 BOSS 自己追加卡片，
  //                       DOM 会超出任何"加载上限"（2026-10-15 实测 135 → 165），所以按处理量计。
  //   known_streak_limit  连续这么多张卡片都是「已入库岗位」就结束本词扫描，0 = 关闭。
  // 两道闸的理由：已入库岗位在点击前就被跳过、不占 --max-cards 点击额度，所以
  // 「整页都是上次扫过的岗位」时点击上限与产出止损都不会触发，只能靠它们收手。
  max_dom_cards: 135,
  known_streak_limit: 60,
  // JD 完整性门禁（2026-10-14）：true = 抽取时 <180 字或无「岗位职责/任职要求」结构词的岗位直接丢弃，
  // 评分端同样以 JD 完整为可发送前提；false = 关闭该门禁（岗位照常入库评分，jd_detail 仍如实记录原始判定）。
  // 默认 false（用户指令 2026-10-14：门禁默认关，避免误伤大量岗位；控制台勾选「JD完整性过滤」可开启）。
  require_full_jd: false,
  // HR 活跃硬闸（2026-10-16 用户确认）：true = hr_active 以月/半年/年计的岗位被发送预检拦截
  // （stale_hr_active），不入发送队列；false = 关闭（只靠评分压分）。默认 true。
  stale_hr_active_exclude: true,
  // 跳词 / 排除规则（2026-10-14 用户要求统一到控制台，见 skip-rules.mjs 的默认表）：
  //   skip_words      提取阶段命中即丢弃（岗位不入库）
  //   risk_keywords   评分阶段命中只作风险信号，不影响入库
  //   title_exclude   排队阶段标题命中即剔除
  //   company_exclude 排队阶段公司命中即剔除
  // 空数组是合法值 = 该规则不启用；缺省/非数组才回落到默认表。
  skip_words: DEFAULT_SKIP_WORDS,
  risk_keywords: DEFAULT_RISK_KEYWORDS,
  title_exclude: DEFAULT_TITLE_EXCLUDE,
  company_exclude: DEFAULT_COMPANY_EXCLUDE,
  // LLM 招呼语（2026-10-30 用户要求）：score 阶段用 LLM 写打招呼文案，
  // base url / 模型 / 协议（chat·responses·messages）/ key 全部由控制台配置，
  // 与其它操作配置同存这一行（唯一基准）。归一逻辑见 boss-llm.mjs 的 normalizeLlmFields()。
  ...LLM_FALLBACK,
};

function numOr(v, fallback, min) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// 归一化配置行（导出供测试直接验证缺省/0 值语义，不需要连库）。
export function normalize(v = {}) {
  const out = {
    send_threshold: Number(v.send_threshold) > 0 ? Number(v.send_threshold) : FALLBACK.send_threshold,
    daily_limit_per_city:
      v.daily_limit_per_city && typeof v.daily_limit_per_city === 'object'
        ? v.daily_limit_per_city
        : FALLBACK.daily_limit_per_city,
    daily_extract_queries: Array.isArray(v.daily_extract_queries) ? v.daily_extract_queries : [],
    daily_extract_keywords_by_city:
      v.daily_extract_keywords_by_city && typeof v.daily_extract_keywords_by_city === 'object'
        ? v.daily_extract_keywords_by_city
        : {},
    platform_daily_limit:
      Number.isFinite(Number(v.platform_daily_limit)) && Number(v.platform_daily_limit) > 0
        ? Number(v.platform_daily_limit)
        : 0,
    keyword_gap_seconds: numOr(v.keyword_gap_seconds, FALLBACK.keyword_gap_seconds, 0),
    city_gap_seconds: numOr(v.city_gap_seconds, FALLBACK.city_gap_seconds, 0),
    card_gap_min_ms: numOr(v.card_gap_min_ms, FALLBACK.card_gap_min_ms, 200),
    card_gap_max_ms: numOr(v.card_gap_max_ms, FALLBACK.card_gap_max_ms, 200),
    scan_budget_factor: numOr(v.scan_budget_factor, FALLBACK.scan_budget_factor, 1),
    // 单关键词扫描预算：0 是合法值（= 不限 / 关闭），非法值才回落默认
    max_dom_cards: numOr(v.max_dom_cards, FALLBACK.max_dom_cards, 0),
    known_streak_limit: numOr(v.known_streak_limit, FALLBACK.known_streak_limit, 0),
    // 仅显式 true 才开启（缺省/非法值一律视为 false，门禁默认关）
    require_full_jd: v.require_full_jd === true ? true : false,
    // HR 活跃硬闸：与 require_full_jd 相反，默认开（缺省/非法值视为 true）；
    // 仅显式 false 才关闭（发送端 fail-closed，配置读不到也不会漏发）
    stale_hr_active_exclude: v.stale_hr_active_exclude === false ? false : true,
    // 跳词/排除规则：数组或「逗号/换行分隔的字符串」都接受；显式空数组 = 该规则不启用
    skip_words: resolveWordList(v.skip_words, FALLBACK.skip_words),
    risk_keywords: resolveWordList(v.risk_keywords, FALLBACK.risk_keywords),
    title_exclude: resolveWordList(v.title_exclude, FALLBACK.title_exclude),
    company_exclude: resolveWordList(v.company_exclude, FALLBACK.company_exclude),
    // LLM 招呼语配置（协议白名单 / base url 必须是 http(s) / 数值区间都在 normalizeLlmFields 里兜底）
    ...normalizeLlmFields(v),
  };
  if (out.card_gap_max_ms < out.card_gap_min_ms) out.card_gap_max_ms = out.card_gap_min_ms;
  return out;
}

// boss_config 表由 pg-schema.mjs 的 ensureSchema() 统一建好（幂等）。

// 读取配置。PostgreSQL 是唯一来源：没行就写入默认行（不再从 profile 迁移）；
// 连库失败直接抛错 —— 绝不静默回落到过期的 profile.yml 副本。
export async function loadBossControl() {
  try {
    await ensureSchema();
    const [rows] = await query('SELECT value FROM boss_config WHERE name = ?', [CONFIG_ROW]);
    if (rows.length && rows[0].value) {
      const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      return normalize(v);
    }
    const defaults = normalize({});
    await query(
      `INSERT INTO boss_config (name, value, updated_at) VALUES (?, ?, now())
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [CONFIG_ROW, JSON.stringify(defaults)],
    );
    return defaults;
  } catch (e) {
    throw new Error(
      `[boss] 读取 PostgreSQL 配置失败（表 boss_config）：${e.message}。` +
        '操作配置以 PostgreSQL 为唯一基准，不再回落 config/profile.yml；请检查 PGHOST / PGUSER / PGPASSWORD / PGDATABASE 以及库是否可用。',
    );
  }
}

// 写入配置。partial 与当前值合并后整行覆盖写回。DB 不可用时抛出，由调用方上报错误。
export async function saveBossControl(partial = {}) {
  const cur = await loadBossControl();
  const merged = { ...cur, ...partial };
  const value = normalize(merged);
  await query(
    `INSERT INTO boss_config (name, value, updated_at) VALUES (?, ?, now())
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CONFIG_ROW, JSON.stringify(value)],
  );
  return value;
}
