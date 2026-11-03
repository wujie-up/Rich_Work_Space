import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageBridge } from '../src/main/common/service.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

const envelope = { channelId: 'feishu-test', messageId: 'message-1', chatId: 'room', chatType: 'group', senderId: 'alice',
  text: '/agent hello', sentAt: 1000, replyContext: { messageId: 'message-1' } };
const route = { id: 'route-1', name: 'test', enabled: true, channelId: 'feishu-test', chatIds: ['room'], senderIds: ['alice'], priority: 1,
  scope: 'sender', trigger: { type: 'prefix', value: '/agent' }, target: { mode: 'dedicated', engineId: 'codex' }, executionPolicy: { mode: 'readOnly' } };

async function fixture(t, overrides = {}) {
  const storage = await temporaryStore(t);
  const calls = [];
  const deliveries = [];
  let answer;
  const agent = { ready: async () => true, authorize: async () => ({ state: 'granted' }), async call(method, input) {
    calls.push({ method, input });
    if (method === 'bind') { return { bindingId: 'binding-1', targetRef: { kind: 'conversation', id: 'context-1' } }; }
    if (method === 'submit') { return { taskId: input.requestKey, state: 'queued' }; }
    if (method === 'read') { return { taskId: input.taskId || input.requestKey, state: 'completed', output: answer || 'answer' }; }
    return { accepted: true };
  } };
  const transport = { start: async () => {}, stop: async () => {}, async send(delivery) { deliveries.push(delivery); return { messageId: 'reply-1' }; } };
  const service = new MessageBridge({ pluginId: 'message-bridge', storage, agent, now: () => 1000, emit() {},
    channelFactory: async () => transport, ...overrides });
  await service.load();
  await service.saveChannel({ id: 'feishu-test', name: 'test', type: 'feishu', appId: 'app', appSecret: 'secret', enabled: true });
  await service.saveRoute(route);
  t.after(() => service.stop());
  return { service, calls, deliveries, storage, transport, agent, output: value => { answer = value; } };
}

test('native channel config retains secrets, validates before replacement and preserves legacy providers', async t => {
  const { service } = await fixture(t);
  const saved = await service.saveChannel({ id: 'native', type: 'wechat', puppet: 'native', token: 'fixture-native-secret', enabled: false });
  assert.equal(saved.endpoint, '127.0.0.1:18401');
  assert.equal(saved.token, undefined);
  await service.saveChannel({ id: 'native', type: 'wechat', puppet: 'native', token: '', enabled: false });
  assert.equal(service.config.value.channels.find(channel => channel.id === 'native').token, 'fixture-native-secret');
  await assert.rejects(service.saveChannel({ id: 'native', type: 'wechat', puppet: 'native', endpoint: 'remote.test:18401' }), /本机网关地址/);
  assert.equal(service.snapshot().channels.find(channel => channel.id === 'native').endpoint, '127.0.0.1:18401');
  const web = await service.saveChannel({ id: 'legacy-web', type: 'wechat', enabled: false });
  const remote = await service.saveChannel({ id: 'legacy-service', type: 'wechat', token: 'fixture-service-secret', enabled: false });
  assert.equal(web.puppet, 'wechat4u');
  assert.equal(remote.puppet, 'service');
  assert.equal(JSON.stringify(service.snapshot()).includes('fixture-native-secret'), false);
});

test('simple rules persist without allowlists, reuse dedicated chats and return to the originating conversation', async t => {
  const { service, calls, deliveries, storage } = await fixture(t);
  await service.saveRoute({ id: 'simple', enabled: true, channelId: 'feishu-test', sourceMode: 'channel',
    trigger: { type: 'prefix', value: '@小微' }, target: route.target, executionPolicy: route.executionPolicy });
  for (const [id, chatId, senderId] of [['s1', 'new-room', 'bob'], ['s2', 'new-room', 'bob'], ['s3', 'another-room', 'bob']]) {
    await service.receive({ ...envelope, messageId: id, chatId, senderId, text: '@小微分析这段聊天\n甲：收到' });
    await service.tick();
  }
  assert.equal(new Set(calls.filter(call => call.method === 'bind').map(call => call.input.bindingKey)).size, 2);
  assert.ok(calls.filter(call => call.method === 'submit').every(call => call.input.text === '分析这段聊天\n甲：收到'));
  assert.deepEqual(deliveries.map(delivery => delivery.source.chatId), ['new-room', 'new-room', 'another-room']);
  const restored = new MessageBridge({ pluginId: 'message-bridge', storage, emit() {} });
  await restored.load();
  assert.equal(restored.snapshot().routes.find(item => item.id === 'simple').sourceMode, 'channel');
  await assert.rejects(service.saveRoute({ ...route, id: 'invalid-legacy', chatIds: [] }), /会话 ID/);
});

test('durable dedup routes once, reuses source binding and returns only to original chat', async t => {
  const { service, calls, deliveries } = await fixture(t);
  const first = await service.receive(envelope);
  assert.equal((await service.receive(envelope)).exchangeId, first.exchangeId);
  await service.tick();
  await service.tick();
  assert.equal(calls.filter(call => call.method === 'submit').length, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].source.chatId, 'room');
  assert.equal(deliveries[0].source.senderId, 'alice');
  assert.equal(deliveries[0].text, 'answer');
  await service.receive({ ...envelope, messageId: 'message-2' });
  await service.tick();
  assert.equal(new Set(calls.filter(call => call.method === 'bind').map(call => call.input.bindingKey)).size, 1);
  assert.equal(service.snapshot().exchanges.length, 2);
  assert.equal(JSON.stringify(service.snapshot()).includes('secret'), false);
});

test('rules reject unlisted senders before messages are persisted or executed', async t => {
  const { service, calls } = await fixture(t);
  assert.equal(await service.receive({ ...envelope, senderId: 'bob' }), null);
  assert.equal(await service.receive({ ...envelope, self: true }), null);
  await service.tick();
  assert.equal(calls.length, 0);
  assert.equal(service.snapshot().exchanges.length, 0);
});

test('uncertain send is never automatically repeated and explicit retry preserves fixed client IDs', async t => {
  const { service, deliveries, transport } = await fixture(t);
  transport.send = async delivery => { deliveries.push(delivery); throw Error('connection lost after send'); };
  await service.receive(envelope);
  await service.tick();
  await service.tick();
  await service.tick();
  assert.equal(deliveries.length, 1);
  const receipt = service.snapshot().deliveries[0];
  assert.equal(receipt.state, 'uncertain');
  await service.retryDelivery(receipt.id, true);
  await service.tick();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].clientId, deliveries[1].clientId);
});

test('question replies are scoped to channel/chat/sender and never grant local permissions', async t => {
  const { service, agent, calls, deliveries } = await fixture(t);
  const original = agent.call.bind(agent);
  agent.call = async (method, input) => method === 'read' ? { taskId: input.taskId, state: 'waiting_input', localApproval: true,
    questions: [{ requestId: 'question-id', questions: [{ id: 'scope', question: 'Which scope?' }] }] } : original(method, input);
  await service.receive(envelope);
  await service.tick();
  await service.tick();
  const question = service.snapshot().exchanges[0].pendingQuestion;
  assert.ok(deliveries.some(item => item.text.includes('Which scope?')));
  assert.equal(await service.receive({ ...envelope, messageId: 'bad', senderId: 'bob', text: `/reply ${question.token} scope=all` }), null);
  await service.receive({ ...envelope, messageId: 'answer', text: `/reply ${question.token} scope=this` });
  await service.tick();
  const response = calls.find(call => call.method === 'respond');
  assert.equal(response.input.requestId, 'question-id');
  assert.deepEqual(response.input.answers, { scope: 'this' });
  assert.equal(response.input.decision, undefined);
});

test('close and unbind discard pending outbound work while pause permits already accepted work', async t => {
  const { service, deliveries } = await fixture(t);
  await service.receive(envelope);
  await service.saveRoute({ ...route, enabled: false });
  await service.tick();
  assert.equal(deliveries.length, 1);
  await service.saveRoute(route);
  await service.receive({ ...envelope, messageId: 'another' });
  await service.unbindRoute(route.id);
  await service.tick();
  assert.equal(deliveries.length, 1);
  const exchange = service.snapshot().exchanges.find(item => item.source.messageId === 'another');
  assert.equal(exchange.closed, true);
});

test('persist failure refuses acknowledgement and cannot submit the source message', async t => {
  const { service, storage, calls } = await fixture(t);
  const original = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw Error('disk full'); };
  await assert.rejects(service.receive(envelope), /disk full/);
  storage.writeJson = original;
  await service.tick();
  assert.equal(calls.length, 0);
});

test('normal stop persists closed exchanges so restart never sends their old results', async t => {
  const { service, storage, agent, deliveries } = await fixture(t);
  await service.receive(envelope);
  await service.stop();
  const reopened = new MessageBridge({ pluginId: 'message-bridge', storage, agent, now: () => 1000, emit() {},
    channelFactory: async () => ({ start: async () => {}, stop: async () => {}, send: async value => { deliveries.push(value); } }) });
  await reopened.load();
  await reopened.tick();
  assert.equal(deliveries.length, 0);
  assert.equal(reopened.snapshot().exchanges[0].closed, true);
  await reopened.stop();
});

test('crash recovery reclaims a binding before reading an accepted request and never resubmits', async t => {
  const { service, storage, agent, calls, deliveries } = await fixture(t);
  const original = agent.call.bind(agent);
  agent.call = async (method, input) => method === 'read' ? { taskId: input.taskId, state: 'running' } : original(method, input);
  await service.receive(envelope);
  await service.tick();
  const recovered = new MessageBridge({ pluginId: 'message-bridge', storage, agent, now: () => 1000, emit() {},
    channelFactory: async () => ({ start: async () => {}, stop: async () => {}, send: async value => { deliveries.push(value); } }) });
  await recovered.load();
  calls.length = 0;
  agent.call = original;
  await recovered.tick();
  assert.equal(calls[0].method, 'bind');
  assert.equal(calls.filter(item => item.method === 'submit').length, 0);
  assert.equal(deliveries.length, 1);
  await recovered.stop();
});

test('authorization loss closes external exchanges before a later grant can deliver them', async t => {
  const { service, agent, deliveries } = await fixture(t);
  const original = agent.call.bind(agent);
  agent.call = async (method, input) => method === 'read' ? { taskId: input.taskId, state: 'running' } : original(method, input);
  await service.receive(envelope);
  await service.tick();
  agent.ready = async () => false;
  await service.tick();
  agent.ready = async () => true;
  agent.call = original;
  await service.tick();
  assert.equal(service.snapshot().exchanges[0].closed, true);
  assert.equal(deliveries.length, 0);
});

test('explicit bot re-login closes old source contexts and clears account credentials before scanning', async t => {
  const { service, transport } = await fixture(t);
  await service.saveChannel({ id: 'bot', type: 'weixin-bot', enabled: true, botToken: 'old', cursor: 'old-cursor', botId: 'old-account' });
  await service.saveRoute({ ...route, id: 'bot-route', channelId: 'bot' });
  await service.receive({ ...envelope, channelId: 'bot', chatType: 'private' });
  let scans = 0;
  transport.login = async () => { scans++; };
  await service.loginChannel('bot');
  const record = service.config.value.channels.find(item => item.id === 'bot');
  assert.equal(record.botToken, undefined);
  assert.equal(record.cursor, undefined);
  assert.equal(record.botId, undefined);
  assert.equal(service.snapshot().exchanges[0].closed, true);
  assert.equal(scans, 1);
});

test('closing an exchange while its transport connects cannot send a stale result', async t => {
  const { service, transport } = await fixture(t);
  let release;
  let connecting;
  const waiting = new Promise(resolve => { connecting = resolve; });
  service.transport = async () => { connecting(); await new Promise(resolve => { release = resolve; }); return transport; };
  await service.receive(envelope);
  const tick = service.tick();
  await waiting;
  await service.closeSource(() => true, 'authorization_revoked');
  release();
  await tick;
  assert.equal(service.snapshot().deliveries[0].state, 'cancelled');
});

test('disabling a channel while its source metadata is being saved refuses late admission', async t => {
  const { service, calls } = await fixture(t);
  const observe = service.observeSource.bind(service);
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  service.observeSource = async source => { entered(); await new Promise(resolve => { release = resolve; }); await observe(source); };
  const receiving = service.receive(envelope);
  await waiting;
  await service.saveChannel({ id: 'feishu-test', type: 'feishu', enabled: false });
  release();
  assert.equal(await receiving, null);
  await service.tick();
  assert.equal(calls.length, 0);
  assert.equal(service.snapshot().exchanges.length, 0);
});
