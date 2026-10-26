import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';
import { Sessions } from '../src/main/common/sessions.js';

test('interrupted restored sessions recover into the original archive', async t => {
  const storage = await temporaryStore(t);
  const original = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const active = '11111111-1111-4111-8111-111111111111';
  const key = id => `plugin-data/test/sessions/${id}.json`;
  await storage.writeJson(key(original), { id: original, pluginId: 'test', lifecycle: 'archived', output: 'old' });
  await storage.writeJson(key(active), { id: active, pluginId: 'test', lifecycle: 'active', restoredFrom: original,
    contextId: 'native-id', output: 'old plus continued output' });
  const sessions = new Sessions({ storage });
  await sessions.loadPlugin('test');
  assert.deepEqual(sessions.list('test').archives.map(record => record.id), [original]);
  const record = await sessions.readArchive('test', original);
  assert.equal(record.reason, 'interrupted');
  assert.equal(record.contextId, 'native-id');
  assert.equal(record.output, 'old plus continued output');
  assert.equal(await storage.readJson(key(active), null), null);
});

test('restoring and archiving repeatedly replaces the original archive and retains its transcript', async t => {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_, work) => work(),
    adapter: () => ({ capabilities: { restore: true }, buildLaunch: () => ({ command: '/bin/cat', args: [] }),
      resolveContext: () => 'native-context' }), processControl: async s => s.terminal.kill() });
  const first = await sessions.create('test', { adapterId: 'test', cwd: '/tmp' });
  sessions.get('test', first.id).output = 'original transcript\n';
  await sessions.archive('test', first.id);
  for (let index = 0; index < 2; index++) {
    const restored = await sessions.restore('test', first.id);
    assert.equal(restored.contextId, 'native-context');
    assert.match(sessions.attach('test', restored.id).data, /original transcript/);
    sessions.get('test', restored.id).output += `continued ${index}\n`;
    const archived = await sessions.archive('test', restored.id);
    assert.equal(archived.id, first.id);
    assert.equal(sessions.list('test').archives.length, 1);
  }
  assert.match((await sessions.readArchive('test', first.id)).output, /continued 0\ncontinued 1/);
  const loaded = new Sessions({ storage });
  await loaded.loadPlugin('test');
  assert.equal(loaded.list('test').archives.length, 1);
});

test('restore coalesces; fork needs idle context; unsupported restore never launches', async (t) => {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const adapter = { capabilities: { restore: true, fork: true }, buildLaunch: () => ({ command: '/bin/cat', args: [] }),
    resolveContext: async () => 'context-test' };
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_, work) => work(), adapter: () => adapter,
    processControl: async (s) => s.terminal.kill() });
  const a = await sessions.create('test', { adapterId: 'test', cwd: '/tmp' });
  await assert.rejects(sessions.fork('test', a.id, 'fork'), { code: 'SESSION_BUSY' });
  sessions.get('test', a.id).activity = 'idle';
  const fork = await sessions.fork('test', a.id, 'fork');
  assert.equal(fork.contextId, 'context-test');
  await sessions.archive('test', a.id);
  const [one, two] = await Promise.all([sessions.restore('test', a.id), sessions.restore('test', a.id)]);
  assert.equal(one.id, two.id);
  assert.equal(pty.terminals.length, 3);
  adapter.resolveContext = async () => undefined;
  sessions.get('test', one.id).activity = 'idle';
  await assert.rejects(sessions.fork('test', one.id, 'unknown'), { code: 'CONTEXT_UNKNOWN' });
  assert.equal((await sessions.archive('test', one.id)).contextId, undefined, 'ambiguous resolution clears an inherited context');
  await sessions.stopAndArchive('test', 'test');
  adapter.capabilities.restore = false;
  await assert.rejects(sessions.restore('test', a.id), { code: 'UNSUPPORTED_CAPABILITY' });
});
