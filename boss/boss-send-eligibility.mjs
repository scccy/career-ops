// Shared local preflight used by the BOSS console and the actual send CLI.
// BOSS may still change a posting's live state after this snapshot is computed.
import {
  countSentCompaniesToday,
  countSentCompaniesTodayByCity,
  loadSentKeys,
  uniqueCompanyPlacementKey,
  uniqueJobKey,
} from './boss-common.mjs';
import { buildWordRegex, DEFAULT_TITLE_EXCLUDE } from './skip-rules.mjs';

export const RECENT_CONTACT_DEDUPE_DAYS = 30;

// HR 活跃时间硬闸（2026-10-16 用户确认）：hr_active 以「月/年」计（如「2月内活跃」「半年活跃」「1年内活跃」）
// 或「半年/几月/数月」的岗位，绝不出现在发送候选里——HR 长期没看过这个岗位，打招呼大概率石沉大海，
// 还白占当日配额。评分端早就把 周/月/年 压分（hrActivity=1.5 + 机会可信度 -0.7），但压分不是拦截，
// 阈值调整或分数刚好过线时仍会发出去；这里与「标题排除」同一层硬闸，任何路径都拦得住。
//
// 判定正则与控制台检索区「最近一个月内」档的排除语义保持一致（skip 见 tests/boss-hr-active-filter.test.mjs）：
//   命中 = 月/半年/年计的长期未活跃；hr_active 为空（未提取到）不拦——不能因解析缺失误伤正常岗位。
const STALE_HR_ACTIVE_RE = /[2-9]月|半年|几月|数月|年/;

// 传 undefined/null = 启用（fail-closed）；传 false = 显式关闭（控制台开关）。
export function isStaleHrActive(hrActive, { staleHrActiveExclude } = {}) {
  if (staleHrActiveExclude === false) return false;
  const text = String(hrActive || '');
  return Boolean(text) && STALE_HR_ACTIVE_RE.test(text);
}

// 标题排除（校招/应届/实习/秋招/春招/毕业生）在发送预检上的硬闸，2026-10-15 用户要求。
//
// 为什么要有这一层：提取阶段的过滤只管"以后新扫的"，而池子里已经有存量（历史扫描、手工导入、
// 别的路径进来的），发送日志里 2026-09-20 ~ 10-14 实际发出过 24 条校招/实习岗（其中 10-14 那天
// 4 条）。人工点「一键剔除校招」只是把当时池子里的行标了暂缓，忘点就会漏——所以把同一份词表
// 放到发送预检这个唯一收口上，任何路径都拦得住。
//
// 传 undefined/null = 用内置默认词表（fail-closed，配置读不到也不会漏发）；传 [] = 显式关闭。
const NEVER_MATCH_RE = /(?!)/;

export function buildTitleExcludeRegex(titleExclude) {
  if (titleExclude === undefined || titleExclude === null) {
    return buildWordRegex(DEFAULT_TITLE_EXCLUDE) || NEVER_MATCH_RE;
  }
  return buildWordRegex(titleExclude) || NEVER_MATCH_RE;
}

export async function readSendHistory(urlCity = new Map()) {
  return {
    // 30 天去重只剩岗位级（公司+岗位+base城市）。公司级 30 天去重已在 2026-10-23 取消：
    // 同一家公司的不同部门/子项目是不同的机会，公司层拉黑会把它们一起挡掉。
    sentJobs: await loadSentKeys({ lookbackDays: RECENT_CONTACT_DEDUPE_DAYS }),
    todaySent: await countSentCompaniesToday(),
    todayByCity: await countSentCompaniesTodayByCity({ urlCity }),
  };
}

// 无发送历史时的空快照（纯函数调用方/测试可直接用；生产路径必须传入真实 history）。
export const EMPTY_HISTORY = { sentJobs: new Set(), todaySent: 0, todayByCity: {} };

function rowKey(job) {
  return String(job.key_hash || uniqueJobKey(job));
}

function scoreNumber(job) {
  const raw = job.score;
  const n = typeof raw === 'number' ? raw : (String(raw ?? '').trim() ? Number(raw) : NaN);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Selects the exact deterministic local batch for a send attempt.
 * Returns blocked reason codes for every rejected row so the console can show
 * the same status as the queue builder instead of approximating from score.
 */
export function selectSendableJobs(candidates, {
  threshold,
  limit = 20,
  limitIsExplicit = false,
  cityLimits = null,
  platformLimit = 0,
  urlCity = new Map(),
  history = null,
  titleExclude = null,
  staleHrActiveExclude = true,
} = {}) {
  const source = Array.isArray(candidates) ? candidates : [];
  const sendHistory = history || EMPTY_HISTORY;
  const titleExcludeRe = buildTitleExcludeRegex(titleExclude);
  const cityRemaining = new Map(Object.entries(cityLimits || {}).map(([city, cap]) => [
    city,
    Math.max(0, Number(cap) - (sendHistory.todayByCity[city] || 0)),
  ]));
  const perCityTotal = [...cityRemaining.values()].reduce((sum, count) => sum + count, 0);
  const globalRemaining = Math.max(0, Number(limit) - sendHistory.todaySent);
  let remainingToday = cityLimits
    ? (limitIsExplicit ? Math.min(globalRemaining, perCityTotal) : perCityTotal)
    : globalRemaining;
  if (Number(platformLimit) > 0) {
    remainingToday = Math.min(remainingToday, Math.max(0, Number(platformLimit) - sendHistory.todaySent));
  }

  const sorted = source.slice().sort((a, b) => {
    const delta = (Number.isFinite(scoreNumber(b)) ? scoreNumber(b) : -Infinity)
      - (Number.isFinite(scoreNumber(a)) ? scoreNumber(a) : -Infinity);
    return delta || String(a.key_hash || uniqueJobKey(a)).localeCompare(String(b.key_hash || uniqueJobKey(b)));
  });
  const selected = [];
  const selectedKeys = new Set();
  const reasonsByKey = {};
  const stats = {
    total: source.length,
    missingScore: 0,
    belowThreshold: 0,
    closed: 0,
    alreadyContacted: 0,
    manuallyExcluded: 0,
    titleExcluded: 0,
    staleHrActive: 0,
    alreadySent: 0,
    duplicateCompanyInBatch: 0,
    cityQuota: 0,
    dailyLimit: 0,
    unconfiguredCity: 0,
    selected: 0,
  };
  const markBlocked = (job, reason, stat) => {
    reasonsByKey[rowKey(job)] = reason;
    if (stat) stats[stat]++;
  };
  const seenCompanies = new Set();
  const remaining = new Map(cityRemaining);

  for (const job of sorted) {
    const key = rowKey(job);
    if (job.manualExcluded || job.manual_excluded) { markBlocked(job, 'manual_excluded', 'manuallyExcluded'); continue; }
    // 标题排除：与 manual_excluded 同级的硬闸（校招/应届/实习…绝不出现在发送候选里）。
    // 放在 manual_excluded 之后：两者都命中时报「人工暂缓」——用户显式标记是更强的信号，
    // 自动规则不该覆盖它（存量的校招岗多数已被一键剔除标过 manual_excluded）。
    if (titleExcludeRe.test(String(job.title || ''))) { markBlocked(job, 'title_excluded', 'titleExcluded'); continue; }
    // HR 活跃硬闸（2026-10-16）：hr_active 以月/半年/年计的岗位不入发送候选。
    // 放在标题排除之后：同层硬闸，两者都命中时标题排除优先报（与控制台同一词序）。
    if (isStaleHrActive(job.hr_active, { staleHrActiveExclude })) {
      markBlocked(job, 'stale_hr_active', 'staleHrActive'); continue;
    }
    if (String(job.availability || '').toLowerCase() === 'closed' || String(job.status || '').toLowerCase() === 'closed') {
      markBlocked(job, 'closed', 'closed'); continue;
    }
    const contact = String(job.contactState || job.contact_state || '');
    if (job.greeted || ['custom_sent', 'auto_greeted_unverified', 'manual_contact_confirmed', 'legacy_contact_unknown'].includes(contact)) {
      markBlocked(job, 'already_contacted', 'alreadyContacted'); continue;
    }
    const score = scoreNumber(job);
    if (!Number.isFinite(score)) { markBlocked(job, 'missing_score', 'missingScore'); continue; }
    if (Number.isFinite(Number(threshold)) && score < Number(threshold)) { markBlocked(job, 'below_threshold', 'belowThreshold'); continue; }
    const role = uniqueJobKey(job);
    // 无 city 列的历史日志行由 loadSentKeys 统一归入 unknown 城市位（见 uniqueJobKeyUnknown），
    // 这里只需比对岗位键：城市未知的岗位键同样是 ::unknown，跨城岗位自然不撞。
    const companyPlacement = uniqueCompanyPlacementKey(job);
    if (sendHistory.sentJobs.has(role)) {
      markBlocked(job, 'recent_role', 'alreadySent'); continue;
    }
    // 批次上限：同一批次里一家公司最多一条（同公司其他岗位下一轮还能进）。
    if (seenCompanies.has(companyPlacement)) {
      markBlocked(job, 'duplicate_company_in_batch', 'duplicateCompanyInBatch'); continue;
    }
    const city = String(job.city || '').split('·')[0];
    if (cityLimits && !remaining.has(city)) { markBlocked(job, 'city_not_configured', 'unconfiguredCity'); continue; }
    if (remaining.has(city)) {
      if (remaining.get(city) <= 0) { markBlocked(job, 'city_quota', 'cityQuota'); continue; }
    }
    if (selected.length >= remainingToday) { markBlocked(job, 'daily_limit', 'dailyLimit'); continue; }
    if (remaining.has(city)) remaining.set(city, remaining.get(city) - 1);
    seenCompanies.add(companyPlacement);
    selected.push(job);
    selectedKeys.add(key);
    reasonsByKey[key] = 'sendable';
  }

  stats.selected = selected.length;
  return {
    jobs: selected,
    selectedKeys,
    reasonsByKey,
    sentToday: sendHistory.todaySent,
    sentTodayByCity: sendHistory.todayByCity,
    remainingToday,
    cityRemaining: Object.fromEntries(cityRemaining),
    cityRemainingAfterSelection: Object.fromEntries(remaining),
    stats,
  };
}
