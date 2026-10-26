import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { MessageTriggers } from '../src/main/common/message-triggers.js';
import { MessageConnections } from '../src/main/common/message-connections.js';
import { MessageQueue } from '../src/main/common/message-queue.js';
import { Workflows } from '../src/main/common/workflows.js';
import { Engine } from '../src/main/common/engine.js';
import { Runs } from '../src/main/common/runs.js';
import { createRegistry } from '../src/main/common/nodes.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 600; i++) {
    if (await check()) { return; }
    await wait(10);
  }
  assert.fail('等待消息运行超时');
}
const message = (connectionId, messageId = 'msg') => ({ channel: 'wechat', connectionId, messageId,
  chat: { id: 'chat', type: 'private', name: '' }, sender: { id: 'user', name: '' }, text: 'ERROR test', sentAt: Date.now() });
async function harness(t, agents = {}) {
  let cleanupStore;
  const storage = await temporaryStore({ after: cleanup => { cleanupStore = cleanup; } });
  const pluginId = 'work-flow';
  const connections = new MessageConnections({ storage, pluginId });
  const queue = new MessageQueue({ storage, pluginId });
  const registry = createRegistry({ credentials: {} });
  const workflows = new Workflows({ storage, pluginId, classify: type => registry.list().find(item => item.type === type) });
  const instances = [];
  const engine = new Engine({ registry, runs: new Runs({ storage, pluginId }), agents, credentials: {}, pluginId,
    logger() {}, emit(channel, run) { if (channel === 'runs.changed') { triggers.changed(run); } } });
  const receivers = { wechat: options => {
    const instance = { options, stopped: false, async start() { options.onStatus({ state: 'connected' }); },
      async stop() { this.stopped = true; } };
    instances.push(instance);
    return instance;
  } };
  const triggers = new MessageTriggers({ connections, queue, workflows, engine, storage, pluginId, receivers, logger() {}, emit() {} });
  t.after(async () => {
    await triggers.stop();
    await engine.stop('test');
    await cleanupStore();
  });
  const connection = await connections.save({ name: '微信', channel: 'wechat', token: 'private-token' });
  const save = async (name, extra = []) => workflows.save({ name, trigger: { mode: 'message', enabled: true },
    nodes: [{ id: 'source', type: 'message.wechat', params: { connectionId: connection.id } }, ...extra],
    edges: extra.map(node => ({ from: 'source', to: node.id })) });
  return { storage, connections, queue, workflows, instances, engine, triggers, connection, save };
}

test('共享连接只创建一个监听，串行派发各工作流，断开后不接收且队列保留', async t => {
  const h = await harness(t);
  const a = await h.save('A');
  const b = await h.save('B');
  await h.triggers.refresh();
  assert.equal(h.instances.length, 1);
  await Promise.all([h.instances[0].options.onMessage(message(h.connection.id)), h.instances[0].options.onMessage(message(h.connection.id))]);
  await until(async () => (await h.queue.list()).filter(item => item.status === 'succeeded').length === 2);
  assert.equal((await h.queue.list(a.id)).length, 1);
  assert.equal((await h.queue.list(b.id)).length, 1);
  assert.equal(h.triggers.status()[0].accepted, 2);
  assert.equal(h.triggers.status()[0].ignored, 2);
  assert.equal(h.triggers.status()[0].rejected, 0);
  await h.triggers.disconnect(h.connection.id);
  assert.equal(h.instances[0].stopped, true);
  await h.instances[0].options.onMessage(message(h.connection.id, 'late'));
  assert.equal((await h.queue.list()).length, 2);
  assert.equal(h.triggers.status()[0].state, 'paused');
  await h.triggers.refresh();
  assert.equal(h.instances.length, 1);
  await h.triggers.reconnect(h.connection.id);
  assert.equal(h.instances.length, 2);
  await h.workflows.save({ ...a, trigger: { mode: 'message', enabled: false } });
  await h.workflows.save({ ...b, trigger: { mode: 'message', enabled: false } });
  await h.triggers.refresh();
  assert.equal(h.instances[1].stopped, true);
});

test('后台独占续跑消息 Agent，保留问题与人工节点，同一工作流按 FIFO', async t => {
  let starts = 0;
  let reads = 0;
  let approved = false;
  const agents = { async run(request) {
    if (!request.taskKey) { starts++; request.taskKey = 'task'; }
    reads++;
    return approved ? { state: 'succeeded', output: '完成' }
      : { state: 'waiting', requests: [{ id: 'approval', kind: 'approval' }] };
  }, async cancel() {} };
  const h = await harness(t, agents);
  const a = await h.save('Agent', [{ id: 'agent', type: 'agent.review', params: { input: '{{source.text}}' } }]);
  await h.triggers.refresh();
  await h.instances[0].options.onMessage(message(h.connection.id, 'one'));
  await h.instances[0].options.onMessage(message(h.connection.id, 'two'));
  await until(() => starts === 1);
  assert.equal((await h.queue.list(a.id)).filter(item => item.status === 'pending').length, 1);
  await wait(1100);
  assert.equal(starts, 1);
  assert.ok(reads <= 3, '每秒最多一次续查');
  const first = (await h.queue.list(a.id))[0];
  assert.equal(h.engine.get(first.runId).pending.task.requests[0].id, 'approval');
  approved = true;
  await until(async () => (await h.queue.list(a.id)).every(item => item.status === 'succeeded'));
  assert.equal(starts, 2);
  assert.deepEqual((await h.queue.list(a.id)).map(item => item.message.messageId), ['one', 'two']);
});

test('测试连接不触发工作流，替换旧连接后迟到回调失效，配置身份变化不转投', async t => {
  const h = await harness(t);
  await h.triggers.test(h.connection.id);
  await h.instances[0].options.onMessage(message(h.connection.id));
  assert.equal((await h.queue.list()).length, 0);
  await h.triggers.disconnect(h.connection.id);
  const a = await h.save('A');
  await h.triggers.reconnect(h.connection.id);
  await h.triggers.change(async () => {
    await h.connections.save({ ...h.connection, token: 'replacement' });
  }, h.connection.id);
  await h.instances[1].options.onMessage(message(h.connection.id, 'late'));
  assert.equal((await h.queue.list()).length, 0);
  await h.triggers.disconnect(h.connection.id);
  await h.queue.accept(a, a.nodes[0], message(h.connection.id, 'pending'));
  await h.workflows.save({ ...a, nodes: [{ ...a.nodes[0], id: 'replacement' }] });
  await h.triggers.reconnect(h.connection.id);
  await until(async () => (await h.queue.list())[0]?.status === 'invalid');
  await h.triggers.retry((await h.queue.list())[0].id);
  await until(async () => (await h.queue.list()).length === 2 && (await h.queue.list())[1].status === 'invalid');
});

test('停止阻断回调和派发，取消任务后队列可继续，未启用队列保持待执行', async t => {
  const h = await harness(t, { run: async () => ({ state: 'running' }), cancel: async () => {} });
  const a = await h.save('A', [{ id: 'agent', type: 'agent.review', params: { input: '{{source.text}}' } }]);
  await h.triggers.refresh();
  await h.instances[0].options.onMessage(message(h.connection.id, 'one'));
  await h.instances[0].options.onMessage(message(h.connection.id, 'two'));
  await until(async () => (await h.queue.list())[0]?.runId && h.engine.get((await h.queue.list())[0].runId).status === 'waiting');
  await h.engine.cancel((await h.queue.list())[0].runId);
  await until(async () => (await h.queue.list())[1]?.status === 'claimed');
  await h.triggers.stop();
  await h.instances[0].options.onMessage(message(h.connection.id, 'late'));
  await h.engine.stop('test');
  assert.equal((await h.queue.list()).length, 2);
  await h.queue.recover();
  assert.equal((await h.queue.list())[1].status, 'interrupted');
  assert.equal((await h.queue.list(a.id))[0].status, 'canceled');
});

test('人工节点不被后台确认，停用只保留队列，重新启用继续', async t => {
  const h = await harness(t);
  const original = h.engine.registry.get;
  h.engine.registry.get = type => type === 'test.manual' ? { manual: true, timeoutMs: 1000,
    prepare: async () => ({ stage: 'confirm' }), confirm: async () => ({ confirmed: true }) } : original(type);
  const a = await h.save('人工', [{ id: 'confirm', type: 'test.manual', params: {} }]);
  await h.triggers.refresh();
  await h.instances[0].options.onMessage(message(h.connection.id, 'manual'));
  await until(async () => {
    const item = (await h.queue.list())[0];
    return item?.runId && h.engine.get(item.runId).pending?.kind === 'manual';
  });
  const first = (await h.queue.list())[0];
  await wait(1100);
  assert.equal(h.engine.get(first.runId).status, 'waiting');
  await h.workflows.save({ ...a, trigger: { mode: 'message', enabled: false } });
  await h.triggers.refresh();
  await h.queue.accept(a, a.nodes[0], message(h.connection.id, 'held'));
  await h.engine.complete(first.runId, 'confirm', {});
  await wait(1100);
  assert.equal((await h.queue.list())[1].status, 'pending');
  await h.workflows.save(a);
  await h.triggers.refresh();
  await until(async () => (await h.queue.list())[1].status === 'claimed');
});


test('坏连接与错误渠道订阅不阻断有效连接恢复，首次运行落盘失败后下一条仍能执行', async t => {
  const h = await harness(t);
  const valid = await h.save('正常');
  const missing = await h.save('连接缺失');
  const wrong = await h.save('渠道错误');
  const items = (await h.workflows.list()).map(item => item.id === missing.id
    ? { ...item, nodes: [{ ...item.nodes[0], params: { connectionId: 'missing' } }] }
    : item.id === wrong.id ? { ...item, nodes: [{ ...item.nodes[0], type: 'message.feishu' }] } : item);
  await h.storage.writeJson('plugin-data/work-flow/workflows.json', { version: 1, items });
  await h.triggers.refresh();
  assert.equal(h.instances.length, 1);
  assert.equal(h.triggers.status().filter(item => item.workflowId && item.state === 'error').length, 2);
  const append = h.engine.runs.append.bind(h.engine.runs);
  let failOnce = true;
  h.engine.runs.append = async (...args) => {
    if (failOnce) { failOnce = false; throw Error('disk unavailable'); }
    return append(...args);
  };
  await h.instances[0].options.onMessage(message(h.connection.id, 'fail'));
  await until(async () => (await h.queue.list(valid.id))[0]?.status === 'interrupted');
  assert.equal(Boolean(h.engine.activeRun(valid.id)), false);
  assert.equal(h.engine.records.size, 0);
  await h.instances[0].options.onMessage(message(h.connection.id, 'next'));
  await until(async () => (await h.queue.list(valid.id))[1]?.status === 'succeeded');
  assert.equal((await h.queue.list()).length, 2, '错误渠道不能收到有效渠道消息');
});

test('连接展示订阅数、忽略拒收与接收摘要，队列写失败不计成功接收', async t => {
  const h = await harness(t);
  await h.save('正常');
  await h.triggers.refresh();
  const options = h.instances[0].options;
  options.onActivity({ kind: 'ignored', reason: 'non-text' });
  options.onActivity({ kind: 'rejected', reason: 'oversize' });
  await options.onMessage(message(h.connection.id, 'ok'));
  await until(async () => (await h.queue.list())[0]?.status === 'succeeded');
  let status = h.triggers.status()[0];
  assert.equal(status.subscriptions, 1);
  assert.equal(status.received, 1);
  assert.equal(status.accepted, 1);
  assert.equal(status.ignored, 1);
  assert.equal(status.rejected, 1);
  assert.equal(status.lastMessage.messageId, 'ok');
  h.queue.accept = async () => { throw Error('disk'); };
  await assert.rejects(options.onMessage(message(h.connection.id, 'fail')));
  status = h.triggers.status()[0];
  assert.equal(status.received, 1);
  assert.equal(status.accepted, 1);
  assert.equal(status.lastMessage.messageId, 'ok');
});


test('队列满的拒收累计不受有限历史裁剪影响，连接初始化失败仅影响该连接', async t => {
  const h = await harness(t);
  await h.save('正常');
  const broken = await h.connections.save({ name: '初始化失败', channel: 'wechat', token: 'broken' });
  const factory = h.triggers.receivers.wechat;
  h.triggers.receivers = { wechat: options => {
    if (options.connection.id === broken.id) { throw Error('SDK setup failed'); }
    return factory(options);
  } };
  await h.triggers.test(broken.id);
  await h.triggers.refresh();
  assert.equal(h.triggers.status().find(item => item.connectionId === broken.id).state, 'error');
  h.engine.activeRun = () => true;
  for (let i = 0; i < 125; i++) {
    await h.instances[0].options.onMessage(message(h.connection.id, `full-${i}`));
  }
  const status = h.triggers.status().find(item => item.connectionId === h.connection.id);
  assert.equal(status.accepted, 100);
  assert.equal(status.rejected, 25);
  assert.equal(status.lastIssue, 'queue-full');
  assert.equal((await h.queue.list()).filter(item => item.status === 'rejected').length, 20);
});
