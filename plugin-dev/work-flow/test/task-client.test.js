import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskClient } from '../src/main/common/task-client.js';

test('取消启动会撤销等待中的宿主能力审批，已取消信号不会发起新调用', async () => {
  const controller = new AbortController();
  const cancelled = [];
  let invocations = 0;
  const client = new TaskClient({
    discover: async () => ({ providers: [{ state: 'ready', descriptor: { id: 'agent.menu.code.start.v1' }, handle: { pluginId: 'ai' } }] }),
    invoke: async () => { invocations++; return { invocationId: 'pending' }; },
    getInvocation: async () => { controller.abort(); return { state: 'awaiting_approval' }; },
    cancel: async id => cancelled.push(id)
  });
  await assert.rejects(client.call('agent.menu.code.start.v1', {}, { signal: controller.signal }), /abort/i);
  assert.deepEqual(cancelled, ['pending']);
  await assert.rejects(client.call('agent.menu.code.start.v1', {}, { signal: controller.signal }), /abort/i);
  assert.equal(invocations, 1);
});
