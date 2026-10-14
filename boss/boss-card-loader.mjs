#!/usr/bin/env node
// boss-card-loader.mjs — BOSS 搜索页「卡片按需增量载入」策略（与 CDP/DOM 解耦，可单测）
//
// 背景（2026-10-14 用户要求）：
//   旧实现开始采集中途之前先跑一遍 loadCards()，一口气滚到页底，把 targetCompanies×2
//   （至少 30）张卡片全部拉进 DOM，然后才逐张点开——等于「把卡片一次性全部加载出来」。
//   真人的做法是：先看当前这一屏，看掉几张、手里的卡片不够了再往下滚一小段加载新的。
//   现在改为按需补货：DOM 里「待处理」卡片少于 low 水位时才滚动，补到 high 水位即停；
//   滚动也不再是 scrollTo(0, scrollHeight) 一步跳到页底，而是按视口分步滚（距离与停顿都带随机）。
//
// 本模块只负责「什么时候滚、滚多少、有没有到底」，不关心岗位字段抽取，因此可以在
// tests/boss-card-loader.test.mjs 里用一个假的页面模型直接验证，不需要 Chrome/BOSS。
//
// 语义：
//   cardState()          一次 DOM 快照：卡片总数 / 待处理数 / 第一张待处理卡片下标 / 滚动位置
//   waitForFirstCards()  等首屏卡片渲染出来（不滚动；风控页会直接抛错）
//   fillCardBuffer()     待处理卡片 < high 时按视口分步向下滚，直到补够或确认列表到底
//   exhausted            一旦确认「滚到页底 + 连续多次没有新卡片」，后续调用直接返回，不再滚动
//
// config（调用方从环境变量解析后注入，见 boss-chrome-extract.mjs）：
//   low / high                 待处理卡片的下/上水位（默认 3 / 8）
//   maxLoadSteps               单次补货最多滚动步数（默认 60）
//   stagnantLimit              页底连续无新卡片的容忍次数（默认 8）
//   stepMinRatio/stepMaxRatio  每步滚动的视口比例区间（默认 0.55 ~ 0.95）
//   stepGapMinMs/stepGapMaxMs  每步之间的随机停顿（默认 450 ~ 1100ms）
//   bottomSettleMs             已在页底时，等懒加载追加下一批的额外等待（默认 1200ms）
//   initialTimeoutMs           首屏等待上限（默认 20000ms）

export const CARD_SEL = '.job-list-container .job-card-box';

export const CARD_LOADER_DEFAULTS = Object.freeze({
  low: 3,
  high: 8,
  maxLoadSteps: 60,
  stagnantLimit: 8,
  stepMinRatio: 0.55,
  stepMaxRatio: 0.95,
  stepGapMinMs: 450,
  stepGapMaxMs: 1100,
  bottomSettleMs: 1200,
  initialTimeoutMs: 20000,
});

const EMPTY_STATE = Object.freeze({ total: 0, pending: 0, pos: -1, y: 0, vh: 0, sh: 0, hidden: false });

// 空结果页文案：命中时可以不用等满首屏超时。
const NO_RESULT_RE = /没有找到|未找到|暂无(符合|相关)|换个关键词/;

/**
 * 点击产出止损（2026-10-14 用户确认）。
 *
 * 一次点击没带来新公司 = 该点击产出为零（命中跳词、同公司重复、JD 被丢弃都算）。
 * 连续 limit 次零产出就认为这个词已经枯竭：过滤率高的词（整页外包/猎头/已入库岗位）
 * 否则会一路点到 --max-cards 上限才收手，白跑十几分钟。
 *
 * limit <= 0 表示关闭（只靠点击上限兜底）。
 *
 * @param {number} [limit=40] 连续零产出点击数的阈值
 */
export function createYieldStreak(limit = 40) {
  const cap = Number.isFinite(Number(limit)) ? Number(limit) : 40;
  let streak = 0;
  return {
    limit: cap,
    /** 当前连续零产出点击数。 */
    get clicks() { return streak; },
    /** 记一次点击（先按「零产出」计，命中新公司时再清零）。 */
    recordClick() { streak += 1; return streak; },
    /** 记一次「拿到新公司」，连续计数清零。 */
    recordCompany() { streak = 0; },
    /** 是否已触发止损。 */
    get exhausted() { return cap > 0 && streak >= cap; },
  };
}

/**
 * 确保 BOSS 标签页在前台（可见）。
 *
 * 2026-10-14 实测：标签页在后台时（`document.hidden === true`）BOSS 的无限滚动**不追加新卡片**——
 * 一直滚到底也只有首屏 15 张，扫描器会误判「列表已到底」。把标签页切到前台后，下一批卡片
 * 会在几秒内追加（实测 15 → 30）。所以每次扫描前先把标签页切到前台并轮询可见性。
 *
 * 切前台由调用方注入（CDP `Page.bringToFront` + `/json/activate`），本函数只负责「读隐藏状态、
 * 轮询等它变可见」，因此可以在测试里用一个假页面验证。
 *
 * @param {object} deps
 * @param {(js: string, fallback?: any) => Promise<any>} deps.execJson
 * @param {() => Promise<any>} [deps.bringToFront]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.timeoutMs=8000] 等待可见的上限
 * @param {number} [deps.pollMs=1000] 轮询间隔
 * @returns {Promise<{hidden: boolean, broughtToFront: boolean}>} hidden=true 表示始终没等到可见
 */
export async function ensureTabVisible({
  execJson,
  bringToFront = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
  timeoutMs = 8000,
  pollMs = 1000,
} = {}) {
  const readHidden = async () => {
    const s = await execJson('JSON.stringify({ hidden: document.hidden === true })', { hidden: false });
    return s?.hidden === true;
  };

  if (!(await readHidden())) return { hidden: false, broughtToFront: false };
  if (!bringToFront) {
    log('[前台] ⚠ BOSS 标签页在后台，且当前通道无法切前台——后台页不会触发无限滚动，本次可能只看到首屏');
    return { hidden: true, broughtToFront: false };
  }

  log('[前台] BOSS 标签页在后台（后台页不触发无限滚动）→ 切到前台');
  await bringToFront();

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    if (!(await readHidden())) {
      log('[前台] 标签页已可见，继续扫描');
      return { hidden: false, broughtToFront: true };
    }
  }
  log(`[前台] ⚠ 切前台后 ${Math.round(timeoutMs / 1000)}s 仍不可见（窗口被最小化/遮挡？）——本次可能只看到首屏`);
  return { hidden: true, broughtToFront: true };
}

/**
 * 造一个卡片载入器。
 *
 * @param {object} deps
 * @param {(js: string) => Promise<string>} deps.execJs   在页面里执行 JS，返回字符串
 * @param {(js: string, fallback?: any) => Promise<any>} deps.execJson  同上但解析 JSON
 * @param {() => Promise<any>} [deps.assertNotBlocked]     风控/登录页检测（命中应抛错）
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.random]
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.log]
 * @param {object} [deps.config]  覆盖 CARD_LOADER_DEFAULTS
 */
export function createCardLoader({
  execJs,
  execJson,
  assertNotBlocked = async () => ({}),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  now = () => Date.now(),
  log = () => {},
  config = {},
} = {}) {
  if (typeof execJs !== 'function' || typeof execJson !== 'function') {
    throw new Error('createCardLoader 需要 execJs 与 execJson');
  }
  const cfg = { ...CARD_LOADER_DEFAULTS, ...config };
  cfg.high = Math.max(cfg.low + 1, cfg.high);
  cfg.stepGapMaxMs = Math.max(cfg.stepGapMinMs, cfg.stepGapMaxMs);
  const exhaustedFlag = { value: false };

  const between = (min, max) => min + random() * Math.max(0, max - min);

  // 一次 DOM 快照。不再分别查卡片数、滚动位置和「第一张未处理卡片」，一次 eval 全拿到。
  async function cardState() {
    return execJson(
      `(() => {
  const cards = [...document.querySelectorAll("${CARD_SEL}")];
  const pending = cards.filter((c) => !c.dataset.bossExtracted);
  return JSON.stringify({
    total: cards.length,
    pending: pending.length,
    pos: pending.length ? cards.indexOf(pending[0]) : -1,
    y: window.scrollY || window.pageYOffset || 0,
    vh: window.innerHeight || 0,
    sh: document.body.scrollHeight || 0,
    hidden: document.hidden === true,
  });
})()`,
      { ...EMPTY_STATE },
    );
  }

  // 往下滚一小段（约半个到近一个视口，带抖动），停顿也随机——比一步跳到页底更像真人滚轮操作。
  async function scrollStep() {
    const before = await cardState();
    const vh = before.vh || 800;
    const distance = Math.round(vh * between(cfg.stepMinRatio, cfg.stepMaxRatio)) + Math.round(random() * 60);
    await execJs(`window.scrollBy(0, ${distance}); "ok"`);
    await sleep(Math.round(between(cfg.stepGapMinMs, cfg.stepGapMaxMs)));
    return distance;
  }

  // 首屏等待：搜索结果是异步渲染的，这里只等、不滚（真人是先看当前这一屏）。
  // 判定用 total 而不是 pending：页面已有卡片、但都被打上已处理标记时（同一页面重复跑），
  // 也该立刻回到主循环让 fillCardBuffer 往下滚找新卡片，而不是干等超时。
  async function waitForFirstCards() {
    const deadline = now() + cfg.initialTimeoutMs;
    let state = { ...EMPTY_STATE };
    while (now() < deadline) {
      const page = await assertNotBlocked();
      state = await cardState();
      if (state.total > 0) return state;
      // 结果页明确为空：不必等满超时
      if (state.total === 0 && NO_RESULT_RE.test(page?.body || '')) return state;
      await sleep(1500);
    }
    return state;
  }

  // 按需补货：手里的卡片不够了才滚，直到补够 high 水位或确认到底。
  // 返回 { state, exhausted }；exhausted=true 表示列表已到底，调用方不会再拿到新卡片。
  async function fillCardBuffer(reason = '') {
    let state = await cardState();
    if (exhaustedFlag.value) return { state, exhausted: true };
    if (state.pending >= cfg.high) return { state, exhausted: false };

    log(`[补货] 待处理 ${state.pending} 张${reason ? `（${reason}）` : ''} → 按视口分步向下滚，加载新卡片`);

    let stagnant = 0;
    let steps = 0;
    while (state.pending < cfg.high) {
      if (++steps > cfg.maxLoadSteps) {
        log(`[补货] 已滚 ${cfg.maxLoadSteps} 步仍未补够（待处理 ${state.pending} 张），本轮先停`);
        return { state, exhausted: false };
      }
      await assertNotBlocked(); // 长时间运行中风控可能中途介入
      const before = state;
      await scrollStep();
      const after = await cardState();
      const grew = after.total > before.total || after.sh > before.sh;
      const moved = after.y > before.y;
      const atBottom = after.vh > 0 && after.sh > 0 && after.y + after.vh >= after.sh - 4;

      if (grew) {
        stagnant = 0;
        log(`[补货] 卡片 ${after.total} 张（待处理 ${after.pending}）`);
      } else if (moved && !atBottom) {
        stagnant = 0; // 还在往下走，只是这一段还没到懒加载的触发点
      } else {
        stagnant += 1;
        if (atBottom) await sleep(cfg.bottomSettleMs); // 已到页底：等 BOSS 追加下一批（要 2~3 次轮询）
        if (stagnant >= cfg.stagnantLimit) {
          exhaustedFlag.value = true;
          log(`[补货] 连续 ${cfg.stagnantLimit} 次滚到页底仍无新卡片，判定列表已到底`);
          if (state.hidden) {
            log('[补货] ⚠ 但 BOSS 标签页当前在后台（document.hidden=true）——实测后台页不会触发无限滚动，'
              + '「到底」很可能是假的；把 BOSS 窗口切到前台可恢复加载');
          }
          return { state: after, exhausted: true };
        }
      }
      state = after;
    }
    return { state, exhausted: false };
  }

  return {
    cardState,
    scrollStep,
    waitForFirstCards,
    fillCardBuffer,
    get exhausted() { return exhaustedFlag.value; },
    config: cfg,
  };
}
