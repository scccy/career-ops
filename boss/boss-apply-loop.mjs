// boss-apply-loop.mjs — 一批岗位的发送循环（可注入 send / 副作用，便于测试）
//
// 从 boss-chrome-apply.mjs 里抽出来的原因：这段循环的失败处理就是用户能直接感知的行为
// （「一条岗位报未找到按钮，是不是整批就结束了？」），而它原来埋在 main() 里，绑着 CDP、
// PostgreSQL 和 appendSentLog，没法测。这里只保留控制流与分级，数据库/浏览器副作用
// 由调用方以回调注入，于是 tests/boss-apply-failure.test.mjs 能用假 send 驱动整条
// 「跳过继续 / 连续失败停批次」的路径。
//
// 两条约束（2026-11-18 复核加上的）：
//   1. 副作用（写 sent_log / 追踪表）失败**不能**改变发送结果的判定——消息已经发出去了，
//      不能因为 appendSentLog 抛错就当成「没发」而让下一轮重复打招呼；错误收进 effectErrors 上报。
//   2. 判定用错误的**整条 cause 链**，不只是最外层错误（重新包装会丢掉内层的错误码和页面快照）。
//
// 分级语义见 boss-apply-failure.mjs 顶部注释。

import { classifyApplyFailure, createSkipBreaker } from './boss-apply-failure.mjs';

function resultRow(job, status, extra = {}) {
  return {
    keyHash: job?.key_hash,
    company: job?.company,
    title: job?.title,
    city: job?.city,
    status,
    ...extra,
  };
}

function abortReason(code, streak) {
  if (code === 'MISSING_GREETING') {
    return `连续 ${streak.streak} 条岗位缺少打招呼文案，先跑一次 npm run boss:score 生成文案，本轮已停止`;
  }
  return `连续 ${streak.streak} 条岗位级失败（上限 ${streak.limit}），疑似页面结构变化或风控在拦，已停止本轮后续发送`;
}

/**
 * @param {object} options
 * @param {Array} options.jobs 待发岗位（已按分数/配额选好）
 * @param {(job: object) => Promise<void>} options.send 发一条；失败请 throw
 * @param {(job: object) => Promise<void>} [options.onSent] 发送并验证成功后的副作用
 * @param {(job: object, verdict: object) => Promise<void>} [options.onAutoSent]
 * @param {(job: object, verdict: object) => Promise<void>} [options.onClosed]
 * @param {(job: object, verdict: object) => Promise<void>} [options.onSkipped]
 * @param {(job: object, verdict: object) => Promise<void>} [options.onFatal]
 * @param {number} [options.maxConsecutiveSkips] 连续 N 条 skip 即停批次（0 = 关闭）
 * @param {(result: object, job: object) => void} [options.onResult]
 * @returns {Promise<{results: Array, sentJobs: Array, autoSentJobs: Array, closedHashes: Array, skippedJobs: Array, failedJobs: Array, abortInfo: object|null, effectErrors: Array}>}
 */
export async function runApplyBatch({
  jobs = [],
  send,
  onSent = async () => {},
  onAutoSent = async () => {},
  onClosed = async () => {},
  onSkipped = async () => {},
  onFatal = async () => {},
  maxConsecutiveSkips = 3,
  onResult = () => {},
} = {}) {
  if (typeof send !== 'function') throw new Error('runApplyBatch 需要一个 send(job) 函数');

  const breaker = createSkipBreaker({ maxConsecutiveSkips });
  const results = [];
  const sentJobs = [];
  const autoSentJobs = [];
  const closedHashes = [];
  const skippedJobs = [];
  const failedJobs = [];
  const effectErrors = [];
  let abortInfo = null;

  const push = (result, job) => {
    results.push(result);
    try {
      onResult(result, job);
    } catch {
      // 打印/上报是附带行为，不能因为它抛错影响发送判定
    }
  };

  // 副作用失败只记账，不改判定、不中断批次（见文件头「两条约束」第 1 条）
  const runEffect = async (fn, kind, job, verdict) => {
    try {
      await fn(job, verdict);
    } catch (err) {
      effectErrors.push({ kind, company: job?.company, title: job?.title, keyHash: job?.key_hash, error: String(err?.message || err) });
    }
  };

  for (const [index, job] of jobs.entries()) {
    const notAttempted = jobs.length - index - 1;
    try {
      await send(job);
      // 消息已验证发出：先把结果记下来再写库，库写失败也不能让这条退回「没发」状态
      sentJobs.push(job);
      breaker.recordSuccess();
      push(resultRow(job, 'sent'), job);
      await runEffect(onSent, 'sent', job);
    } catch (err) {
      const verdict = classifyApplyFailure(err);

      if (verdict.kind === 'auto_sent') {
        // 默认语已由 BOSS 自动发出：真实联系已建立，但自定义话术未验证，不冒充 sent
        autoSentJobs.push(job);
        breaker.recordSuccess();
        push(resultRow(job, 'auto_sent', { customVerified: false, error: verdict.message }), job);
        await runEffect(onAutoSent, 'auto_sent', job, verdict);
        continue;
      }

      if (verdict.kind === 'closed') {
        if (job?.key_hash) closedHashes.push(job.key_hash);
        push(resultRow(job, 'closed', { error: verdict.message }), job);
        await runEffect(onClosed, 'closed', job, verdict);
        continue;
      }

      if (verdict.kind === 'skip') {
        // 岗位级失败：不计当日额度、不计 30 天同岗位去重，继续下一家
        skippedJobs.push({ job, verdict });
        push(resultRow(job, 'skipped', { code: verdict.code, reason: verdict.reason, error: verdict.message }), job);
        await runEffect(onSkipped, 'skipped', job, verdict);
        const streak = breaker.recordFailure();
        if (streak.abort) {
          abortInfo = {
            code: verdict.code,
            reason: abortReason(verdict.code, streak),
            pending: notAttempted,
          };
          break;
        }
        continue;
      }

      // fatal = 环境级故障（发送未验证/风控/掉登录/CDP/未分类）：立刻停批次
      failedJobs.push({ job, verdict });
      push(resultRow(job, 'failed', { code: verdict.code, reason: verdict.reason, error: verdict.message }), job);
      await runEffect(onFatal, 'failed', job, verdict);
      abortInfo = {
        code: verdict.code,
        reason: verdict.reason || '环境级故障，已停止本轮后续发送',
        pending: notAttempted,
      };
      break;
    }
  }

  return { results, sentJobs, autoSentJobs, closedHashes, skippedJobs, failedJobs, abortInfo, effectErrors };
}
