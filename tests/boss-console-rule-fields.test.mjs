// tests/boss-console-rule-fields.test.mjs — 控制台规则表字段必须是多行 textarea
//
// 页面用 list.join('\n') 回填这四张规则表。如果元素是单行 <input>，浏览器会把换行吞掉：
// 6 条规则显示成粘在一起的一条（校招应届实习秋招春招毕业生），保存时 splitRuleText 又把它
// 当成一条写回 DB —— 2026-10-14 实际发生过：校园过滤静默失效，用户看到的就是那串粘在一起的词。
//
// 2026-10-15 追加：单关键词扫描预算（卡片上限 / 连续重复止损）的四段接线契约与 0 值语义。
//
// Run: node test-all.mjs --only boss-console-rule-fields

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { splitRuleText } from '../boss/skip-rules.mjs';
import { normalize } from '../boss/boss-config-db.mjs';

const html = readFileSync(join(ROOT, 'boss', 'boss-web', 'index.html'), 'utf-8');
const serverSrc = readFileSync(join(ROOT, 'boss', 'boss-web', 'server.mjs'), 'utf-8');
const configDbSrc = readFileSync(join(ROOT, 'boss', 'boss-config-db.mjs'), 'utf-8');
const RULE_FIELDS = ['fSkipWords', 'fRiskKeywords', 'fTitleExclude', 'fCompanyExclude'];
test('规则表字段是多行 textarea，不是单行 input', () => {
  for (const id of RULE_FIELDS) {
    assert.match(html, new RegExp(`<textarea[^>]*id="${id}"`), `${id} 必须是 <textarea>（单行 input 会吞掉换行）`);
    assert.doesNotMatch(html, new RegExp(`<input[^>]*id="${id}"`), `${id} 不能是单行 <input>`);
  }
});

test('回填与保存的分隔符互相兼容：换行/逗号都能原样往返', () => {
  const six = ['校招', '应届', '实习', '秋招', '春招', '毕业生'];
  assert.deepEqual(splitRuleText(six.join('\n')), six, 'textarea 分支（换行）往返不能丢条目');
  assert.deepEqual(splitRuleText(six.join(', ')), six, '单行回退分支（逗号）往返不能丢条目');
  // 反过来：粘在一起写（没有任何分隔符）无法自动拆——所以字段本身必须是多行/带分隔符
  assert.deepEqual(splitRuleText(six.join('')), [six.join('')]);
});

// ── 单关键词扫描预算字段（2026-10-15）────────────────────────────────────────
// 抽取器的两道闸：单关键词 DOM 卡片上限、连续「已入库岗位」止损。它们必须能从控制台调，
// 否则用户只能去改环境变量。这条契约把四段串起来：控制台表单 → /api/quota 载荷 →
// server 的 saveBossConfig/loadBossConfig → 子进程环境变量；任何一段漏掉，
// 控制台里填的数字都会静默不生效（这正是 2026-10-14 规则表踩过的坑）。
test('扫描预算字段：表单 → 载荷 → API → 子进程环境变量 四段齐全', () => {
  for (const id of ['fMaxDomCards', 'fKnownStreak']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} 必须存在于控制台表单`);
  }
  assert.match(html, /max_dom_cards\s*:\s*maxDomCards/, '载荷必须带上 max_dom_cards');
  assert.match(html, /known_streak_limit\s*:\s*knownStreak/, '载荷必须带上 known_streak_limit');

  assert.match(serverSrc, /'max_dom_cards',\s*'known_streak_limit'/, 'saveBossConfig 必须接受这两个键');
  assert.match(serverSrc, /maxDomCards:\s*Number\.isFinite/, 'loadBossConfig 必须读 max_dom_cards');
  assert.match(serverSrc, /knownStreakLimit:\s*Number\.isFinite/, 'loadBossConfig 必须读 known_streak_limit');
  assert.match(serverSrc, /BOSS_MAX_DOM_CARDS:\s*String\(cfg\.maxDomCards\)/, 'pacingEnv 必须注入卡片上限');
  assert.match(serverSrc, /BOSS_KNOWN_STREAK_LIMIT:\s*String\(cfg\.knownStreakLimit\)/, 'pacingEnv 必须注入重复止损');
});

test('阻止原因表要认识 title_excluded，否则列表里显示原始代码', () => {
  // 发送预检新增的硬闸（2026-10-15）：命中「排队·标题排除」的岗位会被标 title_excluded。
  // 前端没有这个 label 时会落到默认的「候选池（未通过预检）」，用户看不出是校招/实习岗被拦。
  assert.match(html, /title_excluded:\s*\[/, 'index.html 的 labels 表必须含 title_excluded');
});

test('扫描预算字段：0 是合法值（= 关闭），非法值才回落默认 135 / 60', () => {
  const fallback = normalize({});
  assert.equal(fallback.max_dom_cards, 135);
  assert.equal(fallback.known_streak_limit, 60);

  assert.equal(normalize({ max_dom_cards: 0 }).max_dom_cards, 0, '0 = 不限，不能被当成缺省回落到 135');
  assert.equal(normalize({ known_streak_limit: 0 }).known_streak_limit, 0, '0 = 关闭，不能被回落到 60');
  assert.equal(normalize({ max_dom_cards: 225 }).max_dom_cards, 225);
  assert.equal(normalize({ known_streak_limit: 120 }).known_streak_limit, 120);

  assert.equal(normalize({ max_dom_cards: -1 }).max_dom_cards, 135, '负数非法，回落默认');
  assert.equal(normalize({ known_streak_limit: '不是数字' }).known_streak_limit, 60, '非数字非法，回落默认');
  assert.match(configDbSrc, /max_dom_cards:\s*135/, 'DB 默认卡片上限应为 135');
  assert.match(configDbSrc, /known_streak_limit:\s*60/, 'DB 默认重复止损应为 60');
});
