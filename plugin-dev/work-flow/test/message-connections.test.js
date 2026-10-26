import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { MessageConnections } from '../src/main/common/message-connections.js';

async function domain(t) {
  return new MessageConnections({ storage: await temporaryStore(t), pluginId: 'work-flow' });
}

test('旧空目录可用，连接必填项和端点拒绝且错误不含密钥', async t => {
  const connections = await domain(t);
  assert.deepEqual(await connections.list(), []);
  for (const input of [
    { channel: 'wechat', name: '微信' },
    { channel: 'feishu', name: '群', appId: 'app' },
    { channel: 'wechat', name: '微信', token: 'secret-token', endpoint: 'http://insecure' },
    { id: '../x', channel: 'wechat', name: '微信', token: 'secret-token' }
  ]) {
    await assert.rejects(connections.save(input), error => error.code === 'INVALID_ARGUMENT' && !error.message.includes('secret-token'));
  }
});

test('保存和列表脱敏，空密钥保留，渠道不可更改', async t => {
  const connections = await domain(t);
  const saved = await connections.save({ channel: 'wechat', name: '微信', token: 'secret-token', endpoint: 'example.com:8788' });
  assert.equal(saved.hasSecret, true);
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify([saved, await connections.list()]).includes('secret-token'));
  await connections.save({ ...saved, name: '改名', token: '' });
  assert.equal((await connections.secret(saved.id)).token, 'secret-token');
  await assert.rejects(connections.save({ ...saved, channel: 'feishu', appId: 'app', appSecret: 'x' }), { code: 'INVALID_ARGUMENT' });
  const feishu = await connections.save({ channel: 'feishu', name: '飞书', appId: 'app', appSecret: 'secret-token' });
  await connections.save({ ...feishu, appSecret: '' });
  assert.equal((await connections.secret(feishu.id)).appSecret, 'secret-token');
  await assert.rejects(connections.remove(saved.id, [{ name: '订单监控' }]), /订单监控/);
  await connections.remove(saved.id, []);
  await assert.rejects(connections.secret(saved.id), { code: 'CONNECTION_NOT_FOUND' });
});

test('并发保存不丢连接', async t => {
  const connections = await domain(t);
  await Promise.all(Array.from({ length: 5 }, (_, i) => connections.save({ channel: 'wechat', name: `微信${i}`, token: 'x' })));
  assert.equal((await connections.list()).length, 5);
});

test('Wechaty 端口零不合法', async t => {
  const storage = await temporaryStore(t);
  const connections = new MessageConnections({ storage, pluginId: 'work-flow' });
  await assert.rejects(connections.save({ name: 'wx', channel: 'wechat', token: 'token', endpoint: 'localhost:0' }),
    { code: 'INVALID_ARGUMENT' });
});
