import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Storage } from '../src/main/common/storage.js';
import { PluginChannels } from '../src/main/common/plugin-channels.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desk-channels-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  const runtime = { id: 'test-agent', instanceId: 'first', notifyChannel: () => {} };
  const broker = new PluginChannels({ storage, usable: source => !source.closed });
  const call = (action, input, source = runtime) => broker.request(source, action, input);
  await call('register', { endpointId: 'a', metadata: { name: 'A' } });
  await call('register', { endpointId: 'b', metadata: { name: 'B' } });
  return { root, storage, runtime, broker, call };
}

test('same-plugin routing, FIFO claim, receipts and concurrent idempotency', async t => {
  const { call, runtime } = await fixture(t);
  const send = { endpointId: 'a', targetId: 'b', requestId: 'once', text: 'hello' };
  const [first, duplicate] = await Promise.all([call('send', send), call('send', send)]);
  assert.equal(first.messageId, duplicate.messageId);
  const second = await call('send', { ...send, requestId: 'twice' });
  await assert.rejects(call('claim', { endpointId: 'b', messageId: second.messageId }), { code: 'CHANNEL_ORDER' });
  await call('claim', { endpointId: 'b', messageId: first.messageId });
  await call('settle', { endpointId: 'b', messageId: first.messageId, status: 'delivered' });
  assert.equal((await call('inbox', { endpointId: 'a', messageId: first.messageId }))[0].status, 'delivered');
  await assert.rejects(call('send', send, { ...runtime, id: 'other' }), { code: 'CHANNEL_ENDPOINT' });
  await assert.rejects(call('inbox', { endpointId: 'b' }, { ...runtime, instanceId: 'stale' }), { code: 'CHANNEL_ENDPOINT' });
});

test('host snapshots actual file bytes and rejects linked or oversized sources without partial copies', async t => {
  const { call, root } = await fixture(t);
  const file = join(root, 'design.md');
  await writeFile(file, 'original bytes');
  const message = await call('send', { endpointId: 'a', targetId: 'b', requestId: 'file', text: 'review', files: [file] });
  await writeFile(file, 'changed');
  const attachment = message.attachments[0];
  assert.equal(await readFile(attachment.path, 'utf8'), 'original bytes');
  assert.equal(attachment.sha256, createHash('sha256').update('original bytes').digest('hex'));
  const linked = join(root, 'link.md');
  await symlink(file, linked);
  await assert.rejects(call('send', { endpointId: 'a', targetId: 'b', requestId: 'bad', text: 'bad', files: [file, linked] }));
  assert.equal((await call('inbox', { endpointId: 'b' })).length, 1);
  assert.equal((await readdir(join(root, 'plugin-data/test-agent/channels/files'))).length, 1);
  await assert.rejects(call('send', { endpointId: 'a', targetId: 'b', requestId: 'large', text: 'x'.repeat(65537) }), { code: 'INVALID_ARGUMENT' });
});

test('revoke preserves pending, makes claimed uncertain and rejects in-flight stale instance; restart never resends claims', async t => {
  const { call, broker, runtime, storage } = await fixture(t);
  const first = await call('send', { endpointId: 'a', targetId: 'b', requestId: 'one', text: 'one' });
  const second = await call('send', { endpointId: 'a', targetId: 'b', requestId: 'two', text: 'two' });
  await call('claim', { endpointId: 'b', messageId: first.messageId });
  runtime.closed = true;
  await broker.revoke(runtime);
  const next = { id: runtime.id, instanceId: 'next', notifyChannel: () => {} };
  const restarted = new PluginChannels({ storage, usable: source => !source.closed });
  await restarted.request(next, 'register', { endpointId: 'b' });
  const inbox = await restarted.request(next, 'inbox', { endpointId: 'b' });
  assert.deepEqual(inbox.map(m => [m.messageId, m.status]), [[first.messageId, 'uncertain'], [second.messageId, 'pending']]);
  await assert.rejects(call('list', {}), { code: 'PLUGIN_UNAVAILABLE' });
  await restarted.request(next, 'unregister', { endpointId: 'b', discard: true });
  await restarted.request(next, 'register', { endpointId: 'b' });
  assert.equal((await restarted.request(next, 'inbox', { endpointId: 'b', messageId: second.messageId }))[0].status, 'failed');
});

test('copy revoked in flight removes partial files and never commits a pending delivery', async t => {
  const { call, broker, runtime, root } = await fixture(t);
  const path = join(root, 'payload.md');
  await writeFile(path, 'payload');
  let copied;
  let resume;
  const copying = new Promise(resolve => { copied = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const snapshot = broker.snapshot.bind(broker);
  broker.snapshot = async input => {
    const result = await snapshot(input);
    copied();
    await gate;
    return result;
  };
  const sent = call('send', { endpointId: 'a', targetId: 'b', requestId: 'stale-copy', text: 'review', files: [path] });
  await copying;
  runtime.closed = true;
  const revoked = broker.revoke(runtime);
  resume();
  await assert.rejects(sent, { code: 'PLUGIN_UNAVAILABLE' });
  await revoked;
  assert.equal((await readdir(join(root, 'plugin-data/test-agent/channels/files'))).length, 0);
});

test('file, attachment count, pending queue and plugin byte quotas reject without publishing copies', async t => {
  const { call, root, storage } = await fixture(t);
  const path = join(root, 'large.md');
  await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
  const input = { endpointId: 'a', targetId: 'b', requestId: 'large', text: 'review', files: [path] };
  await assert.rejects(call('send', input), { code: 'CHANNEL_QUOTA' });
  await assert.rejects(call('send', { ...input, files: Array(6).fill(path) }), { code: 'INVALID_ARGUMENT' });
  await writeFile(path, 'tiny');
  const records = Array.from({ length: 100 }, (_, i) => ({ messageId: `quota-${i}`, sender: 'a', recipient: 'b',
    requestId: `quota-${i}`, text: 'queued', status: 'pending', createdAt: Date.now(), attachments: [] }));
  const key = 'plugin-data/test-agent/channels/index.json';
  await storage.writeJson(key, records);
  await assert.rejects(call('send', input), { code: 'CHANNEL_QUOTA' });
  await storage.writeJson(key, [{ ...records[0], attachments: [{ size: 256 * 1024 * 1024 }] }]);
  await assert.rejects(call('send', input), { code: 'CHANNEL_QUOTA' });
  assert.equal((await readdir(join(root, 'plugin-data/test-agent/channels/files'))).length, 0);
});


test('revocation during final index write rolls back the unfinished send', async t => {
  const { call, storage, broker, runtime } = await fixture(t);
  const write = storage.writeJson.bind(storage);
  let entered;
  let resume;
  const writing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  storage.writeJson = async (key, value) => {
    if (value.some?.(m => m.requestId === 'final-write')) {
      entered();
      await gate;
    }
    return write(key, value);
  };
  const sending = call('send', { endpointId: 'a', targetId: 'b', requestId: 'final-write', text: 'peer' });
  const rejected = assert.rejects(sending, { code: 'PLUGIN_UNAVAILABLE' });
  await writing;
  runtime.closed = true;
  const revoked = broker.revoke(runtime);
  resume();
  await rejected;
  await revoked;
  assert.deepEqual(await storage.readJson(broker.key(runtime.id), []), []);
});
