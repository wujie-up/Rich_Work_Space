import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { FeishuChannel } from '../src/main/common/channels/feishu.js';
import { WechatChannel } from '../src/main/common/channels/wechat.js';
import * as wechatSdk from '../src/main/common/channels/wechat.js';
import { WeixinBotChannel } from '../src/main/common/channels/weixin-bot.js';

const base = () => ({ channel: { id: 'channel', appId: 'app', appSecret: 'secret', botToken: 'secret-token' },
  status() {}, credentials: async () => {}, receive: async () => {}, storage: { resolve: value => `/tmp/${value}` } });

test('Wechaty defaults to the local web protocol and keeps legacy Service credentials compatible', async () => {
  assert.equal(typeof wechatSdk.createWechatPuppet, 'function');
  const web = await wechatSdk.createWechatPuppet({});
  const { PuppetWechat4u } = await import('wechaty-puppet-wechat4u');
  assert.ok(web instanceof PuppetWechat4u);
  const legacy = await wechatSdk.createWechatPuppet({ token: 'fixture-token' });
  assert.equal(legacy.constructor.name, 'PuppetService');
  const explicitWeb = await wechatSdk.createWechatPuppet({ puppet: 'wechat4u', token: 'retained-old-token' });
  assert.ok(explicitWeb instanceof PuppetWechat4u);
  await assert.rejects(wechatSdk.createWechatPuppet({ puppet: 'unknown' }), /不支持的 Wechaty Puppet/);
});

test('web Puppet stops without the upstream logout reconnect and clears contact polling', async t => {
  const puppet = await wechatSdk.createWechatPuppet({});
  const client = new EventEmitter();
  client.on('logout', () => assert.fail('stopping must not restart a login'));
  client.stop = () => {
    assert.equal(client.listenerCount('logout'), 0, 'detach SDK restart listener before stopping');
    client.emit('logout');
  };
  puppet.wechat4u = client;
  let polls = 0;
  puppet.getContactInterval = setInterval(() => polls++, 10);
  t.after(() => clearInterval(puppet.getContactInterval));
  await puppet.onStop();
  assert.equal(puppet.getContactInterval, undefined);
  assert.equal(polls, 0);
});

test('web Puppet cancels contact readiness immediately when stopping', async () => {
  const puppet = await wechatSdk.createWechatPuppet({});
  puppet.contactList = async () => [];
  let ready = false;
  puppet.on('ready', () => { ready = true; });
  const waiting = puppet.waitStable();
  await puppet.onStop();
  let timeout;
  try {
    await Promise.race([waiting, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('contact sync did not stop')), 100); })]);
    assert.equal(ready, false);
  } finally {
    clearTimeout(timeout);
  }
});

test('web Puppet aborts in-flight protocol requests on shutdown', async t => {
  const puppet = await wechatSdk.createWechatPuppet({});
  const { default: Wechat4u } = await import('wechat4u');
  const client = new Wechat4u();
  client.request = async options => options.signal;
  puppet.wechat4u = client;
  puppet.monkeyPatch(client);
  t.after(() => puppet.onStop());
  const signal = await client.request({ url: 'https://fixture.invalid' });
  assert.ok(signal instanceof AbortSignal);
  await puppet.onStop();
  assert.equal(signal.aborted, true);
});

test('web Puppet cancels an already running logout callback before it can restart', async () => {
  const puppet = await wechatSdk.createWechatPuppet({});
  const client = new EventEmitter();
  let restarted = false;
  client.start = () => { restarted = true; };
  client.stop = () => client.emit('logout');
  puppet.wechat4u = client;
  puppet.initHookEvents(client);
  let release;
  puppet.memory.delete = () => new Promise(resolve => { release = resolve; });
  puppet.memory.save = async () => {};
  puppet.login('fixture-self');
  const logout = client.listeners('logout')[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  await puppet.onStop();
  release();
  await logout;
  assert.equal(restarted, false);
});

test('web Puppet renews expired restored credentials without requiring a successful login first', async () => {
  const puppet = await wechatSdk.createWechatPuppet({});
  const { AlreadyLogoutError } = await import('wechat4u/lib/core.js');
  let restarts = 0;
  let cleared = false;
  puppet.memory.delete = async () => { cleared = true; };
  puppet.memory.save = async () => {};
  const client = new EventEmitter();
  client._init = async () => { throw new AlreadyLogoutError(); };
  client.start = () => { restarts++; };
  await puppet.reconnect(client, puppet.connectionAbort.signal);
  assert.equal(cleared, true);
  assert.equal(restarts, 1);
});

test('web Puppet clears active login identity when reconnect detects account expiry', async () => {
  const puppet = await wechatSdk.createWechatPuppet({});
  const { AlreadyLogoutError } = await import('wechat4u/lib/core.js');
  puppet.memory.delete = puppet.memory.save = async () => {};
  puppet.login('fixture-self');
  let loggedInAtRestart;
  const client = new EventEmitter();
  client._init = async () => { throw new AlreadyLogoutError(); };
  client.start = () => { loggedInAtRestart = puppet.isLoggedIn; };
  await puppet.reconnect(client, puppet.connectionAbort.signal);
  assert.equal(loggedInAtRestart, false);
});

test('web Puppet clears SDK identity before a successful network reinitialization emits login again', async () => {
  const puppet = await wechatSdk.createWechatPuppet({});
  puppet.login('fixture-self');
  let cleared = false;
  puppet.memory.delete = async () => { cleared = true; };
  const client = new EventEmitter();
  client._init = async () => {
    assert.equal(puppet.isLoggedIn, false, 'the real SDK emits login again and rejects duplicate identity');
    puppet.login('fixture-self');
  };
  client.stop = () => assert.fail('successful reinitialization must not stop');
  client.on('error', error => { throw error; });
  await puppet.reconnect(client, puppet.connectionAbort.signal);
  assert.equal(puppet.isLoggedIn, true);
  assert.equal(cleared, false, 'network recovery must retain restorable credentials');
});

test('web Puppet coalesces concurrent heartbeat and sync reconnect requests', async () => {
  const puppet = await wechatSdk.createWechatPuppet({});
  puppet.login('fixture-self');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const client = new EventEmitter();
  client._init = async () => {
    attempts++;
    await pending;
    puppet.login('fixture-self');
  };
  client.stop = () => assert.fail('concurrent reconnects must not fail');
  client.on('error', error => { throw error; });
  const work = Promise.all([puppet.reconnect(client, puppet.connectionAbort.signal), puppet.reconnect(client, puppet.connectionAbort.signal)]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await work;
  assert.equal(attempts, 1);
  assert.equal(puppet.isLoggedIn, true);
});

test('web Puppet completes full SDK initialization after reconnect backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  const puppet = await wechatSdk.createWechatPuppet({});
  let attempts = 0;
  const errors = [];
  const client = new EventEmitter();
  client._init = async () => {
    if (++attempts === 1) { throw Error('fixture network outage'); }
    puppet.login('fixture-self');
  };
  client.init = () => assert.fail('raw init does not restart SDK polling or emit login');
  client.stop = () => assert.fail('successful retry must not stop');
  client.on('error', error => errors.push(error));
  const reconnect = puppet.reconnect(client, puppet.connectionAbort.signal);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60000);
  await reconnect;
  assert.equal(attempts, 2);
  assert.equal(puppet.isLoggedIn, true);
  assert.equal(errors.length, 1);
});

test('web Puppet cancels a reconnect backoff without waiting sixty seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const puppet = await wechatSdk.createWechatPuppet({});
  const { default: Wechat4u } = await import('wechat4u');
  const client = new Wechat4u();
  client._init = async () => { throw Error('network fixture'); };
  client.logout = async () => {};
  client.on('error', () => {});
  puppet.state.active(true);
  puppet.wechat4u = client;
  puppet.monkeyPatch(client);
  let settled = false;
  const reconnect = client.restart().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  await puppet.onStop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  await reconnect;
});

test('Wechaty Service without credentials requests configuration before starting the SDK', async () => {
  const states = [];
  let started = false;
  const channel = new WechatChannel({ ...base(), channel: { id: 'service', puppet: 'service' }, status: state => states.push(state),
    sdkFactory: async () => { started = true; throw Error('must not start'); } });
  await channel.start();
  assert.equal(started, false);
  assert.equal(states.at(-1).state, 'login_required');
});

test('Feishu accepts both chat types, awaits durable ingestion and replies to original message with fixed UUID', async () => {
  const received = [];
  let handler;
  let sent;
  const channel = new FeishuChannel({ ...base(), receive: async source => { received.push(source); if (source.text === 'fail') { throw Error('disk full'); } },
    sdkFactory: async callback => { handler = callback; return { botId: 'bot', start: async () => {}, stop: async () => {},
      send: async input => { sent = input; return { code: 0, data: { message_id: 'reply' } }; } }; } });
  await channel.start();
  const event = (type, text) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'alice' } }, message: {
    message_id: 'msg', chat_id: 'room', chat_type: type, message_type: 'text', content: JSON.stringify({ text }), create_time: '1000', mentions: [{ id: { open_id: 'bot' }, key: '@_user_1' }] } });
  await handler(event('group', '@_user_1 hello'));
  await handler(event('p2p', 'private'));
  await assert.rejects(handler(event('group', 'fail')), /disk full/);
  assert.equal(received[0].mentioned, true);
  assert.equal(received[0].text, 'hello');
  assert.equal(received[1].chatType, 'private');
  await channel.send({ source: received[0], text: 'answer', clientId: 'stable' });
  assert.equal(sent.path.message_id, 'msg');
  assert.equal(sent.data.uuid, 'stable');
  await channel.stop();
  await handler(event('group', 'late'));
  assert.equal(received.length, 3);
});

test('Wechaty handles existing friends/groups, ignores self and sends back through the correct entity', async () => {
  const bot = new EventEmitter();
  const received = [];
  const sent = [];
  const errors = [];
  bot.start = async () => {};
  bot.stop = async () => { bot.emit('error', Error('stop fixture')); };
  bot.Contact = { find: async ({ id }) => ({ id, say: async text => { sent.push({ id, text, type: 'private' }); return { id: 'private-reply' }; } }) };
  bot.Room = { find: async ({ id }) => ({ say: async text => { sent.push({ id, text, type: 'group' }); return { id: 'group-reply' }; } }) };
  const channel = new WechatChannel({ ...base(), receive: async source => { received.push(source); }, report: (action, error) => errors.push({ action, error }),
    sdkFactory: async () => ({ bot, textType: 7, qr: async () => 'data:image/png;base64,test' }) });
  await channel.start();
  const message = (id, room, self = false) => ({ id, self: () => self, type: () => 7, talker: () => ({ id: 'alice' }),
    room: () => room ? { id: 'room' } : null, text: () => '/agent hi', date: () => new Date(1000), mentionSelf: async () => false });
  bot.emit('message', message('friend', false));
  bot.emit('message', message('group', true));
  bot.emit('message', message('self', true, true));
  await channel.drain();
  assert.equal(received.length, 2);
  for (const source of received) { await channel.send({ source, text: 'answer' }); }
  assert.deepEqual(sent.map(item => [item.id, item.type]), [['alice', 'private'], ['room', 'group']]);
  await channel.stop();
  assert.equal(errors.at(-1)?.action, 'wechat-stopping');
  assert.equal(errors.at(-1)?.error.message, 'stop fixture');
  bot.emit('message', message('late', true));
  await channel.drain();
  assert.equal(received.length, 2);
});

test('iLink keeps uint64 IDs exact, persists cursor after ingestion and uses source context for one send', async () => {
  const order = [];
  const requests = [];
  const options = { ...base(), receive: async source => { order.push('receive'); assert.equal(source.messageId, '18446744073709551615'); },
    credentials: async patch => { order.push('cursor'); assert.equal(patch.cursor, 'next'); },
    fetch: async (url, init) => { requests.push({ url, init }); return new Response(url.endsWith('getupdates')
      ? '{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":18446744073709551615,"message_type":1,"message_state":2,"from_user_id":"alice","create_time_ms":1000,"context_token":"context-secret","item_list":[{"type":1,"text_item":{"text":"hi"}}]}]}'
      : '{"ret":0}'); } };
  const channel = new WeixinBotChannel(options);
  await channel.pollOnce();
  assert.deepEqual(order, ['receive', 'cursor']);
  await channel.send({ source: { senderId: 'alice', chatId: 'alice', replyContext: { contextToken: 'context-secret' } }, text: 'answer', clientId: 'stable' });
  const payload = JSON.parse(requests[1].init.body);
  assert.equal(payload.msg.context_token, 'context-secret');
  assert.equal(payload.msg.client_id, 'stable');
  assert.equal(payload.msg.to_user_id, 'alice');
  assert.equal(requests[1].init.headers.Authorization, 'Bearer secret-token');
  await channel.stop();
});

test('iLink refuses cursor advance on disk failure and rejects credentials sent to untrusted hosts', async () => {
  let cursorWrites = 0;
  const channel = new WeixinBotChannel({ ...base(), receive: async () => { throw Error('disk full'); },
    credentials: async () => { cursorWrites++; }, fetch: async () => new Response(JSON.stringify({ ret: 0, get_updates_buf: 'next', msgs: [
      { message_id: '1', message_type: 1, message_state: 2, from_user_id: 'alice', context_token: 'secret', item_list: [{ type: 1, text_item: { text: 'hi' } }] }
    ] })) });
  await assert.rejects(channel.pollOnce(), /disk full/);
  assert.equal(cursorWrites, 0);
  const unsafe = new WeixinBotChannel({ ...base(), channel: { botToken: 'secret', baseUrl: 'https://attacker.example' } });
  await assert.rejects(unsafe.pollOnce(), /可信/);
  await channel.stop();
  await unsafe.stop();
});

test('iLink authentication expiry pauses polling without publishing token or backend payload', async () => {
  const states = [];
  const channel = new WeixinBotChannel({ ...base(), status: state => states.push(state),
    fetch: async () => new Response('{"ret":-14,"errmsg":"secret-token"}') });
  await assert.rejects(channel.pollOnce(), /登录/);
  assert.equal(states.at(-1).state, 'login_required');
  assert.equal(JSON.stringify(states).includes('secret-token'), false);
  await channel.stop();
});
