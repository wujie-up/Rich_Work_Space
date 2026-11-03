import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/shared/scores.js';

test('decimal totals distinguish zero, missing and invalid scores and follow the selected state', () => {
  const rows = [0.1, '0.2', 0, null, '', false, 'no', {}, '1e-3'].map((score, i) =>
    ({ id: String(i), score, stateId: i < 3 ? 'done' : 'open' }));
  assert.deepEqual(summarize(rows), { rows, total: '0.301', scored: 4, missing: 2, invalid: 3 });
  assert.equal(summarize(rows, 'done').total, '0.3');
  assert.equal(summarize(rows, 'done').rows.length, 3);
  assert.equal(summarize([{ score: '1.25' }, { score: '-0.25' }]).total, '1');
  assert.equal(summarize([{ score: Infinity }, { score: '1e99999' }]).invalid, 2);
  assert.equal(summarize([]).total, '0');
});
