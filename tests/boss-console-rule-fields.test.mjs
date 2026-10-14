// tests/boss-console-rule-fields.test.mjs — 控制台规则表字段必须是多行 textarea
//
// 页面用 list.join('\n') 回填这四张规则表。如果元素是单行 <input>，浏览器会把换行吞掉：
// 6 条规则显示成粘在一起的一条（校招应届实习秋招春招毕业生），保存时 splitRuleText 又把它
// 当成一条写回 DB —— 2026-10-14 实际发生过：校园过滤静默失效，用户看到的就是那串粘在一起的词。
//
// Run: node test-all.mjs --only boss-console-rule-fields

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { splitRuleText } from '../boss/skip-rules.mjs';

const html = readFileSync(join(ROOT, 'boss', 'boss-web', 'index.html'), 'utf-8');
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
