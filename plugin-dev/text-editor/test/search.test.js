import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatch } from '../src/renderer/search.js';

test('literal search preserves Unicode source offsets and wraps in both directions', () => {
  assert.deepEqual(findMatch('😀A[b] a[B]', 'a[b]'), { start: 2, end: 6, index: 0, total: 2 });
  assert.deepEqual(findMatch('😀A[b] a[B]', 'a[b]', 1), { start: 7, end: 11, index: 1, total: 2 });
  assert.deepEqual(findMatch('😀A[b] a[B]', 'a[b]', 2), { start: 2, end: 6, index: 0, total: 2 });
  assert.deepEqual(findMatch('😀A[b] a[B]', 'a[b]', -1), { start: 7, end: 11, index: 1, total: 2 });
  assert.equal(findMatch('İ next', 'next').start, 2);
  assert.equal(findMatch('aaa', 'aa').total, 1);
  assert.equal(findMatch('abc', '').total, 0);
  assert.equal(findMatch('abc', 'missing').total, 0);
  assert.equal(findMatch('a.* a.*', '.*').total, 2);
  assert.equal(findMatch('x'.repeat(1024 * 1024), 'x').total, 1024 * 1024);
});
