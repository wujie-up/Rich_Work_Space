import test from 'node:test';
import assert from 'node:assert/strict';
import { currentMonth, filterTasks } from '../src/shared/month-filter.js';
import { summarize } from '../src/shared/scores.js';

test('completion is the default basis; local calendar month uses an inclusive start and exclusive next month', () => {
  const start = new Date(2026, 9, 1).getTime() / 1000;
  const end = new Date(2026, 10, 1).getTime() / 1000;
  const rows = [
    { id: 'before', completedAt: start - 1, createdAt: start + 10, score: 9 },
    { id: 'first', completedAt: start, createdAt: start - 1, score: 0.1 },
    { id: 'last', completedAt: end - 1, createdAt: end, score: '0.2' },
    { id: 'next', completedAt: end, createdAt: start + 10, score: 8 },
    { id: 'unfinished', completedAt: null, createdAt: start + 10, score: 5 },
    { id: 'missing', score: 3 }
  ];
  const completed = filterTasks(rows, { month: '2026-10' });
  assert.deepEqual(completed.map(row => row.id), ['first', 'last']);
  assert.equal(summarize(completed).total, '0.3');
  assert.deepEqual(filterTasks(rows, { month: '2026-10', dateField: 'createdAt' }).map(row => row.id),
    ['before', 'next', 'unfinished']);
  assert.equal(filterTasks(rows, { month: '' }).length, rows.length);
  assert.throws(() => filterTasks(rows, { month: '2026-13' }), /月份/);
  assert.throws(() => filterTasks(rows, { month: '2026-10', dateField: 'other' }), /时间/);
});

test('current month and year transitions are based on the user local calendar', () => {
  assert.equal(currentMonth(new Date(2027, 0, 1)), '2027-01');
  assert.equal(currentMonth(new Date(2026, 11, 31)), '2026-12');
  const rows = [{ completedAt: new Date(2027, 0, 1).getTime() / 1000, score: 1 }];
  assert.equal(filterTasks(rows, { month: '2026-12' }).length, 0);
  assert.equal(filterTasks(rows, { month: '2027-01' }).length, 1);
});
