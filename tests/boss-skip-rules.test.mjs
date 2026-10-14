// tests/boss-skip-rules.test.mjs — 跳词/排除规则的默认表与「词表 → 正则」契约（2026-10-14 统一到控制台）
//
// 这些默认表原来硬编码在三个脚本里，现在统一到 boss/skip-rules.mjs 并由控制台（DB boss_config）管理。
// 这里钉死三件事：
//   1. 缺省/空数组的语义——空数组是「不启用该规则」，不能被默认值悄悄补回来；
//   2. 非法正则不能让扫描崩掉，同时要能在控制台保存那一步被拦下；
//   3. 默认跳词表与迁移前的硬编码正则**逐字等价**，避免转写时漏字/多字。
//
// Run: node test-all.mjs --only boss-skip-rules
//      node --test tests/boss-skip-rules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SKIP_WORDS,
  DEFAULT_RISK_KEYWORDS,
  DEFAULT_TITLE_EXCLUDE,
  DEFAULT_COMPANY_EXCLUDE,
  NEVER_MATCH,
  splitWordList,
  resolveWordList,
  buildWordRegex,
  validateWordRegex,
  resolveExtractSkipWords,
  matchRejectHits,
} from '../boss/skip-rules.mjs';

test('splitWordList：数组 / 分隔符字符串 / 空值', () => {
  assert.deepEqual(splitWordList([' 外包 ', '猎头', '']), ['外包', '猎头']);
  assert.deepEqual(splitWordList('外包，猎头、FESCO\n代招'), ['外包', '猎头', 'FESCO', '代招']);
  assert.deepEqual(splitWordList('   '), []);
  assert.equal(splitWordList(undefined), null);
  assert.equal(splitWordList(42), null);
});

test('resolveWordList：显式空数组 = 关闭该规则，缺省才回落默认', () => {
  assert.deepEqual(resolveWordList(undefined, ['外包']), ['外包']);
  assert.deepEqual(resolveWordList([], ['外包']), [], '空数组必须保持为空（= 不跳词），不能被默认值补回');
  assert.deepEqual(resolveWordList('外包,猎头', ['x']), ['外包', '猎头']);

  const copy = resolveWordList(undefined, ['外包']);
  copy.push('新增');
  assert.deepEqual(resolveWordList(undefined, ['外包']), ['外包'], '默认值要返回副本，不能被调用方改坏');
});

test('buildWordRegex：空表 → null；非法正则 → null 不抛错；正则片段可用', () => {
  assert.equal(buildWordRegex([]), null);
  assert.equal(buildWordRegex(''), null);

  const re = buildWordRegex(['外包', '猎头']);
  assert.equal(re.test('某公司-人力外包'), true);
  assert.equal(re.test('正常数据科技'), false);

  // 含逗号的正则片段（{0,16}）必须原样生效——这也是控制台里按换行而不是按逗号拆分的原因
  const frag = buildWordRegex(['某[^\\n]{0,16}公司']);
  assert.equal(frag.test('某大型综合集团公司'), true);

  assert.equal(buildWordRegex(['数据(']), null, '非法正则返回 null，扫描照常继续（回落内置默认）');
  assert.equal(NEVER_MATCH.test('任何文本'), false);
});

test('validateWordRegex：把非法正则挡在控制台保存那一步', () => {
  assert.equal(validateWordRegex(['外包', '某[^\\n]{0,16}公司']), null);
  assert.match(String(validateWordRegex(['数据('])), /Invalid|regular expression/i);
  assert.equal(validateWordRegex([]), null, '空表合法（= 关闭规则）');
});

test('默认跳词表与迁移前的硬编码正则逐字等价', () => {
  const legacy = /外包|派遣|猎头|驻场|某[^\\n]{0,16}公司|催收|电催|贷后|信用卡逾期|纯销售|电话销售|不缴社保|无社保|大小周/;
  const built = buildWordRegex(DEFAULT_SKIP_WORDS);
  assert.ok(built, '默认跳词表必须能编译成正则');

  const samples = [
    '人力外包公司', '派遣员工', '猎头顾问', '驻场开发', '某大型综合集团公司', '催收专员', '电催',
    '贷后管理', '信用卡逾期提醒', '纯销售岗', '电话销售', '不缴社保', '无社保', '大小周',
    '正常数据科技', '某公司', '某科技公司', 'FESCO 代招', '大数据开发工程师', '某大型综合集团',
  ];
  for (const sample of samples) {
    assert.equal(built.test(sample), legacy.test(sample), `样本「${sample}」在新旧规则下必须一致`);
  }
});

test('默认风险词 / 排队排除表非空且可用', () => {  for (const [name, list] of [
    ['DEFAULT_RISK_KEYWORDS', DEFAULT_RISK_KEYWORDS],
    ['DEFAULT_TITLE_EXCLUDE', DEFAULT_TITLE_EXCLUDE],
    ['DEFAULT_COMPANY_EXCLUDE', DEFAULT_COMPANY_EXCLUDE],
  ]) {
    assert.ok(Array.isArray(list) && list.length > 0, `${name} 不应为空`);
    for (const w of list) assert.equal(typeof w, 'string', `${name} 的元素必须是字符串`);
  }

  assert.equal(buildWordRegex(DEFAULT_TITLE_EXCLUDE).test('2026届校招-数据开发'), true);
  assert.equal(buildWordRegex(DEFAULT_TITLE_EXCLUDE).test('高级大数据开发工程师'), false);
  assert.equal(buildWordRegex(DEFAULT_COMPANY_EXCLUDE).test('外企德科人力资源服务'), true);
  assert.equal(buildWordRegex(DEFAULT_COMPANY_EXCLUDE).test('某某数据科技有限公司'), false);
});

test('reject 拆分：城市名按岗位城市匹配，其它词仍按标题+正文匹配', () => {
  const cityWords = ['北京', '上海', '广州', '深圳', '杭州'];
  // 杭州岗位，JD 里提到「北京/上海/杭州」——这是 2026-10-14 误伤 15 条杭州岗位的场景
  const hangzhou = matchRejectHits({
    reject: ['北京', '深圳', '广州', '海外'],
    cityWords,
    titleAndDesc: '高级大数据开发工程师（北京/上海/杭州）\n岗位职责：与北京团队协作…',
    city: '杭州·滨江区·长河',
  });
  assert.deepEqual(hangzhou.cityHits, [], '杭州岗位不该因为 JD 提到北京而被判城市排除');
  assert.deepEqual(hangzhou.textHits, [], '北京不是在正文里当风险词比对的');

  // 真正的北京岗位：按城市命中
  const beijing = matchRejectHits({
    reject: ['北京', '深圳'],
    cityWords,
    titleAndDesc: '数据开发工程师',
    city: '北京·朝阳区',
  });
  assert.deepEqual(beijing.cityHits, ['北京']);
  assert.deepEqual(beijing.textHits, []);

  // 非城市词（海外/外包）仍按正文匹配
  const text = matchRejectHits({
    reject: ['海外', '外包'],
    cityWords,
    titleAndDesc: '海外数据开发经理（出差阿联酋）',
    city: '杭州',
  });
  assert.deepEqual(text.textHits, ['海外']);
  assert.deepEqual(text.cityHits, []);

  // 边界：空值/空白/城市字段为空
  assert.deepEqual(matchRejectHits({}), { textHits: [], cityHits: [] });
  assert.deepEqual(
    matchRejectHits({ reject: ['  ', null, '北京'], cityWords, titleAndDesc: '', city: '' }),
    { textHits: [], cityHits: [] },
    '城市字段为空时不应命中城市排除',
  );
});

test('提取跳词解析：env > DB > 内置默认，且 DB 挂了不影响扫描', async () => {
  const fromEnv = await resolveExtractSkipWords({
    envValue: '外包\n某[^\\n]{0,16}公司',
    loadControl: async () => ({ skip_words: ['不该生效'] }),
  });
  assert.deepEqual(fromEnv.words, ['外包', '某[^\\n]{0,16}公司'], 'env 按换行拆，保留 {0,16} 里的逗号');
  assert.match(fromEnv.source, /env/);

  const fromDb = await resolveExtractSkipWords({
    envValue: '',
    loadControl: async () => ({ skip_words: ['猎头', '代招'] }),
  });
  assert.deepEqual(fromDb.words, ['猎头', '代招']);
  assert.match(fromDb.source, /DB/);

  const clearedInConsole = await resolveExtractSkipWords({ loadControl: async () => ({ skip_words: [] }) });
  assert.deepEqual(clearedInConsole.words, [], '控制台清空跳词表后必须真的是「不跳词」');

  const dbDown = await resolveExtractSkipWords({
    loadControl: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.deepEqual(dbDown.words, DEFAULT_SKIP_WORDS, 'DB 不可用回落内置默认');
  assert.match(dbDown.error, /ECONNREFUSED/, 'DB 失败原因要带回给调用方打日志');
});
