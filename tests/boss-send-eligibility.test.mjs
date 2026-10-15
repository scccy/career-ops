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
import { selectSendableJobs, buildTitleExcludeRegex } from '../boss/boss-send-eligibility.mjs';

// 发送历史用合成值：不读真实 data/boss-sent-log.tsv，否则结果会随用户当天发过什么而变
const EMPTY_HISTORY = { sentJobs: new Set(), sentCompanies: new Set(), todaySent: 0, todayByCity: {} };
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
