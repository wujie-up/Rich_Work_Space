import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteNativeContext } from '../src/main/common/session-deletion.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';

const session = { id: 'fixture', adapterId: 'codex', profileId: 'isolated', runtimeId: 'pinned',
  protocol: 'managed-terminal', contextId: 'native', cwd: '/tmp' };
function runtime(calls) {
  return { runtime: adapter => ({ launch: async (profile, version) => {
    calls.push([adapter, profile, version]);
    return { command: 'isolated-cli', args: [], env: { CLAUDE_CONFIG_DIR: '/tmp/isolated' } };
  } }) };
}

test('Codex deletion uses the pinned isolated engine and always closes its transport', async () => {
  const calls = [];
  const server = { start: async launch => calls.push(launch.command),
    request: async (method, params) => calls.push([method, params]), closeTask: async () => calls.push('closed') };
  await deleteNativeContext(runtime(calls), session, { server });
  assert.deepEqual(calls, [['codex', 'isolated', 'pinned'], 'isolated-cli', ['thread/delete', { threadId: 'native' }], 'closed']);
  server.request = async () => { throw Object.assign(Error('not supported'), { code: -32601 }); };
  await assert.rejects(deleteNativeContext(runtime(calls), session, { server }), { code: 'DELETE_UNSUPPORTED' });
  assert.equal(calls.at(-1), 'closed');
});

test('Claude deletion runs the official SDK helper with the isolated profile and bounded execution', async () => {
  const calls = [];
  await deleteNativeContext(runtime(calls), { ...session, adapterId: 'claude' }, {
    execute: async (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.match(args[0], /dist\/main\/claude-session-delete.mjs$/);
      assert.deepEqual(args.slice(1), ['native', '/tmp']);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, '/tmp/isolated');
      assert.equal(options.timeout, 30000);
    }
  });
  assert.deepEqual(calls, [['claude', 'isolated', 'pinned']]);
  await assert.rejects(deleteNativeContext(runtime([]), { ...session, runtimeId: undefined }), { code: 'DELETE_UNSUPPORTED' });
});

test('a stopped unsaved Codex window is deletable only when its entire log lineage proves it empty', async t => {
  const storage = await temporaryStore(t);
  const contextId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const logId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const record = { ...session, contextId, logId, logIds: [logId] };
  const home = join(storage.root, 'profiles/isolated/codex');
  const logs = join(storage.root, 'logs', logId);
  await mkdir(logs, { recursive: true });
  const initialized = 'INFO thread_spawn{}:session_init:session_init.thread_persistence{session_init.ephemeral=false}:'
    + ' codex_core::session::session: new\n'
    + `INFO session_loop{thread_id=${contextId}}: codex_core::session: new\n`;
  await writeFile(join(logs, 'codex-tui.log'), initialized);
  const managed = { root: storage.root, runtime: () => ({ launch: async () => ({ env: { CODEX_HOME: home } }) }) };
  let message = `no rollout found for thread id ${contextId}`;
  let closed = 0;
  const server = { start: async () => {}, closeTask: async () => { closed++; },
    request: async () => { throw Object.assign(Error(message), { code: -32600 }); } };
  await deleteNativeContext(managed, record, { server });
  assert.equal(closed, 1);
  await writeFile(join(logs, 'codex-tui.log'), initialized + 'INFO session_loop{}:submission_dispatch{codex.op="turn_input"}: new\n');
  await assert.rejects(deleteNativeContext(managed, record, { server }), { code: 'NATIVE_DELETE_FAILED' });
  await writeFile(join(logs, 'codex-tui.log'), initialized);
  message = 'permission denied';
  await assert.rejects(deleteNativeContext(managed, record, { server }), { code: 'NATIVE_DELETE_FAILED' });
  message = `no rollout found for thread id ${contextId}`;
  await assert.rejects(deleteNativeContext(managed, { ...record, logIds: [contextId, logId] }, { server }),
    { code: 'NATIVE_DELETE_FAILED' });
  const native = join(home, 'sessions');
  await mkdir(native, { recursive: true });
  await writeFile(join(native, `rollout-${contextId}.jsonl`), 'saved');
  await assert.rejects(deleteNativeContext(managed, record, { server }), { code: 'NATIVE_DELETE_FAILED' });
  assert.equal(closed, 5);
});
