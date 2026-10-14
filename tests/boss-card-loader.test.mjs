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
import { createCardLoader, createYieldStreak, CARD_SEL } from '../boss/boss-card-loader.mjs';

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
    return { total: this.cards.length, pending: this.pending(), pos, y: this.y, vh: this.viewport, sh: this.sh };
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
