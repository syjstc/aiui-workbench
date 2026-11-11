import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';
import en from '../shared/locales/en.json' with { type: 'json' };
import { resolveLocale, getLocale, setLocale, subscribeLocale, t, translateMessage } from '../shared/i18n.mjs';

test('explicit language wins and system languages choose Chinese or English', () => {
  assert.equal(resolveLocale('en', ['zh-CN']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('invalid', ['zh-Hans-CN']), 'zh-CN');
  assert.equal(resolveLocale(null, ['en-GB']), 'en');
  assert.equal(resolveLocale(null, ['de-DE']), 'en');
});
test('language changes notify immediately and interpolate values without altering project names', () => {
  const previous = getLocale(); let changes = 0;
  const unsubscribe = subscribeLocale(() => changes++);
  try {
    setLocale('zh-CN'); const before = changes; setLocale('en'); assert.equal(changes, before + 1);
    assert.equal(t('项目库'), 'Projects');
    assert.equal(t('设备尾号 {0}', { 0: '中文项目 123' }), 'Serial suffix 中文项目 123');
    assert.equal(translateMessage('更新源请求失败：HTTP 404'), 'Update source request failed: HTTP 404');
    assert.equal(translateMessage('构建工具不可用：ENOENT'), 'Build tools unavailable: ENOENT');
    assert.equal(translateMessage('用户项目名字'), '用户项目名字');
    setLocale('zh-CN'); assert.equal(t('项目库'), '项目库');
  } finally { unsubscribe(); setLocale(previous); }
});
test('all translated UI messages have complete English entries and matching placeholders', async () => {
  const missing = [];
  function visit(node, file) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.name === 't' && typeof node.arguments?.[0]?.value === 'string') {
      const key = node.arguments[0].value;
      if (/[\u3400-\u9fff]/.test(key) && !Object.hasOwn(en, key)) missing.push(file + ': ' + key);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(item => visit(item, file)); else if (value && typeof value === 'object') visit(value, file);
  }
  for (const file of await fs.readdir(new URL('../renderer/', import.meta.url))) {
    if (!/\.(jsx|mjs|js)$/.test(file)) continue;
    const parsed = parseSync(file, await fs.readFile(new URL('../renderer/' + file, import.meta.url), 'utf8'), { sourceType: 'module' });
    assert.deepEqual(parsed.errors, [], file); visit(parsed.program, file);
  }
  assert.deepEqual(missing, []);
  for (const [source, translation] of Object.entries(en)) {
    assert.ok(translation, source);
    assert.equal(/[\u3400-\u9fff]/.test(translation), false, source);
    const slots = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort();
    assert.deepEqual(slots(translation), slots(source), source);
  }
});
