// tests/boss-card-loader.test.mjs — BOSS 卡片「按需增量载入」的行为契约（2026-10-14）
//
// 背景：抽取器原来开局先跑一遍 loadCards()，一口气滚到页底，把 targetCompanies×2
// （至少 30）张卡片全部拉进 DOM，然后才逐张点开——用户指出这是「把卡片一次性全部加载
// 出来」，不像真人。现在的契约是：不预载，手里待处理的卡片不够了，才往下滚一小段补一批。
//
// 这些用例用一个假的页面模型（同一套滚动/懒加载语义的最小重写）驱动
// boss/boss-card-loader.mjs，把「什么时候滚、滚多远、什么时候算到底」钉死。
// 不需要 Chrome，也不会碰 BOSS 站点。
//
// Run: node test-all.mjs --only boss-card-loader
//      node --test tests/boss-card-loader.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCardBudget, createCardLoader, createKnownCardStreak, createYieldStreak, ensureTabVisible, CARD_SEL } from '../boss/boss-card-loader.mjs';

// ── 假 BOSS 搜索页 ────────────────────────────────────────────────────────────
// 卡片分批追加；只有「滚到页底」才触发下一批，而且要连续触底 appendAfterBottomHits 次
// （真实页面追加新一批要 2~3 次轮询，约 4~6 秒），所以「到底但还没追加」必须能区分出来。
class FakeBossPage {
  constructor({
    firstBatch = 15,
    batchSize = 15,
    pool = 45,
    viewport = 800,
    rowHeight = 92,
    padding = 300,
    appendAfterBottomHits = 2,
    openResult = true,
  } = {}) {
    this.viewport = viewport;
    this.rowHeight = rowHeight;
    this.padding = padding;
    this.batchSize = batchSize;
    this.pool = pool;
    this.appendAfterBottomHits = appendAfterBottomHits;
    this.cards = openResult
      ? Array.from({ length: Math.min(firstBatch, pool) }, () => ({ extracted: false }))
      : [];
    this.y = 0;
    this.bottomStreak = 0;
    this.scrollCalls = [];
  }

  get sh() { return Math.max(this.viewport, this.padding * 2 + this.cards.length * this.rowHeight); }
  get maxY() { return Math.max(0, this.sh - this.viewport); }
  get atBottom() { return this.y >= this.maxY - 1; }
  pending() { return this.cards.filter((c) => !c.extracted).length; }

  state() {
    const pos = this.cards.findIndex((c) => !c.extracted);
    return { total: this.cards.length, pending: this.pending(), pos, y: this.y, vh: this.viewport, sh: this.sh, hidden: false };
  }

  /** 模拟「这一张卡片已经被处理掉」（真实实现里 peek 会打 dataset.bossExtracted）。 */
  consumeFirstPending(n = 1) {
    let done = 0;
    for (const card of this.cards) {
      if (done >= n) break;
      if (!card.extracted) { card.extracted = true; done += 1; }
    }
    return done;
  }

  /** 模拟 window.scrollBy：夹在可滚范围内；触底累计够了就追加下一批（懒加载）。 */
  scrollBy(distance) {
    this.scrollCalls.push(distance);
    const before = this.y;
    this.y = Math.min(this.maxY, this.y + distance);
    if (this.atBottom) {
      this.bottomStreak += 1;
      if (this.bottomStreak >= this.appendAfterBottomHits) this.loadNextBatch();
    } else {
      this.bottomStreak = 0;
    }
    return this.y > before;
  }

  loadNextBatch() {
    this.bottomStreak = 0;
    const next = Math.min(this.pool, this.cards.length + this.batchSize);
    for (let i = this.cards.length; i < next; i++) this.cards.push({ extracted: false });
  }
}

const BIG = { low: 3, high: 8, stagnantLimit: 3, bottomSettleMs: 100, maxLoadSteps: 40 };

function makeLoader(page, config = BIG) {
  let clock = 0;
  const sleeps = [];
  let randomIndex = 0;
  const loader = createCardLoader({
    execJs: async (js) => {
      const m = /window\.scrollBy\(0,\s*(\d+)\)/.exec(js);
      assert.ok(m, `假页面只认识 window.scrollBy，收到：${js}`);
      page.scrollBy(Number(m[1]));
      return 'ok';
    },
    execJson: async (js) => {
      assert.ok(js.includes(CARD_SEL), `快照脚本必须查 ${CARD_SEL}`);
      assert.ok(js.includes('document.hidden'), '快照脚本必须带 document.hidden（后台标签页不触发懒加载）');
      return page.state();
    },
    assertNotBlocked: async () => ({ body: '' }),
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    random: () => { randomIndex += 1; return (randomIndex % 7) / 10; },
    now: () => clock,
    config,
  });
  return { loader, page, sleeps };
}

// ── 核心回归：开局不预载 ─────────────────────────────────────────────────────
test('首屏只等渲染，不滚动——卡片不再被一次性全部加载', async () => {
  const page = new FakeBossPage({ firstBatch: 15, pool: 120 });
  const { loader } = makeLoader(page);

  const first = await loader.waitForFirstCards();
  assert.equal(page.scrollCalls.length, 0, '等首屏渲染时不应该滚动');
  assert.equal(first.total, 15, '首屏就是首屏那一批，不是整页');
  assert.equal(first.pending, 15);
  assert.ok(page.cards.length < page.pool, '开局不得把候选池全部载入');
});

test('待处理卡片够用时不滚动，不够了才补货', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 120 });
  const { loader } = makeLoader(page);
  await loader.waitForFirstCards();

  // 还剩 10 张（> low=3）：一次都不该滚
  page.consumeFirstPending(5);
  const enough = await loader.fillCardBuffer('待处理充足');
  assert.equal(page.scrollCalls.length, 0, '水位之上不该滚动');
  assert.equal(enough.state.pending, 10);
  assert.equal(enough.exhausted, false);

  // 处理到只剩 3 张（= low）：才补货
  page.consumeFirstPending(7);
  assert.equal(page.pending(), 3);
  const filled = await loader.fillCardBuffer('待处理不足');
  assert.ok(page.scrollCalls.length > 0, '水位之下应当滚动补货');
  assert.ok(filled.state.pending >= BIG.high, `补货后待处理应达到 ${BIG.high} 张，实际 ${filled.state.pending}`);
  assert.ok(page.cards.length < page.pool, '补货只补一批，不是把整页卡片全拉出来');
});

test('滚动是一段一段的，不会一步跳到页底', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 120 });
  const { loader } = makeLoader(page);
  await loader.waitForFirstCards();
  page.consumeFirstPending(12);

  const distanceToBottom = page.maxY;
  await loader.fillCardBuffer('待处理不足');

  assert.ok(page.scrollCalls.length >= 2, `应当分多步滚（实际 ${page.scrollCalls.length} 步）`);
  for (const d of page.scrollCalls) {
    assert.ok(d < distanceToBottom, `单步 ${d}px 应小于整页可滚距离 ${distanceToBottom}px`);
    assert.ok(d > 0 && d < page.viewport * 1.1, `单步 ${d}px 应在一屏之内（viewport ${page.viewport}px）`);
  }
});

test('中途没有新卡片不算停滞：只是还没滚到懒加载的触发位置', async () => {
  // stagnantLimit=2 很小，如果按「没有新卡片」判定停滞，会在到页底之前就误判成结束
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 120, appendAfterBottomHits: 1 });
  const { loader } = makeLoader(page, { ...BIG, stagnantLimit: 2 });
  await loader.waitForFirstCards();
  page.consumeFirstPending(12);

  const filled = await loader.fillCardBuffer('待处理不足');
  assert.equal(loader.exhausted, false, '页底还没到，不应判定到底');
  assert.equal(filled.exhausted, false);
  assert.ok(page.cards.length > 15, '继续往下滚应当触发下一批懒加载');
});

// ── 到底判定 ─────────────────────────────────────────────────────────────────
test('页底连续无新卡片才判到底，且之后不再滚动', async () => {
  const page = new FakeBossPage({ firstBatch: 9, pool: 9 });
  const { loader } = makeLoader(page);
  await loader.waitForFirstCards();
  page.consumeFirstPending(6);

  const filled = await loader.fillCardBuffer('待处理不足');
  assert.equal(filled.exhausted, true, '候选池已空且滚到页底，应判到底');
  assert.equal(loader.exhausted, true);
  const scrollsWhenExhausted = page.scrollCalls.length;
  assert.ok(scrollsWhenExhausted <= BIG.stagnantLimit + 3, `到底判定前的滚动次数应有界，实际 ${scrollsWhenExhausted}`);

  // 到底之后再调用：立刻返回，不再滚动（否则每处理一张卡都要重新滚一遍页底）
  const again = await loader.fillCardBuffer('当前卡片已处理完');
  assert.equal(again.exhausted, true);
  assert.equal(page.scrollCalls.length, scrollsWhenExhausted, '判到底之后不得再滚动');
});

// ── 首屏等待 ─────────────────────────────────────────────────────────────────
test('空结果页：识别到「没有找到」文案就立即返回，不等满超时', async () => {
  const page = new FakeBossPage({ openResult: false });
  let clock = 0;
  const loader = createCardLoader({
    execJs: async () => 'ok',
    execJson: async () => page.state(),
    assertNotBlocked: async () => ({ body: '没有找到相关职位，换个关键词试试' }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    config: { initialTimeoutMs: 20000 },
  });

  const state = await loader.waitForFirstCards();
  assert.equal(state.total, 0);
  assert.equal(state.pending, 0);
  assert.equal(clock, 0, '命中空结果文案时应立即返回，不睡超时');
});

test('首屏一直没有卡片：等到超时为止，且期间不滚动', async () => {
  const page = new FakeBossPage({ openResult: false });
  const { loader, sleeps } = makeLoader(page, { ...BIG, initialTimeoutMs: 3000 });

  const state = await loader.waitForFirstCards();
  assert.equal(state.pending, 0);
  assert.equal(page.scrollCalls.length, 0, '等首屏时不得滚动');
  assert.equal(sleeps.length, 2, '每 1.5s 轮询一次，3s 超时应轮询 2 次');
});

test('首屏卡片都已处理过（同一页面重跑）：不干等超时，直接往下滚找新卡片', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 45 });
  const { loader, sleeps } = makeLoader(page);
  page.consumeFirstPending(15); // 首屏全部打上「已处理」标记

  const first = await loader.waitForFirstCards();
  assert.equal(first.total, 15);
  assert.equal(first.pending, 0);
  assert.ok(!sleeps.includes(1500), '页面已有卡片时不应走「等超时」的轮询分支');

  const filled = await loader.fillCardBuffer('当前卡片已处理完');
  assert.ok(filled.state.pending > 0, '应当滚出新的未处理卡片，而不是直接收工');
  assert.ok(page.scrollCalls.length > 0);
});

// ── 点击产出止损 ─────────────────────────────────────────────────────────────
test('产出止损：连续 40 次零产出才触发，拿到新公司立即清零', () => {
  const streak = createYieldStreak(40);
  for (let i = 1; i <= 39; i++) {
    streak.recordClick();
    assert.equal(streak.exhausted, false, `第 ${i} 次点击（未到阈值）不应触发止损`);
  }
  assert.equal(streak.clicks, 39);
  streak.recordClick();
  assert.equal(streak.exhausted, true, '第 40 次连续零产出点击应触发止损');

  streak.recordCompany();
  assert.equal(streak.clicks, 0, '拿到新公司后连续计数清零');
  assert.equal(streak.exhausted, false);

  // 中间有一次产出时，零产出计数必须重新累计，而不是按总点击数算
  const intermittent = createYieldStreak(40);
  for (let i = 0; i < 30; i++) intermittent.recordClick();
  intermittent.recordCompany();
  for (let i = 0; i < 39; i++) intermittent.recordClick();
  assert.equal(intermittent.exhausted, false, '清零后重新数到 39 次不应触发');
  intermittent.recordClick();
  assert.equal(intermittent.exhausted, true);
});

test('产出止损：limit=0 关闭；非法值回落 40', () => {
  const off = createYieldStreak(0);
  for (let i = 0; i < 500; i++) off.recordClick();
  assert.equal(off.exhausted, false, 'limit=0 表示不启用产出止损');

  const fallback = createYieldStreak('不是数字');
  assert.equal(fallback.limit, 40);
  const negative = createYieldStreak(-1);
  assert.equal(negative.exhausted, false, '负数视为关闭');
});

// ── 单关键词「处理量」预算（2026-10-15 实测后修正）──────────────────────────
// 教训：按 DOM 卡片数封顶封不住。点击卡片会执行 card.scrollIntoView()，这次滚动会触发 BOSS
// 自己的无限滚动再追加一批卡片——loader 停止滚动也拦不住。2026-10-15 上海扫描实测：
// 日志写着「达到单关键词上限 135 张，停止加载」，最后却靠「凑够 45 家」才停，DOM 涨到 165。
// 所以预算只能按「处理过的卡片数」计：处理满 N 张就收工，与页面追加多少张无关。
test('卡片预算：处理满 limit 张就停；limit=0 不限；非法值视为不限', () => {
  const b = createCardBudget(3);
  assert.equal(b.limit, 3);
  assert.equal(b.exhausted, false);
  assert.equal(b.remaining, 3);
  b.spend();
  b.spend();
  assert.equal(b.used, 2);
  assert.equal(b.remaining, 1);
  assert.equal(b.exhausted, false, '用了 2 张、上限 3 张，还没用满');
  b.spend();
  assert.equal(b.used, 3);
  assert.equal(b.exhausted, true, '第 3 张用满即收工');
  assert.equal(b.remaining, 0);

  const off = createCardBudget(0);
  for (let i = 0; i < 500; i++) off.spend();
  assert.equal(off.exhausted, false, 'limit=0 表示不限');
  assert.equal(off.remaining, Infinity);
  assert.equal(createCardBudget(-5).limit, 0);
  assert.equal(createCardBudget('不是数字').limit, 0);
});

test('卡片预算：页面在点击时继续追加卡片也拦得住（DOM 超出上限仍按处理量收工）', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 400 });
  const { loader } = makeLoader(page, { ...BIG, maxTotalCards: 135 });
  await loader.waitForFirstCards();

  const budget = createCardBudget(60);
  let processed = 0;
  let stopReason = '';
  for (let guard = 0; guard < 2000; guard++) {
    if (budget.exhausted) { stopReason = 'budget'; break; }
    let state = await loader.cardState();
    if (state.pending <= loader.config.low) {
      const filled = await loader.fillCardBuffer(state.pending === 0 ? '当前卡片已处理完' : '待处理不足');
      state = filled.state;
    }
    if (state.pending === 0) { stopReason = 'empty'; break; }
    budget.spend();
    page.consumeFirstPending(1);
    processed += 1;
    // 模拟 clickScript 的 scrollIntoView：滚动触发 BOSS 追加下一批（真实页面要连续触底 2 次）
    if (processed % 2 === 0) page.loadNextBatch();
  }

  assert.equal(processed, 60, `应正好处理 60 张卡片后收工，实际 ${processed}`);
  assert.equal(stopReason, 'budget', `应由预算收工，实际是「${stopReason}」——预算没封住`);
  assert.ok(page.cards.length > 60, `页面已自行追加到 ${page.cards.length} 张，应超出预算仍能收工`);
});

// ── 单关键词 DOM 卡片上限（保留：只是"不再往下加载"的兜底闸）─────────────────
// 背景：--max-cards 只数「点击」，已入库岗位在点击前就被跳过、不占点击额度，
// 所以「整页都是上几次扫过的岗位」时点击上限与产出止损都不会触发，只能滚到真页底。
test('DOM 上限：加载到上限就停止加载新卡片（不是判到底），且之后不再滚动', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 300 });
  const { loader } = makeLoader(page, { ...BIG, maxTotalCards: 30 });
  await loader.waitForFirstCards();

  page.consumeFirstPending(12); // pending=3 → 触发补货
  const filled = await loader.fillCardBuffer('待处理不足');
  assert.equal(filled.capped, true, '达到上限应返回 capped=true');
  assert.equal(filled.exhausted, false, '上限不是「列表已到底」，两者必须区分');
  assert.equal(page.cards.length, 30, `应在上限处停（实际 ${page.cards.length}）`);

  const scrollsAtCap = page.scrollCalls.length;
  const again = await loader.fillCardBuffer('待处理不足');
  assert.equal(again.capped, true);
  assert.equal(page.scrollCalls.length, scrollsAtCap, '已达上限后不得再滚动');
});

test('DOM 上限：只停止加载，手里那批卡片照常处理完才收工', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 300 });
  const { loader } = makeLoader(page, { ...BIG, maxTotalCards: 30 });
  await loader.waitForFirstCards();

  let processed = 0;
  let capped = false;
  for (let guard = 0; guard < 500; guard++) {
    let state = await loader.cardState();
    if (state.pending <= loader.config.low) {
      const filled = await loader.fillCardBuffer(state.pending === 0 ? '当前卡片已处理完' : '待处理不足');
      state = filled.state;
      if (filled.capped) capped = true;
    }
    if (state.pending === 0) break;
    page.consumeFirstPending(1);
    processed += 1;
  }

  assert.equal(capped, true, '应当撞到上限');
  assert.equal(page.cards.length, 30, `DOM 不得越过上限继续加载（实际 ${page.cards.length}）`);
  assert.equal(processed, 30, `上限内的卡片必须全部处理完，不能被提前中断（实际处理 ${processed}）`);
});

test('DOM 上限：上限落在两批之间时最多超出一批（BOSS 一屏 15 张），不会无界', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 300 });
  const { loader } = makeLoader(page, { ...BIG, maxTotalCards: 20 });
  await loader.waitForFirstCards();
  page.consumeFirstPending(12);

  const filled = await loader.fillCardBuffer('待处理不足');
  assert.equal(filled.capped, true);
  assert.ok(page.cards.length <= 20 + 15, `超出上限不得超过一批（实际 ${page.cards.length}）`);
});

// ── 重复岗位止损（2026-10-15 用户提出）───────────────────────────────────────
test('重复止损：连续 N 张已入库岗位才触发，出现新卡片立即清零', () => {
  const streak = createKnownCardStreak(60);
  for (let i = 1; i <= 59; i++) {
    streak.recordKnown();
    assert.equal(streak.exhausted, false, `第 ${i} 张（未到阈值）不应触发`);
  }
  streak.recordKnown();
  assert.equal(streak.exhausted, true, '第 60 张连续已入库应触发收工');
  streak.recordOther();
  assert.equal(streak.cards, 0, '出现非已入库卡片后清零');
  assert.equal(streak.exhausted, false);

  // 中间来一张新卡片必须重新累计，而不是按总数算
  const intermittent = createKnownCardStreak(60);
  for (let i = 0; i < 50; i++) intermittent.recordKnown();
  intermittent.recordOther();
  for (let i = 0; i < 59; i++) intermittent.recordKnown();
  assert.equal(intermittent.exhausted, false, '清零后重新数到 59 张不应触发');
  intermittent.recordKnown();
  assert.equal(intermittent.exhausted, true);
});

test('重复止损：limit=0 关闭；非法值视为关闭', () => {
  const off = createKnownCardStreak(0);
  for (let i = 0; i < 500; i++) off.recordKnown();
  assert.equal(off.exhausted, false, 'limit=0 表示不启用重复止损');
  assert.equal(createKnownCardStreak(-5).limit, 0);
  assert.equal(createKnownCardStreak('不是数字').limit, 0);
  assert.equal(createKnownCardStreak(undefined).limit, 60, '默认 60 张');
});

// ── 前台可见性（后台标签页不触发 BOSS 无限滚动）─────────────────────────────
test('前台可见性：已经可见时不做任何操作', async () => {
  let called = 0;
  const result = await ensureTabVisible({
    execJson: async () => ({ hidden: false }),
    bringToFront: async () => { called += 1; },
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(called, 0, '已可见就不该切前台');
  assert.equal(result.hidden, false);
  assert.equal(result.broughtToFront, false);
});

test('前台可见性：后台标签页先切前台，等到可见再继续', async () => {
  let hidden = true;
  let clock = 0;
  const order = [];
  const result = await ensureTabVisible({
    execJson: async (js) => {
      assert.ok(js.includes('document.hidden'), '可见性探测必须读 document.hidden');
      return { hidden };
    },
    bringToFront: async () => { order.push('front'); hidden = false; },
    sleep: async (ms) => { clock += ms; order.push(`sleep${ms}`); },
    now: () => clock,
    log: () => {},
    timeoutMs: 5000,
    pollMs: 1000,
  });
  assert.deepEqual(order, ['front', 'sleep1000'], '应当先切前台、再轮询一次就发现可见');
  assert.equal(result.hidden, false);
  assert.equal(result.broughtToFront, true);
});

test('前台可见性：切了仍不可见 → 超时并如实返回 hidden=true（调用方据此告警）', async () => {
  let clock = 0;
  let called = 0;
  const result = await ensureTabVisible({
    execJson: async () => ({ hidden: true }),
    bringToFront: async () => { called += 1; },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    log: () => {},
    timeoutMs: 3000,
    pollMs: 1000,
  });
  assert.equal(called, 1, '只切一次，不反复抢焦点');
  assert.equal(result.hidden, true);
  assert.equal(result.broughtToFront, true);
});

test('前台可见性：没有切前台通道时只告警、不抛错', async () => {
  const result = await ensureTabVisible({
    execJson: async () => ({ hidden: true }),
    bringToFront: null,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(result.hidden, true);
  assert.equal(result.broughtToFront, false);
});

// ── 主循环契约：与 boss-chrome-extract.mjs 相同的用法 ────────────────────────
test('按需补货的主循环：能把候选池吃完、且第一张卡片处理时并没有整页载入', async () => {
  const page = new FakeBossPage({ firstBatch: 15, batchSize: 15, pool: 40 });
  const { loader } = makeLoader(page);

  const first = await loader.waitForFirstCards();
  assert.ok(first.pending > 0);

  let processed = 0;
  let cardsWhenFirstProcessed = null;
  for (let guard = 0; guard < 500; guard++) {
    let state = await loader.cardState();
    if (state.pending <= loader.config.low) {
      const filled = await loader.fillCardBuffer(state.pending === 0 ? '当前卡片已处理完' : '待处理不足');
      state = filled.state;
    }
    if (state.pending === 0) break;
    if (cardsWhenFirstProcessed === null) cardsWhenFirstProcessed = page.cards.length;
    page.consumeFirstPending(1);
    processed += 1;
  }

  assert.equal(processed, 40, `应把候选池 40 张都处理完，实际 ${processed}`);
  assert.equal(cardsWhenFirstProcessed, 15, '处理第一张卡片时 DOM 里只应有首屏那一批');
  assert.ok(page.scrollCalls.length <= 25, `滚动次数应有界，实际 ${page.scrollCalls.length}`);
  const finalState = await loader.cardState();
  assert.equal(finalState.pending, 0);
});
