import test from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

async function setup(t, adapterId = 'codex') {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const launches = [];
  const deleted = [];
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_, work) => work(),
    processControl: async session => session.terminal.kill(),
    adapter: () => ({ capabilities: { restore: true }, resolveContext: session => session.contextId,
      buildLaunch: input => {
        launches.push(input);
        return { command: 'fixture', args: [], env: {}, isolated: true, runtimeId: 'pinned', profileId: 'account' };
      } }), deleteContext: async session => {
      assert.equal(session.exited, true, 'stop the old process before deleting native context');
      deleted.push(session.contextId);
    } });
  const record = await sessions.create('test', { adapterId, cwd: storage.root, name: '保留窗口', contextId: 'old-context',
    windowId: '11111111-1111-4111-8111-111111111111', permission: 'request-approval' });
  const session = sessions.get('test', record.id);
  session.activity = 'idle';
  pty.terminals[0].data('old conversation secret');
  t.after(() => sessions.stopAndArchive('test', 'quit'));
  return { storage, sessions, record, session, launches, deleted, pty };
}

for (const engine of ['codex', 'claude']) {
  test(`${engine} reset deletes native context and starts blank in the same logical window`, async t => {
    const { sessions, record, session, launches, deleted, pty } = await setup(t, engine);
    const sibling = await sessions.create('test', { adapterId: engine, cwd: session.cwd, name: '保留其他会话', contextId: 'sibling' });
    const replacement = await sessions.resetContext('test', record.id);
    assert.deepEqual(deleted, ['old-context']);
    assert.equal(session.exited, true);
    assert.equal(sessions.get('test', sibling.id).exited, false);
    for (const field of ['name', 'cwd', 'windowId', 'permission', 'profileId', 'runtimeId']) {
      assert.equal(replacement[field], session[field]);
    }
    assert.equal(replacement.restoredFrom, record.id);
    assert.equal(replacement.contextId, undefined);
    assert.deepEqual(replacement.logIds, [replacement.id], 'old native recovery logs cannot reintroduce prior contexts');
    assert.equal(sessions.attach('test', replacement.id).data, '');
    assert.equal(launches.at(-1).mode, 'new');
    assert.equal(launches.at(-1).contextId, undefined);
    assert.equal(sessions.list('test').sessions.length, 2);
    assert.equal(sessions.list('test').archives.length, 0);
    await sessions.archive('test', replacement.id, 'quit');
    const resumed = await sessions.restore('test', record.id);
    assert.equal(resumed.contextId, undefined, 'restore must never resurrect the deleted context');
    assert.equal(resumed.logIds.includes(record.id), false, 'later restores must not recreate the cleared lineage');
    assert.equal(sessions.attach('test', resumed.id).data, '');
  });
}

test('busy, unsupported, unknown and shared contexts cannot stop or delete a process', async t => {
  const { sessions, session, deleted } = await setup(t);
  session.activity = 'working';
  await assert.rejects(sessions.resetContext('test', session.id), { code: 'SESSION_BUSY' });
  session.activity = 'idle';
  session.protocol = 'legacy';
  await assert.rejects(sessions.resetContext('test', session.id), { code: 'DELETE_UNSUPPORTED' });
  session.protocol = 'managed-terminal';
  session.contextId = undefined;
  await assert.rejects(sessions.resetContext('test', session.id), { code: 'CONTEXT_UNKNOWN' });
  session.contextId = 'old-context';
  await sessions.create('test', { adapterId: 'codex', cwd: session.cwd, contextId: 'old-context' });
  await assert.rejects(sessions.resetContext('test', session.id), { code: 'CONTEXT_IN_USE' });
  assert.equal(session.exited, false);
  assert.deepEqual(deleted, []);
});

test('SDK failure keeps a stopped retryable window and does not launch a replacement', async t => {
  const { sessions, session, launches } = await setup(t);
  sessions.deleteContext = async () => { throw Error('SDK failure'); };
  await assert.rejects(sessions.resetContext('test', session.id), /SDK failure/);
  assert.equal(sessions.get('test', session.id).exited, true);
  assert.equal(session.nativeDeleted, undefined);
  assert.equal(launches.length, 1);
  sessions.deleteContext = async () => {};
  const replacement = await sessions.resetContext('test', session.id);
  assert.equal(replacement.contextId, undefined);
});

test('launch failure persists completed native deletion; retries and restart do not delete twice', async t => {
  const { storage, sessions, session, deleted } = await setup(t);
  const launch = sessions.launch.bind(sessions);
  sessions.launch = async () => { throw Error('launch failure'); };
  await assert.rejects(sessions.resetContext('test', session.id), /launch failure/);
  assert.equal(session.nativeDeleted, true);
  assert.equal((await storage.readJson(sessions.key(session))).nativeDeleted, true);
  sessions.launch = launch;
  const loaded = new Sessions({ storage, guard: (_, work) => work() });
  await loaded.loadPlugin('test');
  loaded.adapter = sessions.adapter;
  loaded.launch = async (_, input) => input;
  const recovered = await loaded.restore('test', session.id);
  assert.equal(recovered.contextId, undefined);
  assert.equal(recovered.output, '');
  const replacement = await sessions.resetContext('test', session.id);
  assert.equal(replacement.contextId, undefined);
  assert.deepEqual(deleted, ['old-context']);
});

test('shutdown after a launch failure retains a blank recovery without old native log lineage', async t => {
  const { sessions, session, storage } = await setup(t);
  sessions.launch = async () => { throw Error('launch failure'); };
  await assert.rejects(sessions.resetContext('test', session.id), /launch failure/);
  await sessions.stopAndArchive('test', 'quit');
  const loaded = new Sessions({ storage, guard: (_, work) => work() });
  await loaded.loadPlugin('test');
  assert.equal((await loaded.recover('test')).archives[0].reason, 'context-reset');
  loaded.adapter = () => ({ capabilities: { restore: true }, restoreContext: () => { throw Error('must not recover old logs'); } });
  loaded.launch = async (_, input) => input;
  const restored = await loaded.restore('test', session.id);
  assert.equal(restored.mode, 'new');
  assert.equal(restored.contextId, undefined);
  assert.equal(restored.output, '');
});
