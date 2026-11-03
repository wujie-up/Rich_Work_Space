// Usage: node test/session-context.native.manual.mjs <isolated-codex-binary>
// Native deletion smoke with synthetic transcripts; no credentials or model requests.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from '../src/main/common/app-server.js';
import { prepareProfile, managedArgs } from '../src/main/common/managed-runtime.js';
import { deleteNativeContext } from '../src/main/common/session-deletion.js';

assert.ok(process.argv[2], 'provide the managed Codex binary');
const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-context-native-')));
const env = await prepareProfile(root);
env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const runtime = { root, runtime: () => ({ launch: async () => ({ command: process.argv[2], args: managedArgs, env }) }) };
const session = { id: randomUUID(), cwd: root, runtimeId: 'fixture', profileId: 'fixture', protocol: 'managed-terminal' };
let server;
try {
  const contextId = randomUUID();
  const timestamp = new Date().toISOString();
  const folder = join(env.CODEX_HOME, 'sessions/2026/10/29');
  await mkdir(folder, { recursive: true });
  const rollout = join(folder, `rollout-2026-10-29T10-00-00-${contextId}.jsonl`);
  await writeFile(rollout, [
    { type: 'session_meta', payload: { id: contextId, timestamp, cwd: root, source: 'cli',
      originator: 'codex_cli_rs', cli_version: '0.164.0', model_provider: 'openai' } },
    { type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'isolated deletion fixture' }] } }
  ].map(record => JSON.stringify({ timestamp, ...record })).join('\n') + '\n');
  server = new AppServer();
  await server.start({ ...await runtime.runtime().launch(), cwd: root });
  assert.equal((await server.request('account/read', { refreshToken: false })).account, null);
  assert.equal((await server.request('thread/read', { threadId: contextId, includeTurns: true })).thread.id, contextId);
  await server.closeTask();
  await deleteNativeContext(runtime, { ...session, adapterId: 'codex', contextId });
  await assert.rejects(access(rollout), { code: 'ENOENT' });
  server = new AppServer();
  await server.start({ ...await runtime.runtime().launch(), cwd: root });
  await assert.rejects(server.request('thread/read', { threadId: contextId, includeTurns: true }));
  await server.closeTask();

  server = new AppServer();
  await server.start({ ...await runtime.runtime().launch(), cwd: root });
  const emptyId = (await server.request('thread/start', { cwd: root, ephemeral: false })).thread.id;
  await server.closeTask();
  const logId = randomUUID();
  const logs = join(root, 'logs', logId);
  await mkdir(logs, { recursive: true });
  await writeFile(join(logs, 'codex-tui.log'),
    'INFO thread_spawn{}:session_init:session_init.thread_persistence{session_init.ephemeral=false}: codex_core::session::session: new\n'
    + `INFO session_loop{thread_id=${emptyId}}: codex_core::session: new\n`);
  await deleteNativeContext(runtime, { ...session, adapterId: 'codex', contextId: emptyId, logId, logIds: [logId] });

  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const claudeId = randomUUID();
  const project = join(env.CLAUDE_CONFIG_DIR, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${claudeId}.jsonl`);
  await writeFile(transcript, JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: claudeId, cwd: root,
    timestamp, message: { role: 'user', content: 'isolated deletion fixture' } }) + '\n');
  assert.equal((await sdk.listSessions({ dir: root })).some(item => item.sessionId === claudeId), true);
  await deleteNativeContext(runtime, { ...session, adapterId: 'claude', contextId: claudeId });
  await assert.rejects(access(transcript), { code: 'ENOENT' });
  assert.equal((await sdk.listSessions({ dir: root })).some(item => item.sessionId === claudeId), false);
  console.log(JSON.stringify({ codexNativeDelete: 'passed', codexEmptyDelete: 'passed', claudeSdkDelete: 'passed',
    credentials: 'isolated-empty', transcripts: 'synthetic', modelRequests: 0 }));
} finally {
  await server?.closeTask();
  await rm(root, { recursive: true, force: true });
}
