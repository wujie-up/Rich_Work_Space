import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sessions } from '../src/main/common/sessions.js';
import { createCodexAdapter } from '../src/main/common/adapters/codex.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const adapter = { capabilities: {}, buildLaunch: () => ({ command: 'test', args: [], env: {} }) };
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => adapter,
    guard: (_, work) => work(), processControl: async session => session.terminal.kill() });
  t.after(async () => {
    for (const session of sessions.active.values()) {
      clearTimeout(session.checkpoint);
      await session.outputWrite?.catch(() => {});
    }
  });
  return { storage, pty, sessions };
}

test('output survives a restart before the metadata checkpoint and retains the full transcript', async t => {
  const { storage, pty, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'test', cwd: storage.root });
  const output = 'first message\n' + '中'.repeat(800000) + '\nlast message';
  pty.terminals[0].data(output.slice(0, 20));
  pty.terminals[0].data(output.slice(20));
  await sessions.get('test', created.id).outputWrite;
  assert.equal((await storage.readJson(sessions.key(created))).output, '', 'metadata checkpoint has not run');
  const restarted = new Sessions({ storage });
  await restarted.loadPlugin('test');
  const archive = await restarted.readArchive('test', created.id);
  assert.equal(archive.output.length, output.length);
  assert.equal(archive.output, output);
  assert.ok(Buffer.byteLength(sessions.attach('test', created.id).data) <= 2 * 1024 * 1024);
});

test('interrupted Codex recovery reads the native context written after the last checkpoint', async t => {
  const { storage, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root });
  const nativeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await writeFile(join(sessions.get('test', created.id).sessionDataDir, 'codex-tui.log'),
    `INFO session_loop{thread_id=${nativeId}}: codex_core::session: new\n`);
  const restarted = new Sessions({ storage, adapter: () => createCodexAdapter() });
  await restarted.loadPlugin('test');
  assert.equal((await restarted.readArchive('test', created.id)).contextId, nativeId);
});

test('stale interrupted restore records cannot overwrite a newer completed archive', async t => {
  const storage = await temporaryStore(t);
  const original = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const stale = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const key = id => `plugin-data/test/sessions/${id}.json`;
  await storage.writeJson(key(original), { id: original, pluginId: 'test', lifecycle: 'archived',
    createdAt: '2026-10-27T10:00:00.000Z', closedAt: '2026-10-27T10:02:00.000Z', output: 'latest conversation', contextId: 'latest' });
  await storage.writeJson(key(stale), { id: stale, pluginId: 'test', lifecycle: 'active', restoredFrom: original,
    createdAt: '2026-10-27T09:00:00.000Z', output: 'stale conversation', contextId: 'stale' });
  const sessions = new Sessions({ storage });
  await sessions.loadPlugin('test');
  const archive = await sessions.readArchive('test', original);
  assert.equal(archive.output, 'latest conversation');
  assert.equal(archive.contextId, 'latest');
  assert.equal(sessions.list('test').archives.length, 1);
});

test('restored sessions retain all earlier output across repeated close and restart', async t => {
  const { storage, pty, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'test', cwd: storage.root });
  const original = 'original\n' + 'x'.repeat(2 * 1024 * 1024);
  pty.terminals[0].data(original);
  await sessions.archive('test', created.id);
  const restored = await sessions.restore('test', created.id);
  pty.terminals[1].data('\ncontinued');
  await sessions.archive('test', restored.id);
  const restarted = new Sessions({ storage });
  await restarted.loadPlugin('test');
  assert.equal((await restarted.readArchive('test', created.id)).output.length, original.length + '\ncontinued'.length);
});

test('Codex keeps a saved context until native startup metadata replaces it', async t => {
  const storage = await temporaryStore(t);
  const adapter = createCodexAdapter();
  const session = { sessionDataDir: storage.root, contextId: 'saved-context' };
  assert.equal(await adapter.resolveContext(session), 'saved-context');
  await mkdir(storage.root, { recursive: true });
  await writeFile(join(storage.root, 'codex-tui.log'), 'INFO startup in progress\n');
  assert.equal(await adapter.resolveContext(session), 'saved-context');
});

test('unreadable native context does not hide the persisted terminal history', async t => {
  const { storage, pty, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, contextId: 'saved-context' });
  pty.terminals[0].data('persisted terminal output');
  await sessions.get('test', created.id).outputWrite;
  await mkdir(join(sessions.get('test', created.id).sessionDataDir, 'codex-tui.log'));
  const restarted = new Sessions({ storage, adapter: () => createCodexAdapter() });
  await restarted.loadPlugin('test');
  const record = await restarted.readArchive('test', created.id);
  assert.equal(record.contextId, 'saved-context');
  assert.equal(record.output, 'persisted terminal output');
});

test('failed terminal retries preserve output older than the UI replay buffer', async t => {
  const { storage, pty, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'test', cwd: storage.root });
  const output = 'earliest message\n' + 'x'.repeat(2 * 1024 * 1024);
  pty.terminals[0].data(output);
  pty.terminals[0].exit({ exitCode: 1 });
  const restored = await sessions.restore('test', created.id);
  await sessions.archive('test', restored.id);
  assert.equal((await sessions.readArchive('test', created.id)).output.length, output.length);
});

test('output write failures stay visible and prevent an incomplete archive from replacing the session', async t => {
  const { storage, pty, sessions } = await setup(t);
  const created = await sessions.create('test', { adapterId: 'test', cwd: storage.root });
  const session = sessions.get('test', created.id);
  await rm(session.outputPath);
  await mkdir(session.outputPath);
  pty.terminals[0].data('unsaved output');
  await assert.rejects(session.outputWrite, { code: 'EISDIR' });
  assert.equal(sessions.get('test', created.id).error.code, 'OUTPUT_WRITE_FAILED');
  await assert.rejects(sessions.archive('test', created.id), { code: 'EISDIR' });
  assert.equal(sessions.list('test').archives.length, 0);
  assert.equal(sessions.attach('test', created.id).data, 'unsaved output');
});
