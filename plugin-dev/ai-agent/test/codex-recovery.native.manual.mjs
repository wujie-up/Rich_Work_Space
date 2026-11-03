// Usage: node test/codex-recovery.native.manual.mjs <plugin-data-root> <session-id>
// Only the selected rollout is copied; credentials and the user's live profile remain untouched.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedRuntime, managedArgs, prepareProfile } from '../src/main/common/managed-runtime.js';
import { AppServer } from '../src/main/common/app-server.js';
import { createCodexAdapter } from '../src/main/common/adapters/codex.js';
import { SESSION_ID } from '../src/main/common/adapters/codex-session.js';

const [dataRoot, sessionId] = process.argv.slice(2);
assert.ok(dataRoot && SESSION_ID.test(sessionId || ''), 'provide the plugin data root and session ID');
const record = JSON.parse(await readFile(join(dataRoot, 'sessions', `${sessionId}.json`), 'utf8'));
const contextId = await createCodexAdapter({ dataRoot }).restoreContext(record);
assert.ok(contextId);
const runtime = await new ManagedRuntime({ root: dataRoot }).status(record.runtimeId);
assert.equal(runtime.state, 'ready');
const temporary = await mkdtemp(join(tmpdir(), 'codex-recovery-native-'));
const server = new AppServer();
try {
  const env = await prepareProfile(temporary);
  const source = join(dataRoot, 'profiles', record.profileId || 'default', 'codex');
  const file = (await readdir(source, { recursive: true }))
    .find(file => /^(sessions|archived_sessions)\//.test(file) && file.endsWith(`-${contextId}.jsonl`));
  assert.ok(file, 'the recovered native context must exist');
  await mkdir(dirname(join(env.CODEX_HOME, file)), { recursive: true });
  await copyFile(join(source, file), join(env.CODEX_HOME, file));
  await server.start({ command: runtime.command, args: managedArgs, env, cwd: temporary });
  assert.equal((await server.request('account/read', { refreshToken: false })).account, null);
  if (record.contextId && record.contextId !== contextId) {
    await assert.rejects(server.request('thread/resume', { threadId: record.contextId, cwd: temporary }));
  }
  const { thread } = await server.request('thread/resume', { threadId: contextId, cwd: temporary });
  assert.equal(thread.id, contextId);
  assert.ok(thread.turns.length > 0, 'native recovery must restore conversation turns');
  console.log(JSON.stringify({ result: 'passed', version: runtime.version, contextId, turns: thread.turns.length,
    account: 'isolated-null', modelPromptSent: false }));
} finally {
  await server.closeTask();
  await rm(temporary, { recursive: true, force: true });
}
