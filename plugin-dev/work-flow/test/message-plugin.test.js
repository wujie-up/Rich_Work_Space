import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { activate, deactivate } from '../src/main/common/index.js';

test('消息 RPC 脱敏、引用检查、生命周期和旧数据兼容', async t => {
  const storage = await temporaryStore(t);
  const methods = new Map();
  let lifecycle;
  await storage.writeJson('plugin-data/work-flow/workflows.json', { version: 1, items: [{ id: 'old', name: '旧工作流', nodes: [], edges: [] }] });
  await activate({ pluginId: 'work-flow', storage, capabilities: {}, emit() {},
    methods: { register: (name, handler, options) => methods.set(name, { handler, options }) },
    services: { register() {} }, views: { register() {} }, lifecycle: { register: entry => { lifecycle = entry; } } });
  t.after(() => deactivate());
  const call = (name, input) => methods.get(name).handler(input);
  assert.ok((await call('workflows.list')).some(item => item.id === 'old'));
  assert.deepEqual(await call('credentials.list'), []);
  const c = await call('messages.connections.save', { name: '飞书', channel: 'feishu', appId: 'id', appSecret: 'hidden-key' });
  assert.equal(JSON.stringify(await call('messages.connections.list')).includes('hidden-key'), false);
  for (const connectionId of ['missing', c.id]) {
    await assert.rejects(call('workflows.save', { name: '错误连接', trigger: { mode: 'message', enabled: true },
      nodes: [{ id: 'source', type: 'message.wechat', params: { connectionId } }], edges: [] }), { code: 'INVALID_WORKFLOW' });
  }
  assert.equal((await call('workflows.list')).length, 1, '坏连接配置不能落盘');
  const workflow = await call('workflows.save', { name: '飞书接收', nodes: [{ id: 'source', type: 'message.feishu', params: { connectionId: c.id } }], edges: [] });
  await assert.rejects(call('messages.connections.remove', c.id), { code: 'CONNECTION_IN_USE' });
  await assert.rejects(call('runs.start', workflow.id), { code: 'MESSAGE_EVENT_REQUIRED' });
  await assert.rejects(call('runs.trigger', { version: 1, workflowId: workflow.id }), { code: 'MESSAGE_EVENT_REQUIRED' });
  for (const method of ['messages.connections.save', 'messages.connections.remove', 'messages.queue.clear', 'messages.queue.retry']) {
    assert.equal(methods.get(method).options.exclusive, true);
  }
  assert.deepEqual(await call('messages.queue.list', workflow.id), []);
  assert.deepEqual(lifecycle.snapshot(), []);
  await lifecycle.stop('test');
  assert.deepEqual(await call('messages.status'), []);
});


test('旧的坏连接订阅不会阻断插件激活，错误可通过状态修复', async t => {
  const storage = await temporaryStore(t);
  await storage.writeJson('plugin-data/work-flow/workflows.json', { version: 1, items: [{ id: 'broken', name: '缺失连接',
    trigger: { mode: 'message', enabled: true }, nodes: [{ id: 'source', type: 'message.wechat', params: { connectionId: 'missing' } }], edges: [] }] });
  const methods = new Map();
  await activate({ pluginId: 'work-flow', storage, capabilities: {}, emit() {},
    methods: { register: (name, handler) => methods.set(name, handler) }, services: { register() {} },
    views: { register() {} }, lifecycle: { register() {} } });
  t.after(() => deactivate());
  assert.equal((await methods.get('messages.status')())[0].workflowId, 'broken');
  assert.equal((await methods.get('messages.status')())[0].state, 'error');
  assert.deepEqual(await methods.get('triggers.next')(), [{ workflowId: 'broken', mode: 'message', enabled: true, nextAt: null }]);
  const broken = (await methods.get('workflows.list')())[0];
  await methods.get('workflows.save')({ ...broken, trigger: { mode: 'message', enabled: false } });
  assert.deepEqual(await methods.get('messages.status')(), []);
});
