import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { MessageQueue } from '../src/main/common/message-queue.js';

const wf = { id: 'wf', name: '消息流程' };
const node = { id: 'message', type: 'message.wechat', params: { connectionId: 'wx' } };
const message = (id = 'm1') => ({ channel: 'wechat', connectionId: 'wx', messageId: id,
  chat: { id: 'g', type: 'group', name: '' }, sender: { id: 'u', name: '' }, text: 'hello', sentAt: 1, receivedAt: 1 });
async function domain(t, options = {}) {
  const storage = await temporaryStore(t);
  return { storage, queue: new MessageQueue({ storage, pluginId: 'work-flow', ...options }) };
}

test('并发投递一次持久接收，每工作流独立去重，FIFO且已领取不再领取', async t => {
  const { queue } = await domain(t);
  const accepted = await Promise.all(Array.from({ length: 3 }, () => queue.accept(wf, node, message())));
  assert.equal(accepted.filter(item => item.accepted).length, 1);
  await queue.accept({ id: 'other' }, node, message());
  await queue.accept(wf, node, message('m2'));
  const first = await queue.claim(wf.id);
  assert.equal(first.message.messageId, 'm1');
  assert.ok(first.runId);
  assert.equal(await queue.claim(wf.id), null);
  await queue.finish(first.id, { status: 'succeeded' });
  assert.equal((await queue.claim(wf.id)).message.messageId, 'm2');
  assert.equal((await queue.list('other')).length, 1);
});

test('落盘失败不会污染去重；恢复标记 interrupted 不自动重放，clear 保留活动项', async t => {
  const { storage, queue } = await domain(t);
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw Error('disk full'); };
  await assert.rejects(queue.accept(wf, node, message()), /disk full/);
  storage.writeJson = write;
  assert.equal((await queue.accept(wf, node, message())).accepted, true);
  const claimed = await queue.claim(wf.id);
  await queue.clear(wf.id);
  assert.equal((await queue.list(wf.id)).length, 1);
  await queue.recover();
  assert.equal((await queue.list(wf.id))[0].status, 'interrupted');
  assert.equal(await queue.claim(wf.id), null);
  const retry = await queue.retry(claimed.id);
  assert.notEqual(retry.id, claimed.id);
  assert.equal((await queue.claim(wf.id)).id, retry.id);
  await queue.finish(retry.id, { status: 'invalid', reason: '入口配置变化' });
  assert.equal((await queue.list(wf.id)).at(-1).status, 'invalid');
  await queue.clear(wf.id);
  await queue.clear(wf.id);
  assert.deepEqual(await queue.list(wf.id), []);
});

test('待执行最多100，去重24小时和10000键，终态历史只保留20', async t => {
  let now = 100;
  const { storage, queue } = await domain(t, { now: () => now });
  for (let i = 0; i < 100; i++) {
    assert.equal((await queue.accept(wf, node, message(`m${i}`))).accepted, true);
  }
  assert.equal((await queue.accept(wf, node, message('overflow'))).reason, 'QUEUE_FULL');
  await queue.clear(wf.id);
  assert.equal((await queue.accept(wf, node, message('m0'))).accepted, false);
  now += 86400001;
  assert.equal((await queue.accept(wf, node, message('m0'))).accepted, true);
  const key = 'plugin-data/work-flow/message-queue.json';
  const data = await storage.readJson(key);
  data.seen = Array.from({ length: 10000 }, (_, i) => ({ key: `old-${i}`, at: now }));
  await storage.writeJson(key, data);
  await queue.accept(wf, node, message('new'));
  assert.equal((await storage.readJson(key)).seen.length, 10000);
  await queue.clear(wf.id);
  for (let i = 0; i < 25; i++) {
    await queue.accept(wf, node, message(`end-${i}`));
    const item = await queue.claim(wf.id);
    await queue.finish(item.id, { status: 'succeeded' });
  }
  assert.equal((await queue.list(wf.id)).length, 20);
});

test('拒绝非字符串稳定 ID 和未知消息渠道', async t => {
  const { queue } = await domain(t);
  for (const input of [{ ...message(), messageId: {} }, { ...message(), channel: 'unknown' },
    { ...message(), sender: { id: ' ' } }]) {
    await assert.rejects(queue.accept(wf, node, input), { code: 'MESSAGE_INVALID' });
  }
});
