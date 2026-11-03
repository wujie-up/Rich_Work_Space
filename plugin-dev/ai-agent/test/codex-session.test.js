import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/main/common/adapters/codex.js';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

const original = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const empty = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const previous = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const current = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const root = id => `INFO session_loop{thread_id=${id}}: codex_core::session: new\n`;
const initialized = id => 'INFO thread_spawn{otel.name="thread_spawn"}:session_init:session_init.thread_persistence{'
  + 'otel.name="session_init.thread_persistence" session_init.ephemeral=false}: codex_core::session::session: new\n' + root(id);

async function setup(t) {
  const storage = await temporaryStore(t);
  const dataRoot = await storage.path('plugin-data/test');
  const native = join(dataRoot, 'profiles/default/codex/sessions/2026/10/28');
  await mkdir(native, { recursive: true });
  for (const [id, context] of [[previous, original], [current, empty]]) {
    const dir = join(dataRoot, 'logs', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'codex-tui.log'), root(context));
  }
  await writeFile(join(native, `rollout-2026-10-28T10-00-00-${original}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: original, source: 'cli' } })}\n`);
  const record = { id: previous, pluginId: 'test', adapterId: 'codex', cwd: storage.root, contextId: empty,
    runtimeId: 'codex-test', profileId: 'default', protocol: 'managed-terminal',
    lifecycle: 'archived', logIds: [previous, current], logId: current, output: 'saved transcript' };
  return { storage, dataRoot, native, record, adapter: createCodexAdapter({ dataRoot }) };
}

test('restore repairs an unsaved context from its own log lineage and passes the saved ID to Codex', async t => {
  const { storage, adapter, record } = await setup(t);
  const pty = fakePty();
  let launchArgs;
  const sessions = new Sessions({ storage, spawn: (command, args, options) => {
    launchArgs = args;
    return pty.spawn(command, args, options);
  }, adapter: () => adapter, guard: (_, work) => work(), readGit: async () => null });
  sessions.archives.set(record.id, record);
  await storage.writeJson(sessions.key(record), record);
  const restored = await sessions.restore('test', record.id);
  assert.equal(restored.contextId, original);
  assert.deepEqual(launchArgs.slice(-2), ['resume', original]);
  assert.equal(sessions.attach('test', restored.id).data, 'saved transcript');
});

test('repeated empty launches remain recoverable only when every lineage log proves no submissions', async t => {
  const { adapter, record, dataRoot } = await setup(t);
  const oldPath = join(dataRoot, 'logs', previous, 'codex-tui.log');
  await writeFile(oldPath, initialized(previous));
  await writeFile(join(dataRoot, 'logs', current, 'codex-tui.log'), initialized(empty));
  assert.equal(await adapter.restoreContext(record), undefined);
  await writeFile(oldPath, initialized(previous) + `INFO session_loop{thread_id=${previous}}:submission_dispatch{codex.op="turn_input"}: new\n`);
  await assert.rejects(adapter.restoreContext(record), { code: 'CONTEXT_NOT_FOUND' });
});

test('a saved latest native /new stays selected and legacy sessions keep their original scope', async t => {
  const { adapter, native, record } = await setup(t);
  await writeFile(join(native, `rollout-2026-10-28T11-00-00-${empty}.jsonl`), '');
  assert.equal(await adapter.restoreContext(record), empty);
  assert.equal(await adapter.restoreContext({ ...record, protocol: 'legacy' }), empty);
});

test('missing contexts cannot select an unrelated saved conversation or silently start a new one', async t => {
  const { adapter, record, dataRoot } = await setup(t);
  await rm(join(dataRoot, 'logs', previous), { recursive: true });
  await assert.rejects(adapter.restoreContext(record), { code: 'CONTEXT_NOT_FOUND' });
  assert.equal(await adapter.restoreContext({ ...record, contextId: undefined, logIds: [], logId: undefined }), undefined);
});

test('an initialized but never submitted context restores its window without resuming a temporary ID', async t => {
  const { storage, adapter, record, dataRoot } = await setup(t);
  record.logIds = [current];
  await writeFile(join(dataRoot, 'logs', current, 'codex-tui.log'), initialized(empty));
  const pty = fakePty();
  let launchArgs;
  const sessions = new Sessions({ storage, spawn: (command, args, options) => {
    launchArgs = args;
    return pty.spawn(command, args, options);
  }, adapter: () => adapter, guard: (_, work) => work(), readGit: async () => null });
  sessions.archives.set(record.id, record);
  await storage.writeJson(sessions.key(record), record);
  const restored = await sessions.restore('test', record.id);
  assert.equal(restored.contextId, undefined);
  assert.ok(!launchArgs.includes('resume'));
  assert.equal(restored.restoredFrom, record.id);
  assert.equal(sessions.attach('test', restored.id).data, 'saved transcript');
});

test('empty recovery requires an explicit initialization and cannot discard submitted or unknown history', async t => {
  const { adapter, record, dataRoot } = await setup(t);
  record.logIds = [current];
  const path = join(dataRoot, 'logs', current, 'codex-tui.log');
  for (const log of [
    root(empty),
    initialized(empty) + `INFO session_loop{thread_id=${empty}}:submission_dispatch{codex.op="turn_input"}: new\n`,
    initialized(previous),
    initialized(empty) + initialized(previous)
  ]) {
    await writeFile(path, log);
    await assert.rejects(adapter.restoreContext(record), { code: 'CONTEXT_NOT_FOUND' });
  }
  await writeFile(path, initialized(empty));
  record.logIds = [previous, current];
  await rm(join(dataRoot, 'logs', previous), { recursive: true });
  await assert.rejects(adapter.restoreContext(record), { code: 'CONTEXT_NOT_FOUND' });
});
