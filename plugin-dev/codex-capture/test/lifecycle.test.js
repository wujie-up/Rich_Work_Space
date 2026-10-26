import test from 'node:test';
import assert from 'node:assert/strict';
import { activate, deactivate } from '../src/main/common/index.js';

test('viewer has no transport or upstream and gracefully handles an old AI plugin', async t => {
  const methods = new Map();
  let lifecycle;
  await activate({ services: { discover: async () => [] }, emit() {},
    methods: { register: (name, handler) => methods.set(name, handler) },
    views: { register: view => assert.equal(view.title, 'Agent 抓包') }, lifecycle: { register: value => { lifecycle = value; } } });
  t.after(deactivate);
  assert.deepEqual(await methods.get('capture.sources')(), []);
  assert.equal((await methods.get('capture.status')()).state, 'unselected');
  assert.equal(methods.has('capture.route'), false);
  assert.deepEqual(lifecycle.snapshot(), []);
  await lifecycle.stop();
});
