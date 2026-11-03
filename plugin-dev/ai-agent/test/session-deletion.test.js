import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const adapter = { capabilities: {}, buildLaunch: () => ({ command: 'test', args: [], env: {}, isolated: true }) };
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => adapter,
    guard: (_id, work) => work(), processControl: async session => session.terminal.kill(),
    deleteContext: async () => {} });
  t.after(async () => {
    for (const session of [...sessions.active.values()]) {
      await sessions.archive('one', session.id);
    }
  });
  const create = async name => {
    const record = await sessions.create('one', { adapterId: 'codex', cwd: storage.root, name });
    sessions.get('one', record.id).contextId = record.id;
    return record;
  };
  return { storage, sessions, create };
}

test('delete removes native context, replay and capture, preserving sibling and configuration', async t => {
  const { storage, sessions, create } = await setup(t);
  const target = await create('删除');
  const sibling = await create('保留');
  await storage.writeJson('plugin-data/one/config.json', { secret: 'temporary-fixture' });
  const capture = await storage.path(`plugin-data/one/capture/${target.id}`);
  await mkdir(capture, { recursive: true });
  await writeFile(`${capture}/request.json`, 'fixture');
  const calls = [];
  sessions.deleteContext = async session => {
    assert.equal(session.exited, true);
    assert.equal((await stat(await storage.path(sessions.key(session)))).isFile(), true);
    calls.push(session.contextId);
  };
  await sessions.delete('one', target.id);
  assert.deepEqual(calls, [target.id]);
  assert.equal(sessions.list('one').sessions.length, 1);
  assert.equal(sessions.get('one', sibling.id).name, '保留');
  assert.equal(sessions.list('one').archives.length, 0);
  for (const key of [sessions.key(target), `plugin-data/one/logs/${target.id}`, `plugin-data/one/capture/${target.id}`]) {
    await assert.rejects(stat(await storage.path(key)), { code: 'ENOENT' });
  }
  assert.equal((await storage.readJson('plugin-data/one/config.json')).secret, 'temporary-fixture');
});

test('failed native deletion keeps stopped session and replay for explicit retry', async t => {
  const { storage, sessions, create } = await setup(t);
  const target = await create('retry');
  sessions.deleteContext = async () => { throw Error('native failure'); };
  await assert.rejects(sessions.delete('one', target.id), /native failure/);
  assert.ok(sessions.get('one', target.id));
  assert.ok(await stat(await storage.path(sessions.key(target))));
  sessions.deleteContext = async () => {};
  await sessions.delete('one', target.id);
  assert.equal(sessions.list('one').sessions.length, 0);
});

test('shared native context and unsupported legacy engine cannot be deleted', async t => {
  const { sessions, create } = await setup(t);
  const target = await create('one');
  const sibling = await create('two');
  sessions.get('one', sibling.id).contextId = target.id;
  await assert.rejects(sessions.delete('one', target.id), { code: 'CONTEXT_IN_USE' });
  sessions.get('one', sibling.id).contextId = sibling.id;
  sessions.get('one', target.id).protocol = 'legacy';
  await assert.rejects(sessions.delete('one', target.id), { code: 'DELETE_UNSUPPORTED' });
  assert.equal(sessions.get('one', target.id).exited, false);
});

test('deleting a restored session cleans all replay generations and capture directories', async t => {
  const { storage, sessions, create } = await setup(t);
  const original = await create('original');
  await sessions.archive('one', original.id);
  const adapter = sessions.adapter('one', 'codex');
  adapter.capabilities.restore = true;
  for (let index = 0; index < 2; index++) {
    const restored = await sessions.restore('one', original.id);
    sessions.get('one', restored.id).contextId = original.id;
    await sessions.archive('one', restored.id);
  }
  const record = await sessions.readArchive('one', original.id);
  assert.equal(record.logIds.length, 3);
  for (const id of record.logIds) {
    await mkdir(await storage.path(`plugin-data/one/capture/${id}`), { recursive: true });
  }
  await sessions.delete('one', original.id);
  for (const id of record.logIds) {
    for (const kind of ['logs', 'capture']) {
      await assert.rejects(stat(await storage.path(`plugin-data/one/${kind}/${id}`)), { code: 'ENOENT' });
    }
  }
});

test('local cleanup retry after restart never repeats native deletion or restores deleted context', async t => {
  const { storage, sessions, create } = await setup(t);
  const target = await create('cleanup retry');
  const path = storage.path.bind(storage);
  let failCleanup = true;
  let nativeCalls = 0;
  sessions.deleteContext = async () => { nativeCalls++; };
  storage.path = async key => {
    if (failCleanup && key === `plugin-data/one/capture/${target.id}`) {
      throw Error('temporary IO failure');
    }
    return path(key);
  };
  await assert.rejects(sessions.delete('one', target.id), /temporary IO failure/);
  assert.equal(nativeCalls, 1);
  failCleanup = false;
  sessions.active.clear();
  const loaded = new Sessions({ storage, adapter: () => ({ resolveContext: () => undefined }),
    guard: (_id, work) => work(), deleteContext: async () => { nativeCalls++; } });
  await loaded.loadPlugin('one');
  await assert.rejects(loaded.restore('one', target.id), { code: 'CONTEXT_DELETED' });
  await loaded.delete('one', target.id);
  assert.equal(nativeCalls, 1);
  assert.equal(loaded.list('one').archives.length, 0);
});
