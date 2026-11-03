import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import Wechat4u from 'wechat4u';
import { createWechatPuppet, WechatChannel } from '../src/main/common/channels/wechat.js';

async function webClient(t, status, body) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'text/xml', 'Set-Cookie': 'webwx_data_ticket=fixture-cookie; Path=/' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const puppet = await createWechatPuppet({});
  const client = new Wechat4u();
  client.rediUri = `http://127.0.0.1:${server.address().port}/login`;
  puppet.state.active(true);
  puppet.wechat4u = client;
  puppet.monkeyPatch(client);
  t.after(async () => { await puppet.onStop(); await new Promise(resolve => server.close(resolve)); });
  // Stop must not contact the actual WeChat logout endpoint for fixture credentials.
  client.logout = async () => {};
  return { client, puppet };
}

for (const status of [200, 301]) {
  test(`web login consumes HTTP ${status} credentials before initialization`, async t => {
    const { client } = await webClient(t, status,
      '<error><ret>0</ret><skey>fixture-skey</skey><wxsid>fixture-sid</wxsid><wxuin>123</wxuin><pass_ticket>fixture-ticket</pass_ticket></error>');
    await client.login();
    assert.equal(client.PROP.sid, 'fixture-sid');
    assert.equal(client.PROP.uin, '123');
    assert.equal(client.PROP.passTicket, 'fixture-ticket');
    assert.equal(client.PROP.webwxDataTicket, 'fixture-cookie');
  });
}

test('web login rejects platform denial before initialization instead of silently continuing', async t => {
  const { client } = await webClient(t, 200, '<error><ret>1203</ret><message><![CDATA[当前账号无法登录网页版微信]]></message></error>');
  await assert.rejects(client.login(), /1203.*当前账号无法登录/);
  assert.equal(client.PROP.sid, '');
});

test('web login preserves the original network failure', async t => {
  const { client } = await webClient(t, 200, '');
  const failure = Object.assign(Error('fixture connection reset'), { code: 'ECONNRESET' });
  client.request = async () => { throw failure; };
  await assert.rejects(client.login(), error => error === failure);
});

test('web login rejects incomplete credentials', async t => {
  const { client } = await webClient(t, 200, '<error><ret>0</ret><skey>partial</skey></error>');
  await assert.rejects(client.login(), /凭据不完整/);
  assert.equal(client.PROP.skey, '', 'do not leave a partially authenticated client');
});

test('failed web login does not automatically replace the error with another QR code', async () => {
  const puppet = await createWechatPuppet({});
  const client = new EventEmitter();
  let restarts = 0;
  client.start = () => restarts++;
  puppet.memory.delete = async () => {};
  puppet.memory.save = async () => {};
  await puppet.handleLogout(client, new AbortController().signal);
  assert.equal(restarts, 0);
});

test('Wechaty publishes scan progress, successful account and actionable login denial', async () => {
  const bot = new EventEmitter();
  bot.start = bot.stop = async () => {};
  const states = [];
  const channel = new WechatChannel({ channel: { id: 'fixture' }, pluginId: 'message-bridge', status: value => states.push(value), report() {},
    sdkFactory: async () => ({ bot, qr: async () => 'data:image/png;base64,fixture' }) });
  await channel.start();
  bot.emit('scan', 'fixture', 2);
  await channel.drain();
  assert.equal(states.at(-1).state, 'scan');
  bot.emit('scan', 'fixture', 3);
  await channel.drain();
  assert.equal(states.at(-1).state, 'scanned');
  bot.emit('scan', 'fixture', 4);
  await channel.drain();
  assert.equal(states.at(-1).state, 'confirming');
  bot.emit('login', { name: () => '测试账号' });
  await channel.drain();
  assert.equal(states.at(-1).account, '测试账号');
  bot.emit('error', Error('微信网页登录被拒绝（1203）：当前账号无法登录网页版微信'));
  await channel.drain();
  assert.match(states.at(-1).error, /1203.*无法登录/);
  assert.equal(states.at(-1).qrDataUrl, undefined);
  await channel.stop();
});

test('late QR rendering cannot replace login success', async () => {
  const bot = new EventEmitter();
  bot.start = bot.stop = async () => {};
  const states = [];
  let finishQr;
  const channel = new WechatChannel({ channel: { id: 'fixture' }, pluginId: 'message-bridge', status: value => states.push(value),
    sdkFactory: async () => ({ bot, qr: () => new Promise(resolve => { finishQr = resolve; }) }) });
  await channel.start();
  bot.emit('scan', 'fixture', 2);
  await new Promise(resolve => setImmediate(resolve));
  bot.emit('login', { name: () => '测试账号' });
  await new Promise(resolve => setImmediate(resolve));
  finishQr('data:image/png;base64,late');
  await channel.drain();
  assert.equal(states.at(-1).state, 'connected');
  await channel.stop();
});
