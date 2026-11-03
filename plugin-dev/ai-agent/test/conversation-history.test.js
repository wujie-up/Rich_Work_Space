import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Conversations } from '../src/main/common/conversations.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

async function fixture(t, count = 20) {
  const storage = await temporaryStore(t);
  const options = { storage, pluginId: 'history-test', ownProcesses() {} };
  const records = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), name: `history-${i}`, state: 'idle',
    updatedAt: new Date().toISOString(), events: [{ method: 'message', params: { text: 'x'.repeat(1024) } }] }));
  for (const record of records) {
    await storage.writeJson(`plugin-data/history-test/conversations/${record.id}.json`, record);
  }
  return { storage, options, records };
}

test('legacy history builds summaries and repeat startup reads no bodies; browsing retains at most eight idle bodies', async t => {
  const { storage, options, records } = await fixture(t);
  await new Conversations(options).load();
  let reads = 0;
  const read = storage.readJson.bind(storage);
  storage.readJson = (key, fallback) => {
    if (key.includes('/conversations/')) { reads++; }
    return read(key, fallback);
  };
  const service = new Conversations(options);
  await service.load();
  assert.equal(reads, 0);
  assert.equal(service.list().length, 20);
  assert.equal(service.list()[0].events, undefined);
  for (const record of records) {
    assert.deepEqual(await service.read(record.id), record);
  }
  assert.equal(reads, 20);
  assert.equal([...service.records.values()].filter(value => value.events).length, 8);
  await service.read(records[0].id);
  assert.equal(reads, 21);
  // Reads and eviction cannot change persisted history.
  assert.deepEqual(await read(`plugin-data/history-test/conversations/${records[0].id}.json`), records[0]);
});

test('stale and damaged summary indexes rebuild from original files and recover interrupted turns', async t => {
  const { storage, options, records } = await fixture(t, 2);
  await new Conversations(options).load();
  records[0].state = 'running';
  records[0].name = 'changed outside cache';
  await storage.writeJson(`plugin-data/history-test/conversations/${records[0].id}.json`, records[0]);
  const service = new Conversations(options);
  await service.load();
  assert.equal((await service.read(records[0].id)).state, 'interrupted');
  assert.equal(service.list().find(value => value.id === records[0].id).name, records[0].name);
  await storage.replace('plugin-data/history-test/conversation-index.json', '{broken');
  const recovered = new Conversations(options);
  await recovered.load();
  assert.equal(recovered.list().length, 2);
  assert.deepEqual((await recovered.read(records[1].id)).events, records[1].events);
});

test('active and writing conversations are pinned, and concurrent body reads share one request', async t => {
  const { storage, options, records } = await fixture(t);
  const service = new Conversations(options);
  await service.load();
  let reads = 0;
  const read = storage.readJson.bind(storage);
  storage.readJson = (...args) => { reads++; return read(...args); };
  await Promise.all([service.read(records[0].id), service.read(records[0].id)]);
  assert.equal(reads, 1);
  service.engines.set(records[0].id, {});
  for (const record of records.slice(1)) { await service.read(record.id); }
  assert.ok(service.records.get(records[0].id).events);
  service.engines.clear();
  const pinned = service.records.get(records[0].id);
  const write = storage.writeJson.bind(storage);
  let release;
  storage.writeJson = async (key, value) => {
    if (key.endsWith(`${records[0].id}.json`)) {
      await new Promise(resolve => { release = resolve; });
    }
    return write(key, value);
  };
  const pending = service.persist(pinned);
  while (!release) { await new Promise(resolve => setImmediate(resolve)); }
  for (const record of records.slice(1)) { await service.read(record.id); }
  assert.equal(service.records.get(pinned.id), pinned, 'pending write retains the original body');
  release();
  await pending;
  storage.writeJson = write;
  const old = await service.loadRecord(records[0].id);
  old.archivedAt = new Date().toISOString();
  await service.persist(old);
  await service.stop();
  const reopened = new Conversations(options);
  await reopened.load();
  assert.deepEqual((await reopened.read(old.id)).events, old.events);
  assert.equal((await reopened.read(old.id)).archivedAt, old.archivedAt);
});
