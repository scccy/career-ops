// tests/boss-send-eligibility.test.mjs — 发送预检的「标题排除」硬闸（2026-10-15）
//
// 背景：校招/应届/实习岗以前只靠两件事拦——排队阶段的 boss-filter-queue.mjs（写完就没被任何
// 地方调用）+ 人工点一下「一键剔除校招」。结果是发送日志里 2026-09-20 ~ 10-14 真发出过 24 条
// 校招/实习岗（10-14 那天 4 条，其中 14 条 greeted=1）。现在把控制台同一份词表放到发送预检
// 这个唯一收口上：无论岗位是怎么进的池子（历史扫描、手工导入、别的路径），都进不了发送候选。
//
// Run: node test-all.mjs --only boss-send-eligibility
//      node --test tests/boss-send-eligibility.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSendableJobs, buildTitleExcludeRegex, isStaleHrActive } from '../boss/boss-send-eligibility.mjs';
import { uniqueJobKey, uniqueJobKeyUnknown, urlPathname } from '../boss/boss-common.mjs';

// 发送历史用合成值：不读真实 data/boss-sent-log.tsv，否则结果会随用户当天发过什么而变。
// 2026-10-23 起 readSendHistory 只返回 sentJobs（岗位级），不再有 sentCompanies。
const EMPTY_HISTORY = { sentJobs: new Set(), todaySent: 0, todayByCity: {} };
const CAMPUS_WORDS = ['校招', '应届', '实习', '秋招', '春招', '毕业生'];

const baseJob = (over = {}) => ({
  key_hash: 'k1',
  company: '某公司',
  title: '高级数据开发工程师',
  city: '上海·浦东新区·陆家嘴',
  score: 4.2,
  greeted: false,
  contactState: 'never_contacted',
  ...over,
});

test('标题排除硬闸：校招/实习岗被拦，同批次正常岗位照常入选', () => {
  const campus = baseJob({ key_hash: 'k-campus', company: '氦川科技', title: '数据开发（校招）' });
  const intern = baseJob({ key_hash: 'k-intern', company: '安势信息', title: '大数据开发实习生' });
  const normal = baseJob({ key_hash: 'k-normal', company: '正常公司', title: '高级数据开发工程师' });

  const sel = selectSendableJobs([campus, intern, normal], {
    threshold: 3,
    history: EMPTY_HISTORY,
    titleExclude: CAMPUS_WORDS,
  });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-normal'], '只应有正常岗位入选');
  assert.equal(sel.reasonsByKey['k-campus'], 'title_excluded');
  assert.equal(sel.reasonsByKey['k-intern'], 'title_excluded');
  assert.equal(sel.reasonsByKey['k-normal'], 'sendable');
  assert.equal(sel.stats.titleExcluded, 2, '统计里要能看到被标题排除的条数');
});

test('标题排除硬闸：不传词表 = 用内置默认（fail-closed）；传空数组 = 显式关闭', () => {
  const campus = baseJob({ key_hash: 'k-campus', title: '数据开发（校招）' });

  const fallback = selectSendableJobs([campus], { threshold: 3, history: EMPTY_HISTORY });
  assert.equal(fallback.jobs.length, 0, '调用方忘了传词表时也必须拦住（不能 fail-open）');
  assert.equal(fallback.reasonsByKey['k-campus'], 'title_excluded');

  const off = selectSendableJobs([campus], { threshold: 3, history: EMPTY_HISTORY, titleExclude: [] });
  assert.deepEqual(off.jobs.map((j) => j.key_hash), ['k-campus'], '空数组 = 该规则不启用');
  assert.equal(off.stats.titleExcluded, 0);
});

test('标题排除硬闸：与 manual_excluded 同时命中时归 manual_excluded（人工动作是更强信号）', () => {
  const both = baseJob({ key_hash: 'k-both', title: '数据开发实习生', manualExcluded: true });
  const manualOnly = baseJob({ key_hash: 'k-manual', title: '高级数据开发工程师', manualExcluded: true });
  const titleOnly = baseJob({ key_hash: 'k-title', title: '数据开发实习生' });

  const sel = selectSendableJobs([both, manualOnly, titleOnly], { threshold: 3, history: EMPTY_HISTORY, titleExclude: ['实习'] });

  assert.equal(sel.reasonsByKey['k-both'], 'manual_excluded', '人工暂缓优先，不被自动规则覆盖');
  assert.equal(sel.reasonsByKey['k-manual'], 'manual_excluded');
  assert.equal(sel.reasonsByKey['k-title'], 'title_excluded');
  assert.equal(sel.stats.titleExcluded, 1, '标题排除只数「没被人工暂缓」的那条');
  assert.equal(sel.stats.manuallyExcluded, 2);
});

test('标题排除硬闸：控制台自定义词表生效，未命中不受影响', () => {
  assert.ok(buildTitleExcludeRegex(['外包']).test('数据开发工程师（外包）'));
  assert.ok(!buildTitleExcludeRegex(['外包']).test('数据开发工程师'));
  // 不传 = 内置默认表（含校招/实习），传空 = 永不匹配
  assert.ok(buildTitleExcludeRegex(undefined).test('数据工程实习生'));
  assert.ok(!buildTitleExcludeRegex([]).test('数据工程实习生'));

  const j = baseJob({ key_hash: 'k-out', title: '数据开发工程师（外包）' });
  const sel = selectSendableJobs([j], { threshold: 3, history: EMPTY_HISTORY, titleExclude: ['外包'] });
  assert.equal(sel.jobs.length, 0);
  assert.equal(sel.reasonsByKey['k-out'], 'title_excluded');
});

test('标题排除硬闸：正常岗位的其余预检行为不受影响', () => {
  const belowThreshold = baseJob({ key_hash: 'k-low', score: 2.0 });
  const missingScore = baseJob({ key_hash: 'k-null', score: null });
  const closed = baseJob({ key_hash: 'k-closed', availability: 'closed' });
  const greeted = baseJob({ key_hash: 'k-greeted', greeted: true });
  const ok = baseJob({ key_hash: 'k-ok' });

  const sel = selectSendableJobs([belowThreshold, missingScore, closed, greeted, ok], {
    threshold: 3,
    history: EMPTY_HISTORY,
    titleExclude: CAMPUS_WORDS,
  });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-ok']);
  assert.equal(sel.reasonsByKey['k-low'], 'below_threshold');
  assert.equal(sel.reasonsByKey['k-null'], 'missing_score');
  assert.equal(sel.reasonsByKey['k-closed'], 'closed');
  assert.equal(sel.reasonsByKey['k-greeted'], 'already_contacted');
  assert.equal(sel.stats.titleExcluded, 0, '这些都不是标题排除，不能算进 titleExcluded');
});

// ── HR 活跃硬闸（2026-10-16 用户确认）────────────────────────────────────────
// hr_active 以月/半年/年计的岗位（如「2月内活跃」「半年活跃」「1年内活跃」）绝不出现在发送候选，
// 否则打招呼会带上长期未活跃的岗位、白占当日配额。评分端压分不是拦截，这里是同一层的硬闸。
test('HR活跃硬闸：月/半年/年计的岗位被拦，近期/空值正常入选', () => {
  const stale2m = baseJob({ key_hash: 'k-2m', company: '甲公司', hr_active: '2月内活跃' });
  const stale6m = baseJob({ key_hash: 'k-6m', company: '乙公司', hr_active: '半年内活跃' });
  const stale1y = baseJob({ key_hash: 'k-1y', company: '丙公司', hr_active: '1年内活跃' });
  const fresh = baseJob({ key_hash: 'k-fresh', company: '丁公司', hr_active: '今日活跃' });
  const thisWeek = baseJob({ key_hash: 'k-week', company: '戊公司', hr_active: '本周活跃' });
  const unknown = baseJob({ key_hash: 'k-unknown', company: '己公司' }); // 未提取到 hr_active：不能误伤

  const sel = selectSendableJobs([stale2m, stale6m, stale1y, fresh, thisWeek, unknown], {
    threshold: 3,
    history: EMPTY_HISTORY,
  });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-fresh', 'k-unknown', 'k-week'], '只应入选近期与未提取到的岗位（同分按 key_hash 排序）');
  for (const [key, stat] of [['k-2m', 'stale2m'], ['k-6m', 'stale6m'], ['k-1y', 'stale1y']]) {
    assert.equal(sel.reasonsByKey[key], 'stale_hr_active');
  }
  assert.equal(sel.stats.staleHrActive, 3, '统计里要能看到被 HR活跃硬闸拦下的条数');
});

test('HR活跃硬闸：不传开关 = 默认启用（fail-closed）；显式 false = 关闭', () => {
  const stale = baseJob({ key_hash: 'k-stale', hr_active: '3月内活跃' });

  // 缺省即拦——调用方忘了传配置时也不能漏发
  const fallback = selectSendableJobs([stale], { threshold: 3, history: EMPTY_HISTORY });
  assert.equal(fallback.jobs.length, 0);
  assert.equal(fallback.reasonsByKey['k-stale'], 'stale_hr_active');

  // isStaleHrActive 单元行为：undefined/null = 启用；false = 关闭
  assert.equal(isStaleHrActive('2月内活跃'), true);
  assert.equal(isStaleHrActive('2月内活跃', {}), true);
  assert.equal(isStaleHrActive('2月内活跃', { staleHrActiveExclude: false }), false);
  assert.equal(isStaleHrActive('', {}), false, '空值不拦（不能因解析缺失误伤）');
  assert.equal(isStaleHrActive(undefined, {}), false);

  // 显式关闭：岗位照常可发送
  const off = selectSendableJobs([stale], { threshold: 3, history: EMPTY_HISTORY, staleHrActiveExclude: false });
  assert.deepEqual(off.jobs.map((j) => j.key_hash), ['k-stale'], '显式 false = 该闸关闭');
});

test('HR活跃硬闸：与人工暂缓/标题排除的优先级——人工暂缓 > 标题排除 > HR活跃', () => {
  const bothTitleAndStale = baseJob({ key_hash: 'k-both', company: '庚公司', title: '数据开发实习生', hr_active: '2月内活跃' });
  const manualAndStale = baseJob({ key_hash: 'k-manual', company: '辛公司', hr_active: '2月内活跃', manualExcluded: true });

  const sel = selectSendableJobs([bothTitleAndStale, manualAndStale], {
    threshold: 3,
    history: EMPTY_HISTORY,
    titleExclude: ['实习'],
  });

  assert.equal(sel.reasonsByKey['k-both'], 'title_excluded', '标题排除优先报（与控制台词序一致）');
  assert.equal(sel.reasonsByKey['k-manual'], 'manual_excluded', '人工暂缓是更强信号，不被自动规则覆盖');
  assert.equal(sel.stats.staleHrActive, 0, '两个都归了更高优先级，不重复计数');
});

// ── 去重口径（2026-10-23 用户确认）──────────────────────────────────────────
// 30 天去重只剩岗位级：键 = 公司 + 岗位 + base 城市。
// 公司级 30 天去重取消的理由（用户原话）：公司有不同部门、不同子项目，同一个岗位在不同城市也很正常。
// 触发这次修改的真实故障：厦门首次跑批时 7 条被报「30天内同公司已发」，其中 5 条是同城刚发过的
// 同公司另一个岗位，2 条是 2026-09-23 那些没有 city 列的历史日志行把公司级键注成了"全城通杀"。
const roleHistory = (jobs) => ({
  sentJobs: new Set(jobs.map((j) => uniqueJobKey(j))),
  todaySent: 0,
  todayByCity: {},
});

test('去重口径：同公司同城不同岗位允许（公司级 30 天去重已取消）', () => {
  const earlier = baseJob({ key_hash: 'k-earlier', company: '微创网络', title: '数据开发工程师-斐乐驻场', city: '厦门·思明区·莲前' });
  const later = baseJob({ key_hash: 'k-later', company: '微创网络', title: '数仓开发（AI）', city: '厦门·思明区·莲前' });

  const sel = selectSendableJobs([later], { threshold: 3, history: roleHistory([earlier]) });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-later'], '同公司另一个岗位不该被上一条拦住');
  assert.equal(sel.reasonsByKey['k-later'], 'sendable');
});

test('去重口径：同公司同城同一岗位仍在 30 天内被拦', () => {
  const same = baseJob({ key_hash: 'k-same', company: '微创网络', title: '数仓开发（AI）', city: '厦门·思明区·莲前' });
  const sel = selectSendableJobs([same], { threshold: 3, history: roleHistory([same]) });

  assert.equal(sel.jobs.length, 0);
  assert.equal(sel.reasonsByKey['k-same'], 'recent_role');
  assert.equal(sel.stats.alreadySent, 1);
});

test('去重口径：同岗位跨城市互不干扰（岗位身份含 base 城市）', () => {
  const shanghai = baseJob({ key_hash: 'k-sh', company: '博彦科技', title: '数据开发工程师', city: '上海·浦东新区·世博' });
  const xiamen = baseJob({ key_hash: 'k-xm', company: '博彦科技', title: '数据开发工程师', city: '厦门·思明区·莲前' });

  const sel = selectSendableJobs([xiamen], { threshold: 3, history: roleHistory([shanghai]) });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-xm']);
  assert.equal(sel.reasonsByKey['k-xm'], 'sendable');
});

test('去重口径：无 city 的历史日志行只拦「城市未知」的同岗位，不跨城误杀', () => {
  // 模拟 2026-10-01 之前没有 city 列的日志行：城市位固定 unknown
  const legacy = uniqueJobKeyUnknown({ company: '博彦科技', title: '数据开发工程师-etl' });
  const history = { sentJobs: new Set([legacy]), todaySent: 0, todayByCity: {} };

  const otherCity = baseJob({ key_hash: 'k-xm', company: '博彦科技', title: '数据开发工程师-etl', city: '厦门·思明区·莲前' });
  const unknownCity = baseJob({ key_hash: 'k-unknown', company: '博彦科技', title: '数据开发工程师-etl', city: '' });

  const sel = selectSendableJobs([otherCity, unknownCity], { threshold: 3, history });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-xm'], '跨城不再被历史日志行误杀');
  assert.equal(sel.reasonsByKey['k-unknown'], 'recent_role', '城市未知的同岗位仍按旧日志拦住（同一岗位的旧记录不该被当成没发过）');
});

test('去重口径：批次内一家公司只出一条，另一条报 duplicate_company_in_batch（下一轮可再发）', () => {
  const top = baseJob({ key_hash: 'k-a', company: '万辰集团', title: '数据仓库开发工程师', score: 4.5, city: '南京·秦淮区·红花' });
  const second = baseJob({ key_hash: 'k-b', company: '万辰集团', title: 'Java高级开发工程师', score: 4.4, city: '南京·秦淮区·红花' });

  const sel = selectSendableJobs([top, second], { threshold: 3, history: EMPTY_HISTORY });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-a'], '同批次内只取最高分那条');
  assert.equal(sel.reasonsByKey['k-b'], 'duplicate_company_in_batch');
  assert.equal(sel.stats.duplicateCompanyInBatch, 1);
  assert.equal(sel.stats.alreadySent, 0, '批次上限不是 30 天去重，不能记到 alreadySent');
});

// ── 岗位身份 = 岗位名称 + 公司 + base 城市（2026-10 用户要求，不再含 URL）──────────
// 键 = 岗位名称 :: 公司 :: base城市（normalizeText 后；base 城市取第一段）。
// URL / securityId 不参与身份：同公司同标题同城的多个 job id 视为同一岗位。
test('岗位身份：键 = 岗位名称::公司::base城市，URL/securityId 不参与', () => {
  const base = { company: '博彦科技', title: '数据开发工程师', city: '杭州·滨江区·长河' };
  const k1 = uniqueJobKey({ ...base, url: 'https://www.zhipin.com/job_detail/aaa111.html?securityId=X1' });
  const k2 = uniqueJobKey({ ...base, url: 'https://www.zhipin.com/job_detail/aaa111.html?securityId=Z9' });
  const k3 = uniqueJobKey({ ...base, url: '/job_detail/bbb222.html?securityId=Y2' });
  assert.equal(k1, k2, '重扫换 securityId 不影响身份');
  assert.equal(k1, k3, 'URL 不参与身份：同标题同公司同城一律同键');
  assert.equal(k1, '数据开发工程师::博彦科技::杭州');
});

test('岗位身份：同公司同标题同城的不同 job id 视为同一岗位（再发会被 30 天去重拦住）', () => {
  const sent = baseJob({
    key_hash: 'k-sent', company: '博彦科技', title: '数据开发工程师', city: '杭州·滨江区·长河',
    url: 'https://www.zhipin.com/job_detail/aaa111.html?securityId=X1',
  });
  const other = baseJob({
    key_hash: 'k-other', company: '博彦科技', title: '数据开发工程师', city: '杭州·滨江区·长河',
    url: 'https://www.zhipin.com/job_detail/bbb222.html?securityId=Y2',
  });

  const sel = selectSendableJobs([other], { threshold: 3, history: roleHistory([sent]) });

  assert.equal(sel.jobs.length, 0, '同标题同公司同城 = 同一岗位，应被已发拦住');
  assert.equal(sel.reasonsByKey['k-other'], 'recent_role');
});

test('岗位身份：同公司同城不同岗位名仍是不同岗位（不互相拦截）', () => {
  const sent = baseJob({ key_hash: 'k-sent', company: '博彦科技', title: '数据开发工程师', city: '杭州·滨江区·长河' });
  const other = baseJob({ key_hash: 'k-other', company: '博彦科技', title: '数据仓库工程师', city: '杭州·滨江区·长河' });

  const sel = selectSendableJobs([other], { threshold: 3, history: roleHistory([sent]) });

  assert.deepEqual(sel.jobs.map((j) => j.key_hash), ['k-other']);
  assert.equal(sel.reasonsByKey['k-other'], 'sendable');
});

test('岗位身份：URL 有无不影响键（卡片 href 缺失也不会误判为新岗位）', () => {
  const base = { company: '博彦科技', title: '数据开发工程师', city: '杭州·滨江区·长河' };
  assert.equal(uniqueJobKey(base), uniqueJobKey({ ...base, url: '/job_detail/aaa111.html' }));
});

// urlPathname 不再参与岗位身份，但仍用于「按城统计公司数」等场景，保留剥 query 的能力。
test('URL 指纹工具：urlPathname 仍剥掉 securityId query（供城市配额统计使用）', () => {
  assert.equal(urlPathname('/job_detail/aaa111.html?securityId=X1'), '/job_detail/aaa111.html');
  assert.equal(urlPathname('https://www.zhipin.com/job_detail/aaa111.html?securityId=X1'), '/job_detail/aaa111.html');
  assert.equal(urlPathname('/job_detail/aaa111.html#top'), '/job_detail/aaa111.html');
  assert.equal(urlPathname(''), '');
});


// ── 发送用的文案：必须取库里最新的，不能被队列快照的旧文案顶掉（2026-10-30）──────
test('队列快照只能用旧文案兜底，库里有新文案时以库里为准', async () => {
  const { hydrateQueueJob } = await import('../boss/boss-common.mjs');
  const queued = { key_hash: 'k1', greeting: '您好，我关注到岗位主要涉及数仓（老模板）', greetingSource: 'template', score: 3, greeted: false };
  const live = { key_hash: 'k1', greeting: '您好，我有5年+数据仓库经验（新 LLM 文案）', greetingSource: 'llm', greetingModel: 'm', score: 4.5, greeted: true, contactState: 'custom_sent', status: 'open' };
  const out = hydrateQueueJob(queued, live);
  assert.equal(out.greeting, live.greeting, '发送必须用库里的新文案');
  assert.equal(out.greetingSource, 'llm');
  assert.equal(out.greetingModel, 'm');
  assert.equal(out.greeted, true, '已联系状态同样以库里为准');
  assert.equal(out.score, 4.5, '分数以库里为准');

  // 库里查不到这一行（池子被重写/岗位被删）→ 保持队列原样，不炸
  assert.equal(hydrateQueueJob(queued, null).greeting, queued.greeting);
});

test('发送脚本必须走 hydrateQueueJob（防止文案刷新被漏掉）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../boss/boss-chrome-apply.mjs', import.meta.url), 'utf-8');
  assert.match(src, /queue\.map\(\(job\) => hydrateQueueJob\(job, currentByHash\.get\(job\.key_hash\)\)\)/, '整批队列必须用统一函数刷新');
  assert.doesNotMatch(src, /\.\.\.\(Number\.isFinite\(currentScore\) \? \{ score: currentScore \} : \{\}\),\n\s+greeted: Boolean\(current\.greeted\),/, '内联的旧 hydration 必须删掉（它漏了 greeting）');
});

test('发送流水 boss_sent_log 能按 key_hash 回溯岗位', async () => {
  const { readFileSync } = await import('node:fs');
  const common = readFileSync(new URL('../boss/boss-common.mjs', import.meta.url), 'utf-8');
  const schema = readFileSync(new URL('../boss/pg-schema.mjs', import.meta.url), 'utf-8');
  assert.match(common, /INSERT INTO boss_sent_log \(sent_date, sent_time, company, title, url, key_hash, status, message, error, city\)/);
  assert.match(common, /job\.key_hash \|\| null/, '流水要写 key_hash');
  assert.match(schema, /ALTER TABLE boss_sent_log ADD COLUMN IF NOT EXISTS key_hash CHAR\(64\)/, '存量库要幂等补列');
  assert.match(schema, /idx_boss_sent_log_key_hash/, '要能按 key_hash 查流水');
});
