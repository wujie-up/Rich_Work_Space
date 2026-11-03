import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { WechatChannel, createWechatPuppet } from '../src/main/common/channels/wechat.js';
import { checkNativeGateway } from '../src/main/common/channels/wechat-native.js';
import { nativeGateway, until } from './fixtures/native-gateway.mjs';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('native Puppet requires an explicit loopback endpoint and never disables TLS for remote Service', async t => {
  const storage = await temporaryStore(t);
  const native = await createWechatPuppet({ puppet: 'native', token: 'fixture-token' }, { cacheDirectory: storage.root });
  assert.equal(native.options.endpoint, '127.0.0.1:18401');
  assert.equal(native.options.tls.disable, true);
  assert.equal(native.options.tls.serverName, '127.0.0.1');
  assert.equal(native.options.token, 'fixture-token');
  assert.equal(native._payloadStore.storeDir, `${storage.root}/payload-v1.18`);
  for (const endpoint of ['192.168.1.2:18401', 'example.com:18401', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:18401/path', 'secret@localhost:18401']) {
    await assert.rejects(createWechatPuppet({ puppet: 'native', token: 'fixture-token', endpoint }), /本机网关地址/);
  }
  const service = await createWechatPuppet({ puppet: 'service', token: 'fixture-token', endpoint: 'example.com:443' });
  assert.equal(service.options.tls.disable, false);
});

test('native channel reports missing gateway credential without requesting a web QR', async () => {
  const states = [];
  const channel = new WechatChannel({ channel: { id: 'native', puppet: 'native' }, status: state => states.push(state),
    sdkFactory: async () => assert.fail('missing gateway token must not start SDK') });
  await channel.start();
  assert.equal(states.at(-1).state, 'login_required');
  assert.match(states.at(-1).error, /网关 Token/);
  await channel.stop();
});

test('native channel reports a closed local gateway and does not announce login', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const states = [];
  const reports = [];
  const channel = new WechatChannel({ pluginId: 'message-bridge', channel: { id: 'native', puppet: 'native', token: 'fixture-token', endpoint: `127.0.0.1:${port}` },
    report: (action, error) => reports.push({ action, error }), status: state => states.push(state),
    sdkFactory: async () => assert.fail('unreachable gateway must not start SDK') });
  await channel.start();
  assert.equal(states.at(-1).state, 'error');
  assert.match(states.at(-1).error, /本机微信网关未连接/);
  assert.equal(reports[0].action, 'wechat-native-connect');
  assert.equal(states.some(state => state.state === 'connected' || state.qrDataUrl), false);
  await channel.stop();
});

test('native gateway probe can be cancelled before connecting', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(checkNativeGateway({ endpoint: '127.0.0.1:18401' }, controller.signal), { name: 'AbortError' });
});

test('native channel closes the SDK on authentication failure without exposing credentials', async t => {
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const states = [];
  const bot = new EventEmitter();
  let stopped = 0;
  bot.start = async () => { throw Error('UNAUTHENTICATED fixture-private-token'); };
  bot.stop = async () => { stopped++; };
  const channel = new WechatChannel({ channel: { id: 'native', puppet: 'native', token: 'fixture-private-token',
    endpoint: `127.0.0.1:${server.address().port}` }, status: state => states.push(state), report() {},
    sdkFactory: async () => ({ bot }) });
  await channel.start();
  assert.ok(stopped > 0);
  assert.equal(states.at(-1).state, 'error');
  assert.equal(JSON.stringify(states).includes('fixture-private-token'), false);
  assert.equal(states.some(state => state.state === 'connected'), false);
});

test('stopping native connection does not replace its status with an abort error', async () => {
  const states = [];
  const channel = new WechatChannel({ channel: { id: 'native', puppet: 'native', token: 'fixture-token' },
    status: state => states.push(state), report() {}, sdkFactory: async () => assert.fail('stopped connection must not start SDK') });
  const starting = channel.start();
  await channel.stop();
  const count = states.length;
  await starting;
  assert.equal(states.length, count);
});

test('real local gRPC gateway rejects an incorrect token without announcing login', async t => {
  const cleanup = [];
  const hooks = { after: work => cleanup.push(work) };
  const storage = await temporaryStore(hooks);
  const gateway = await nativeGateway(hooks);
  const states = [];
  const channel = new WechatChannel({ pluginId: 'message-bridge', storage,
    channel: { ...gateway.channel, id: 'bad-auth', token: 'fixture-wrong-token' }, status: state => states.push(state), report() {} });
  t.after(async () => { await channel.stop(); for (const work of cleanup) { await work(); } });
  await channel.start();
  assert.equal(states.at(-1).state, 'error');
  assert.equal(states.some(state => state.state === 'connected'), false);
  assert.equal(JSON.stringify(states).includes('fixture-wrong-token'), false);
});

test('stopping a native connection closes a listening gateway that never responds', async t => {
  const sockets = new Set();
  let connections = 0;
  const server = createServer(socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const storage = await temporaryStore(t);
  const channel = new WechatChannel({ pluginId: 'message-bridge', storage,
    channel: { id: 'hung-gateway', puppet: 'native', token: 'fixture-token', endpoint: `127.0.0.1:${server.address().port}` },
    status() {}, report() {} });
  t.after(async () => {
    for (const socket of sockets) { socket.destroy(); }
    await channel.stop();
    await new Promise(resolve => server.close(resolve));
  });
  const starting = channel.start();
  await until(() => connections >= 2);
  let deadline;
  try {
    await Promise.race([Promise.all([starting, channel.stop()]), new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(Error('native connection did not cancel within eight seconds')), 8000);
    })]);
  } finally { clearTimeout(deadline); }
});

test('native text send has a real gRPC deadline when the gateway stalls', async t => {
  const cleanup = [];
  const hooks = { after: work => cleanup.push(work) };
  const storage = await temporaryStore(hooks);
  const gateway = await nativeGateway(hooks);
  gateway.puppet.messageSendText = async () => new Promise(() => {});
  const states = [];
  const channel = new WechatChannel({ pluginId: 'message-bridge', storage, channel: { ...gateway.channel, id: 'hung-send' },
    status: state => states.push(state), report() {} });
  t.after(async () => { await channel.stop(); for (const work of cleanup) { await work(); } });
  await channel.start();
  await until(() => states.at(-1).state === 'connected');
  let deadline;
  try {
    await assert.rejects(Promise.race([channel.send({ source: { chatType: 'private', chatId: 'alice' }, text: 'fixture' }),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(Error('test watchdog expired')), 8000); })]), /DEADLINE_EXCEEDED/);
  } finally { clearTimeout(deadline); }
});
