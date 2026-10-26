import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWechatReceiver } from '../src/main/common/message-wechat.js';
import { createFeishuReceiver } from '../src/main/common/message-feishu.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const wechatMessage = (overrides = {}) => ({ id: 'm1', self: () => false, type: () => 7,
  talker: () => ({ id: 'u1', name: () => 'Alice' }), room: () => null,
  text: () => 'hello', date: () => new Date(100), ...overrides });
const feishuMessage = (overrides = {}) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'u1' } },
  message: { message_id: 'm1', chat_id: 'c1', chat_type: 'group', message_type: 'text', content: '{"text":"hello"}',
    create_time: '100', mentions: [{ key: '@_user_1', id: { open_id: 'bot1' } }], ...overrides } });

test('微信规范文本、过滤无效事件、停止后忽略迟到回调', async () => {
  const bot = new EventEmitter();
  bot.start = async () => {};
  bot.stop = async () => { bot.stopped = true; };
  const messages = [], statuses = [], logs = [];
  const receiver = createWechatReceiver({ connection: { id: 'wx', token: 'secret-token' }, dataDirectory: '/tmp/wx-test',
    onMessage: async message => messages.push(message), onStatus: status => statuses.push(status),
    logger: (...args) => logs.push(args), sdkFactory: async () => ({ bot, textType: 7, qr: async () => 'data:image/png;base64,abc' }) });
  await receiver.start();
  const late = bot.listeners('message')[0];
  bot.emit('message', wechatMessage());
  bot.emit('message', wechatMessage({ id: 'm2', room: () => ({ id: 'g1', topic: async () => '群' }) }));
  for (const overrides of [{ id: '' }, { self: () => true }, { type: () => 9 }, { talker: () => ({ id: '' }) },
    { text: () => '中'.repeat(22000) }, { text: () => { throw Error('secret-token'); } }]) {
    bot.emit('message', wechatMessage(overrides));
  }
  bot.emit('error', Error('secret-token'));
  bot.emit('scan', 'qr-token', 2);
  await tick();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].chat.type, 'private');
  assert.equal(messages[1].chat.id, 'g1');
  assert.equal(messages[1].sender.id, 'u1');
  assert.ok(statuses.some(status => status.qrDataUrl?.startsWith('data:image/png;')));
  assert.ok(!JSON.stringify([statuses, logs]).includes('secret-token'));
  await receiver.stop();
  await late(wechatMessage());
  await receiver.stop();
  assert.equal(messages.length, 2);
  assert.equal(bot.stopped, true);
});

test('飞书仅群文本且结构化提及，异常事件不影响后续，close取消重连', async () => {
  let dispatch;
  const client = { start: async value => { dispatch = value; }, close: async () => { client.closed = true; } };
  const messages = [], statuses = [], activities = [];
  const receiver = createFeishuReceiver({ connection: { id: 'fs', appId: 'app', appSecret: 'secret-token' },
    onMessage: async message => messages.push(message), onStatus: status => statuses.push(status), logger: () => {},
    onActivity: item => activities.push(item), sdkFactory: async handler => ({ client, eventDispatcher: { handler }, botId: 'bot1' }) });
  await receiver.start();
  const handler = dispatch.eventDispatcher.handler;
  for (const overrides of [{ content: 'bad' }, { message_id: '' }, { chat_type: 'p2p' }, { message_type: 'image' },
    { content: JSON.stringify({ text: 'a'.repeat(65537) }) }]) {
    await handler(feishuMessage(overrides));
  }
  await handler({ ...feishuMessage(), sender: { sender_type: 'app' } });
  await handler({ ...feishuMessage(), sender: { sender_type: 'user', sender_id: {} } });
  await handler(feishuMessage());
  await handler(feishuMessage({ message_id: 'm2', mentions: [], content: '{"text":"@robot"}' }));
  assert.equal(activities.filter(item => item.kind === 'ignored').length, 3);
  assert.equal(activities.filter(item => item.kind === 'rejected').length, 4);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].mentioned, true);
  assert.equal(messages[1].mentioned, false);
  await handler(feishuMessage({ mentions: [{ id: { open_id: 'other-user' } }] }));
  assert.equal(messages[2].mentioned, false);
  assert.equal(messages[0].sentAt, 100);
  await receiver.stop();
  await handler(feishuMessage());
  await receiver.stop();
  assert.equal(messages.length, 3);
  assert.equal(client.closed, true);
  assert.ok(!JSON.stringify(statuses).includes('secret-token'));
});


test('微信初始化迟到完成时再次停止', async () => {
  let release;
  let alive = false;
  const gate = new Promise(resolve => { release = resolve; });
  const bot = new EventEmitter();
  bot.start = async () => { await gate; alive = true; };
  bot.stop = async () => { alive = false; };
  const messages = [];
  const receiver = createWechatReceiver({ connection: { id: 'wx' }, onMessage: async item => messages.push(item), onStatus() {},
    sdkFactory: async () => ({ bot, textType: 7 }) });
  const starting = receiver.start();
  await tick();
  const stopping = receiver.stop();
  release();
  await Promise.all([starting, stopping]);
  assert.equal(alive, false, '迟到的 SDK 启动必须最终停止');
});

test('微信缺少群名时仍投递，已有群名直接使用本地载荷', async () => {
  const bot = new EventEmitter();
  bot.start = async () => {};
  bot.stop = async () => {};
  const messages = [];
  const other = createWechatReceiver({ connection: { id: 'wx' }, onMessage: async item => messages.push(item), onStatus() {},
    sdkFactory: async () => ({ bot, textType: 7 }) });
  await other.start();
  const handler = bot.listeners('message')[0];
  await handler(wechatMessage({ room: () => ({ id: 'room', topic: () => { throw Error('not ready'); } }) }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat.name, '');
  await handler(wechatMessage({ room: () => ({ id: 'room', payload: { topic: '本地群名' }, topic: () => new Promise(() => {}) }) }));
  assert.equal(messages[1].chat.name, '本地群名');
  await other.stop();
});

test('接收器报告忽略、拒收及处理失败，不把失败算作接收成功', async () => {
  const bot = new EventEmitter();
  bot.start = async () => {};
  bot.stop = async () => {};
  const activities = [];
  const receiver = createWechatReceiver({ connection: { id: 'wx' }, onMessage: async () => { throw Error('disk'); }, onStatus() {},
    onActivity: item => activities.push(item), sdkFactory: async () => ({ bot, textType: 7 }) });
  await receiver.start();
  const handler = bot.listeners('message')[0];
  await handler(wechatMessage({ type: () => 9 }));
  await handler(wechatMessage({ self: () => true }));
  await handler(wechatMessage({ text: () => 'a'.repeat(65537) }));
  await handler(wechatMessage());
  assert.deepEqual(activities.map(item => item.kind), ['ignored', 'ignored', 'rejected', 'rejected']);
  await receiver.stop();
});
