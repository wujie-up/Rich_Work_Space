import test from 'node:test';
import assert from 'node:assert/strict';
import { value, interpolate, resolveParams } from '../src/main/common/template.js';

test('循环输入优先采用最新稿，首次缺失时才使用原稿，保留原类型', () => {
  const variables = { original: { text: '原稿' }, loop: { previous: { revision: { output: { design: '最新稿' } } } } };
  const expression = '{{loop.previous.revision.output.design ?? original.text}}';
  assert.equal(value(expression, variables), '最新稿');
  assert.equal(value(expression, { original: variables.original }), '原稿');
  assert.equal(interpolate(`当前：${expression}`, variables), '当前：最新稿');
  assert.deepEqual(resolveParams({ input: expression }, variables), { input: '最新稿' });
  for (const selected of [0, false, '', [], { text: '完整稿' }]) {
    assert.deepEqual(value('{{latest ?? original.text}}', { ...variables, latest: selected }), selected);
  }
  assert.equal(value('{{latest ?? original.text}}', { ...variables, latest: null }), '原稿');
  assert.equal(value('{{missing ?? absent}}', variables), undefined);
  assert.equal(interpolate('{{missing ?? absent}}', variables), '');
  assert.equal(value('{{original.text}}', variables), '原稿');
  assert.equal(value('{{latest}}', { latest: null }), null, '保持单路径原有空值契约');
});
