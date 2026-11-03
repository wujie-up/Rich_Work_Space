import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryJobs } from '../src/main/common/jobs.js';

async function finished(jobs, id) {
  for (let i = 0; i < 50; i++) {
    const state = jobs.status(id);
    if (state.state !== 'running') { return state; }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw Error('job did not finish');
}

test('jobs expose complete data only and bind the settings snapshot at start', async () => {
  let valueKey = 'old';
  const jobs = new QueryJobs({ snapshot: async () => ({ valueKey }) }, { clientFactory: config => ({
    tasks: async ({ onProgress, role, month, dateField }) => {
      assert.equal(role, 'developer');
      assert.match(month, /^\d{4}-\d{2}$/);
      assert.equal(dateField, 'completedAt');
      onProgress({ loaded: 1, total: 2 });
      await new Promise(resolve => setTimeout(resolve, 3));
      return [{ score: config.valueKey }];
    }
  }) });
  const { id } = await jobs.start({ kind: 'tasks', assigneeId: 'one', role: 'developer' });
  valueKey = 'new';
  assert.equal(jobs.status(id).result, undefined);
  assert.deepEqual((await finished(jobs, id)).result, [{ score: 'old' }]);
  await jobs.stop();
});

test('failed page, cancellation, unknown jobs and stopped lifecycle are explicit', async () => {
  const jobs = new QueryJobs({ snapshot: async () => ({}) }, { clientFactory: () => ({
    tasks: async ({ onProgress }, signal) => {
      onProgress({ loaded: 1, total: 2 });
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    },
    projects: async () => { throw Object.assign(Error('safe error'), { code: 'FORBIDDEN' }); }
  }) });
  const failure = await jobs.start({ kind: 'projects' });
  assert.equal((await finished(jobs, failure.id)).state, 'failed');
  assert.equal(jobs.status(failure.id).result, undefined);
  const { id } = await jobs.start({ kind: 'tasks', assigneeId: 'p' });
  jobs.cancel(id);
  assert.equal((await finished(jobs, id)).state, 'cancelled');
  assert.equal(jobs.status(id).result, undefined);
  const active = await jobs.start({ kind: 'tasks', assigneeId: 'p' });
  await jobs.stop();
  assert.equal(jobs.status(active.id).state, 'cancelled');
  await assert.rejects(jobs.start({ kind: 'projects' }), /停止/);
  assert.throws(() => jobs.status('absent'), /查询/);
});
