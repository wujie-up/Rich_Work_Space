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

test('heartbeat failures report Agent connectivity and preserve the actual cause', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const methods = new Map();
  let emitted;
  const received = new Promise(resolve => { emitted = resolve; });
  await activate({ services: { discover: async () => [{ pluginId: 'agent' }], invoke: async (_provider, input) => {
    if (input.action === 'configure' && ++attempts > 1) { throw Error('目标对话不属于指定窗口'); }
    return { enabled: true };
  } }, emit: (_channel, event) => emitted(event),
  methods: { register: (name, handler) => methods.set(name, handler) },
  views: { register() {} }, lifecycle: { register() {} } });
  let attempts = 0;
  t.after(deactivate);
  await methods.get('capture.configure')({ enabled: true,
    target: { pluginId: 'agent', instanceId: 'instance', windowId: 'window', conversationId: 'session' } });
  t.mock.timers.tick(5000);
  const event = await received;
  assert.equal(event.type, 'capture.unavailable');
  assert.equal(event.message, '目标对话不属于指定窗口');
});
