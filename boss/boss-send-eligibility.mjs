// Shared local preflight used by the BOSS console and the actual send CLI.
// BOSS may still change a posting's live state after this snapshot is computed.
import {
  countSentCompaniesToday,
  countSentCompaniesTodayByCity,
  loadSentPlacementKeys,
  loadSentKeys,
  uniqueCompanyKey,
  uniqueCompanyPlacementKey,
  uniqueJobKey,
  uniqueJobKeyLegacy,
} from './boss-common.mjs';

export const RECENT_CONTACT_DEDUPE_DAYS = 30;

export function readSendHistory(urlCity = new Map()) {
  return {
    sentJobs: loadSentKeys({ lookbackDays: RECENT_CONTACT_DEDUPE_DAYS }),
    // 发送去重按公司+base 城市；旧日志无城市时由 loadSentPlacementKeys 返回公司级兼容键。
    sentCompanies: loadSentPlacementKeys({ lookbackDays: RECENT_CONTACT_DEDUPE_DAYS }),
    todaySent: countSentCompaniesToday(),
    todayByCity: countSentCompaniesTodayByCity({ urlCity }),
  };
}

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
} = {}) {
  const source = Array.isArray(candidates) ? candidates : [];
  const sendHistory = history || readSendHistory(urlCity);
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
    alreadySent: 0,
    recentCompany: 0,
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
    const legacyRole = uniqueJobKeyLegacy(job);
    const company = uniqueCompanyKey(job);
    const companyPlacement = uniqueCompanyPlacementKey(job);
    if (sendHistory.sentJobs.has(role) || sendHistory.sentJobs.has(legacyRole)) {
      markBlocked(job, 'recent_role', 'alreadySent'); continue;
    }
    if (sendHistory.sentCompanies.has(companyPlacement) || sendHistory.sentCompanies.has(company)) {
      markBlocked(job, 'recent_company', 'recentCompany'); continue;
    }
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
