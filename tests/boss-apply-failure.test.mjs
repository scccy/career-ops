// tests/boss-apply-failure.test.mjs — 单条岗位失败怎么处理：跳过继续 vs 停批次
//
// 2026-11-18 用户反馈现场：
//   {"company":"软通动力","title":"大数据开发工程师-中行-项目稳定","status":"failed",
//    "error":"未找到“立即沟通”按钮：[]"} … 「未找到沟通按钮应该执行下一个，现在好像是任务都一次性结束了」
// 原因是发送循环对任何非 JOB_CLOSED 的失败都 `break`，一条页面异常的岗位就把整批作废。
//
// 本文件钉住四件事：
//   1. 分级：哪些错误算「这条岗位点不了」（skip，继续下一家），哪些算「整批环境坏了」（fatal，停批次）；
//   2. 断路器：连续 N 条 skip 升级为停止（默认 3），成功一条就清零；
//   3. 发送脚本接线：skip 写 status='skipped'、真正决定停批次的只有 fatal 与断路器；
//   4. skip 不计当日额度、不计 30 天同岗位去重（sent_log 里配额/去重只认 sent / auto_sent）。
//
// Run: node test-all.mjs --only boss-apply-failure

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import {
  applyError,
  classifyApplyFailure,
  createSkipBreaker,
  codeOf,
  resolveMaxConsecutiveSkips,
  summarizeApplyResults,
} from '../boss/boss-apply-failure.mjs';
import { runApplyBatch } from '../boss/boss-apply-loop.mjs';

const applySrc = readFileSync(join(ROOT, 'boss', 'boss-chrome-apply.mjs'), 'utf-8');
const loopSrc = readFileSync(join(ROOT, 'boss', 'boss-apply-loop.mjs'), 'utf-8');
const commonSrc = readFileSync(join(ROOT, 'boss', 'boss-common.mjs'), 'utf-8');

// 用户报告的那次失败，原样复现（旧式纯文本 Error，没有错误码）
const reportedFailure = new Error('未找到“立即沟通”按钮：[]');

test('用户反馈的现场：未找到「立即沟通」按钮 = 岗位级失败，跳过继续下一家', () => {
  const verdict = classifyApplyFailure(reportedFailure);
  assert.equal(verdict.kind, 'skip', '不能因为一条岗位点不了就停整批');
  assert.equal(verdict.code, 'NO_CHAT_BUTTON');
  assert.ok(verdict.reason.includes('沟通按钮'), `reason 要说明为什么跳过：${verdict.reason}`);
});

test('带错误码的同一种失败，分类一致（文案改了口径不变）', () => {
  const err = applyError('NO_CHAT_BUTTON', '随便改了个说法');
  const verdict = classifyApplyFailure(err);
  assert.equal(verdict.kind, 'skip');
  assert.equal(verdict.code, 'NO_CHAT_BUTTON');
});

test('其余岗位级失败都跳过：页面超时/没有输入框/发送按钮不可点/无文案', () => {
  const cases = [
    ['JOB_PAGE_TIMEOUT', '岗位页面加载超时'],
    ['NO_CHAT_INPUT', '岗位页未找到消息输入框'],
    ['FILL_INPUT_FAILED', '未能填入岗位页文案'],
    ['NO_SEND_BUTTON', '岗位页发送按钮未激活'],
    ['CONVERSATION_NOT_FOUND', '消息页未找到“某公司”对应会话'],
    ['MISSING_GREETING', '缺少打招呼文案'],
  ];
  for (const [code, message] of cases) {
    const verdict = classifyApplyFailure(applyError(code, message));
    assert.equal(verdict.kind, 'skip', `${code} 应跳过继续下一家`);
    assert.equal(verdict.code, code);
  }
});

test('点过「立即沟通」但页面无反应 = 状态未知，不能当 skip（可能已自动发出默认招呼）', () => {
  const verdict = classifyApplyFailure(applyError('CLICK_NO_RESPONSE', '点击「立即沟通」3 次均无反应；页面状态={}'));
  assert.equal(verdict.kind, 'fatal', '点过按钮就不能假设「还没发出去」，否则下一轮会重复打招呼');
  assert.equal(verdict.code, 'CLICK_NO_RESPONSE');

  const legacy = classifyApplyFailure(new Error('点击「立即沟通」3 次均无反应；页面状态={}'));
  assert.equal(legacy.kind, 'fatal', '旧式纯文本错误同样按 unknown 处理');
});

test('消息页加载超时单独成型为致命（不是未分类）', () => {
  const verdict = classifyApplyFailure(applyError('MESSAGE_PAGE_TIMEOUT', 'BOSS消息页加载超时'));
  assert.equal(verdict.kind, 'fatal');
  assert.equal(verdict.code, 'MESSAGE_PAGE_TIMEOUT');
  assert.ok(verdict.reason.includes('消息页'), verdict.reason);
});

test('旧式纯文本错误也按文案归到 skip（没有错误码的调用点不会退化成停批次）', () => {
  const samples = [
    ['岗位页面加载超时；页面状态={}', 'JOB_PAGE_TIMEOUT'],
    ['岗位页未找到消息输入框；页面状态={}', 'NO_CHAT_INPUT'],
    ['岗位页发送按钮未激活：[]', 'NO_SEND_BUTTON'],
    ['消息页未找到“某公司”对应会话', 'CONVERSATION_NOT_FOUND'],
  ];
  for (const [message, expected] of samples) {
    const verdict = classifyApplyFailure(new Error(message));
    assert.equal(verdict.code, expected, message);
    assert.equal(verdict.kind, 'skip', message);
  }
});

test('风控/掉登录信号优先于错误码：页面被换掉时不能当岗位级失败放过', () => {
  for (const riskText of ['安全验证', '请登录', '访问过于频繁', '操作过于频繁', '账号异常']) {
    const err = applyError('NO_CHAT_BUTTON', '未找到“立即沟通”按钮；页面状态={}', {
      pageState: { href: 'https://www.zhipin.com/web/user/safe/verify', riskText },
    });
    const verdict = classifyApplyFailure(err);
    assert.equal(verdict.kind, 'fatal', `${riskText} 必须停批次`);
    assert.equal(verdict.code, 'RISK_CONTROL');
  }
});

test('发送未验证仍然是致命：可能已经发出去了，不能继续往下推', () => {
  const verdict = classifyApplyFailure(new Error('点击发送后未在岗位页聊天记录中验证到自定义文案，未记为成功'));
  assert.equal(verdict.kind, 'fatal');
  assert.equal(verdict.code, 'UNVERIFIED_SEND');
});

test('CDP/连接类故障致命', () => {
  const verdict = classifyApplyFailure(new Error('CDP evaluate timeout: websocket closed'));
  assert.equal(verdict.kind, 'fatal');
  assert.equal(verdict.code, 'CDP_DISCONNECTED');
});

test('分类不认识的新错误保持 fail-safe：停批次而不是默默跳过', () => {
  const verdict = classifyApplyFailure(new Error('某个以后新加的、没见过的错误'));
  assert.equal(verdict.kind, 'fatal');
  assert.equal(verdict.code, 'UNKNOWN');
});

test('职位已关闭、BOSS 自动发默认语保持原有语义', () => {
  const closed = classifyApplyFailure(applyError('JOB_CLOSED', '职位已关闭'));
  assert.equal(closed.kind, 'closed');
  const auto = classifyApplyFailure(new Error('AUTO_GREETED: BOSS已自动发送默认打招呼语，但消息页补发自定义话术失败：x'));
  assert.equal(auto.kind, 'auto_sent');
});

test('AUTO_GREETED 包装不能吞掉内层错误码与页面快照：内层是风控墙就停批次', () => {
  const inner = applyError('NO_CHAT_INPUT', '已打开“某公司”会话，但未找到消息输入框', {
    pageState: { href: 'https://www.zhipin.com/web/user/safe/verify', riskText: '请完成验证' },
  });
  const outer = applyError('AUTO_GREETED', 'AUTO_GREETED: BOSS已自动发送默认打招呼语，但消息页补发自定义话术失败：x', {
    pageState: inner.pageState,
    cause: inner,
  });
  const verdict = classifyApplyFailure(outer);
  assert.equal(verdict.kind, 'fatal', '风控墙不能因为外层写了 AUTO_GREETED 就当成「默认语已发」继续点');
  assert.equal(verdict.code, 'RISK_CONTROL');
});

test('登录/注册按钮 = 登录态失效，按风控处理（不能当成岗位级失败跳过）', () => {
  const err = applyError('NO_CHAT_BUTTON', '未找到“立即沟通”按钮；页面状态={}', {
    pageState: { href: 'https://www.zhipin.com/', title: 'BOSS直聘', hasLoginButton: true },
  });
  const verdict = classifyApplyFailure(err);
  assert.equal(verdict.kind, 'fatal');
  assert.equal(verdict.code, 'RISK_CONTROL');
});

test('岗位 JD 里出现「验证码/风控」字样不应误判风控（只看限定范围文本，不扫整页）', () => {
  // capturePageState 只在弹窗/标题/URL 或短页面上填 riskText；JD 正文命中的词不会进 riskText。
  const err = applyError('NO_CHAT_BUTTON', '未找到“立即沟通”按钮；页面状态={}', {
    pageState: {
      href: 'https://www.zhipin.com/job_detail/abc.html',
      title: '风控算法工程师（验证码）-20K',
      bodyHint: '岗位职责：负责验证码识别、风控策略……',
      riskText: '',
      hasLoginButton: false,
    },
  });
  const verdict = classifyApplyFailure(err);
  assert.equal(verdict.kind, 'skip', '一个风控岗的 JD 不该把整批判成风控（复现用户这次投诉的同类后果）');
  assert.equal(verdict.code, 'NO_CHAT_BUTTON');
});

test('codeOf：错误码优先，其次文案归并', () => {
  assert.equal(codeOf(applyError('NO_SEND_BUTTON', 'x')), 'NO_SEND_BUTTON');
  assert.equal(codeOf(new Error('未找到“立即沟通”按钮：[]')), 'NO_CHAT_BUTTON');
  assert.equal(codeOf(new Error('完全看不懂的错误')), 'UNKNOWN');
});

test('断路器：默认连续 3 条岗位级失败才停，成功一条就清零', () => {
  const breaker = createSkipBreaker({ maxConsecutiveSkips: 3 });
  assert.equal(breaker.limit, 3);
  assert.deepEqual(breaker.recordFailure(), { streak: 1, limit: 3, abort: false });
  assert.equal(breaker.recordFailure().abort, false);
  breaker.recordSuccess();
  assert.equal(breaker.streak, 0, '中间成功发出去一条，连续计数必须清零');
  assert.equal(breaker.recordFailure().abort, false);
  assert.equal(breaker.recordFailure().abort, false);
  const third = breaker.recordFailure();
  assert.equal(third.abort, true, '连续 3 条都失败 = 环境有问题，停批次');
  assert.equal(third.streak, 3);
});

test('断路器：--stop-on-first-failure 等价上限 1；0 表示永不因连续失败停止', () => {
  const strict = createSkipBreaker({ maxConsecutiveSkips: 1 });
  assert.equal(strict.recordFailure().abort, true);

  const off = createSkipBreaker({ maxConsecutiveSkips: 0 });
  let last = null;
  for (let i = 0; i < 10; i++) last = off.recordFailure();
  assert.equal(last.abort, false, '0 = 不因连续失败停批次（由用户显式选择）');
});

test('参数解析：默认 3 / 显式取值 / 0 关闭 / 冲突以 --stop-on-first-failure 为准', () => {
  assert.deepEqual(resolveMaxConsecutiveSkips({}), { maxConsecutiveSkips: 3, notes: [] });
  assert.equal(resolveMaxConsecutiveSkips({ 'max-consecutive-failures': '5' }).maxConsecutiveSkips, 5);
  assert.equal(resolveMaxConsecutiveSkips({ 'max-consecutive-failures': '0' }).maxConsecutiveSkips, 0);
  assert.equal(resolveMaxConsecutiveSkips({ 'stop-on-first-failure': true }).maxConsecutiveSkips, 1);
  const both = resolveMaxConsecutiveSkips({ 'stop-on-first-failure': true, 'max-consecutive-failures': '9' });
  assert.equal(both.maxConsecutiveSkips, 1);
  assert.equal(both.notes.length, 1, '两个参数同时给要提醒一句，而不是悄悄选一个');
});

test('参数解析：缺取值/非法取值直接报错', () => {
  assert.throws(() => resolveMaxConsecutiveSkips({ 'max-consecutive-failures': true }), /缺少取值/);
  for (const bad of ['abc', '-1', '3.5', '']) {
    assert.throws(() => resolveMaxConsecutiveSkips({ 'max-consecutive-failures': bad }), /非负整数/, bad);
  }
});

test('发送循环接线：只有 fatal 和断路器会 break，skip 必须 continue', () => {
  assert.doesNotMatch(applySrc, /if \(!closed\) break;/, '旧的「非 closed 就 break」必须删掉');
  assert.match(applySrc, /await runApplyBatch\(/, '发送脚本必须走可测试的统一循环');
  assert.match(applySrc, /maxConsecutiveSkips/, '断路器上限必须从参数传入');
  assert.match(applySrc, /status: 'skipped'/, 'skip 要落 sent_log（status=skipped）留痕');
  assert.match(loopSrc, /classifyApplyFailure\(err\)/, '循环必须按分级判定，而不是只看 JOB_CLOSED 前缀');
  assert.match(loopSrc, /verdict\.kind === 'skip'/, '必须有 skip 分支');
  assert.match(loopSrc, /if \(streak\.abort\)/, '连续失败达上限必须停批次');
  assert.match(loopSrc, /abortInfo/, '停批次原因要随结果输出，用户才知道为什么只发了几家');
});

test('skip 不计当日额度、不计 30 天同岗位去重', () => {
  // 配额与去重都只认 sent / auto_sent —— skipped 天然被排除在外。
  assert.match(
    commonSrc,
    /export async function loadSentKeys\(\{[^}]*statuses = \['sent'\]/s,
    'loadSentKeys 默认只认 sent：skipped 不进 30 天同岗位去重',
  );
  assert.match(
    commonSrc,
    /statuses = \['sent', 'auto_sent'\]/,
    '公司级配额只认 sent / auto_sent：skipped 不占当日额度',
  );
});

test('汇总：sent / skipped / failed / closed 分开计数', () => {
  const counts = summarizeApplyResults([
    { status: 'sent' },
    { status: 'skipped' },
    { status: 'skipped' },
    { status: 'closed' },
    { status: 'auto_sent' },
    { status: 'failed' },
    { status: 'unknown-status' },
  ]);
  assert.deepEqual(counts, { sent: 1, auto_sent: 1, closed: 1, skipped: 2, failed: 1 });
});

// ===== 整批控制流（runApplyBatch）：用假 send 驱动，不需要 Chrome/数据库 =====

const makeJob = (n, extra = {}) => ({
  key_hash: `h${n}`,
  company: `公司${n}`,
  title: `岗位${n}`,
  city: '上海',
  url: `https://www.zhipin.com/job_detail/${n}.html`,
  greeting: '你好，我看到这个岗位……',
  ...extra,
});

test('用户场景：第 1 家报「未找到立即沟通按钮」，后面 3 家照发', async () => {
  const jobs = [1, 2, 3, 4].map((n) => makeJob(n));
  const called = [];
  const run = await runApplyBatch({
    jobs,
    send: async (job) => {
      called.push(job.company);
      if (job.company === '公司1') throw new Error('未找到“立即沟通”按钮：[]');
    },
  });
  assert.deepEqual(called, ['公司1', '公司2', '公司3', '公司4'], '一条坏岗位不能让整批结束');
  assert.equal(run.sentJobs.length, 3);
  assert.equal(run.skippedJobs.length, 1);
  assert.equal(run.abortInfo, null);
  assert.deepEqual(run.results.map((r) => r.status), ['skipped', 'sent', 'sent', 'sent']);
});

test('连续 3 条岗位级失败 → 停批次，并记录还有几家没试', async () => {
  const jobs = [1, 2, 3, 4, 5].map((n) => makeJob(n));
  const called = [];
  const run = await runApplyBatch({
    jobs,
    send: async (job) => {
      called.push(job.company);
      throw applyError('NO_CHAT_BUTTON', `未找到“立即沟通”按钮；${job.company}`);
    },
  });
  assert.deepEqual(called, ['公司1', '公司2', '公司3'], '到上限就停，不再继续点');
  assert.equal(run.abortInfo.code, 'NO_CHAT_BUTTON');
  assert.equal(run.abortInfo.pending, 2, '剩余的 2 家要告诉用户下一轮会重排');
  assert.equal(run.skippedJobs.length, 3);
});

test('中间成功一条就清零：坏 坏 好 坏 坏 好 全部发完', async () => {
  const jobs = [1, 2, 3, 4, 5, 6].map((n) => makeJob(n));
  const bad = new Set(['公司1', '公司2', '公司4', '公司5']);
  const run = await runApplyBatch({
    jobs,
    maxConsecutiveSkips: 3,
    send: async (job) => {
      if (bad.has(job.company)) throw applyError('JOB_PAGE_TIMEOUT', '岗位页面加载超时');
    },
  });
  assert.equal(run.abortInfo, null, '成功一条就要重新计数，不能累计到停批次');
  assert.equal(run.sentJobs.length, 2);
  assert.equal(run.skippedJobs.length, 4);
});

test('环境级故障立刻停批次：发送未验证之后的岗位一条都不碰', async () => {
  const jobs = [1, 2, 3].map((n) => makeJob(n));
  const called = [];
  const run = await runApplyBatch({
    jobs,
    send: async (job) => {
      called.push(job.company);
      if (job.company === '公司1') throw new Error('点击发送后未在岗位页聊天记录中验证到自定义文案，未记为成功');
    },
  });
  assert.deepEqual(called, ['公司1'], '可能已经发出去的情况下必须停');
  assert.equal(run.abortInfo.code, 'UNVERIFIED_SEND');
  assert.equal(run.abortInfo.pending, 2);
  assert.deepEqual(run.results.map((r) => r.status), ['failed']);
});

test('职位已关闭不占连续失败次数：关闭 → 继续 → 继续 → 继续', async () => {
  const jobs = [1, 2, 3, 4].map((n) => makeJob(n));
  let calls = 0;
  const run = await runApplyBatch({
    jobs,
    maxConsecutiveSkips: 2,
    send: async (job) => {
      calls += 1;
      if (job.company === '公司1') throw applyError('JOB_CLOSED', '职位已关闭');
      if (job.company === '公司2') throw applyError('NO_CHAT_BUTTON', '未找到“立即沟通”按钮');
      if (job.company === '公司3') throw applyError('JOB_CLOSED', '职位已关闭');
    },
  });
  assert.equal(calls, 4);
  assert.equal(run.abortInfo, null, 'closed 不是环境故障，不该推着批次走向停止');
  assert.deepEqual(run.closedHashes, ['h1', 'h3']);
  assert.equal(run.sentJobs.length, 1);
});

test('每类失败的副作用回调各自触发一次（数据库写入点不会漏、也不会错配）', async () => {
  const jobs = [1, 2, 3, 4].map((n) => makeJob(n));
  const log = [];
  await runApplyBatch({
    jobs,
    send: async (job) => {
      if (job.company === '公司1') throw applyError('JOB_CLOSED', '职位已关闭');
      if (job.company === '公司2') throw applyError('NO_CHAT_BUTTON', '未找到“立即沟通”按钮');
      if (job.company === '公司3') throw new Error('AUTO_GREETED: 补发失败');
    },
    onSent: async (job) => log.push(['sent', job.company]),
    onClosed: async (job) => log.push(['closed', job.company]),
    onSkipped: async (job) => log.push(['skipped', job.company]),
    onAutoSent: async (job) => log.push(['auto_sent', job.company]),
  });
  assert.deepEqual(log, [
    ['closed', '公司1'],
    ['skipped', '公司2'],
    ['auto_sent', '公司3'],
    ['sent', '公司4'],
  ]);
});

test('无效的 send 回调要立刻报错（防止把「什么都没发」当成「都发完了」）', async () => {
  await assert.rejects(() => runApplyBatch({ jobs: [makeJob(1)], send: null }), /send\(job\)/);
});

test('写库失败不能把「已经发出去」改判成「没发」，也不能中断批次', async () => {
  const jobs = [1, 2, 3].map((n) => makeJob(n));
  const called = [];
  const run = await runApplyBatch({
    jobs,
    send: async (job) => { called.push(job.company); },
    onSent: async (job) => {
      if (job.company === '公司1') throw new Error('connect ECONNREFUSED 5432');
    },
  });
  assert.deepEqual(called, ['公司1', '公司2', '公司3'], '数据库抖一下不该停批次');
  assert.deepEqual(run.results.map((r) => r.status), ['sent', 'sent', 'sent'], '消息确实发出去了，结果必须是 sent');
  assert.equal(run.sentJobs.length, 3, 'sentJobs 要包含这条，后续 markCandidatesGreeted 才不会漏');
  assert.equal(run.abortInfo, null);
  assert.equal(run.effectErrors.length, 1, '写库失败要单独上报，让用户去补记录');
  assert.equal(run.effectErrors[0].kind, 'sent');
  assert.match(run.effectErrors[0].error, /ECONNREFUSED/);
});

test('连续失败原因：MISSING_GREETING 提示去跑 boss:score，而不是让用户去 Chrome 查风控', async () => {
  const jobs = [1, 2, 3].map((n) => makeJob(n));
  const run = await runApplyBatch({
    jobs,
    send: async () => { throw applyError('MISSING_GREETING', '缺少打招呼文案'); },
  });
  assert.equal(run.abortInfo.code, 'MISSING_GREETING');
  assert.match(run.abortInfo.reason, /boss:score/);
  assert.doesNotMatch(run.abortInfo.reason, /风控/);
});
