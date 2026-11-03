import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskClient } from '../src/main/common/task-client.js';

test('输入超限显示实际长度与上限，兼容旧提供方和宿主字节限制且不发起调用', async () => {
  let inputSchema = { properties: { prompt: { maxLength: 90000 } } };
  const client = new TaskClient({
    discover: async () => ({ providers: [{ state: 'ready', descriptor: { id: 'start', inputSchema }, handle: { pluginId: 'ai' } }] }),
    invoke: async () => assert.fail('超限输入不应进入能力调用')
  });
  await assert.rejects(client.call('start', { prompt: '文'.repeat(92447) }), error =>
    error.code === 'AGENT_INPUT_TOO_LARGE' && /节点输入超限/.test(error.message) && /92447/.test(error.message) && /90000/.test(error.message));
  inputSchema = {};
  const input = { prompt: '文'.repeat(350000) };
  await assert.rejects(client.call('start', input), error => error.code === 'AGENT_INPUT_TOO_LARGE'
    && error.message.includes(String(Buffer.byteLength(JSON.stringify(input)))) && error.message.includes('1048576'));
});

test('人工审批超过原调用时限后仍可批准并取得执行结果', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let polls = 0;
  const client = new TaskClient({
    discover: async () => ({ providers: [{ state: 'ready', descriptor: { id: 'start' }, handle: { pluginId: 'ai' } }] }),
    invoke: async () => ({ invocationId: 'pending' }),
    getInvocation: async () => {
      t.mock.timers.tick(30000);
      polls++;
      return polls < 3 ? { state: 'queued', approvalRequired: true } : { state: 'succeeded', result: 'started' };
    },
    cancel: async () => assert.fail('审批等待不应触发取消')
  });
  assert.equal(await client.call('start', {}), 'started');
  assert.equal(polls, 3);
});

test('执行超时和审批拒绝仍终止调用并清理宿主任务', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const cancelled = [];
  let result = { state: 'running' };
  const client = new TaskClient({
    discover: async () => ({ providers: [{ state: 'ready', descriptor: { id: 'start' }, handle: { pluginId: 'ai' } }] }),
    invoke: async () => ({ invocationId: 'pending' }),
    getInvocation: async () => {
      t.mock.timers.tick(30000);
      return result;
    },
    cancel: async id => cancelled.push(id)
  });
  await assert.rejects(client.call('start', {}), /超时/);
  result = { state: 'cancelled' };
  await assert.rejects(client.call('start', {}), /未完成/);
  assert.deepEqual(cancelled, ['pending', 'pending']);
});

test('执行等待遵循宿主截止时间，不再提前使用固定二十八秒取消', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let polls = 0;
  const client = new TaskClient({
    discover: async () => ({ providers: [{ state: 'ready', descriptor: { id: 'start' }, handle: { pluginId: 'ai' } }] }),
    invoke: async () => ({ invocationId: 'running' }),
    getInvocation: async () => {
      polls++;
      t.mock.timers.tick(30000);
      return polls === 1 ? { state: 'running', deadline: 170000 } : { state: 'succeeded', result: 'done' };
    },
    cancel: async () => assert.fail('宿主截止前不应取消')
  });
  assert.equal(await client.call('start', {}), 'done');
});

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
