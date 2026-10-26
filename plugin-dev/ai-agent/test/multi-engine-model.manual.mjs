// Explicit opt-in account-copy check. Credentials exist only in the temporary profile and are never printed.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as tar from 'tar';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { EngineManager } from '../src/main/common/engines.js';
import { Conversations } from '../src/main/common/conversations.js';

const root = await mkdtemp(join(tmpdir(), 'deckpg-model-check-'));
const storage = new Storage(root);
const manager = new EngineManager({ root: join(root, 'plugin-data/ai-agent-sessions'), tar });
let conversation;
const result = {};
const localAuth = join(homedir(), '.codex/auth.json');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const before = await hash(localAuth);
try {
  await manager.runtime('codex').install(process.argv[2]);
  await manager.importAuth('codex');
  let calls = 0;
  const capabilities = {
    discover: async () => ({ catalogRevision: 1, providers: [{ state: 'ready',
      handle: { pluginId: 'fixture', instanceId: 'native', capabilityId: 'verify', version: 1, descriptorRevision: 1 },
      descriptor: { id: 'fixture.verify', title: 'work_desk_verification', description: 'Return the local verification marker. Call this tool to obtain the marker.',
        effects: ['document.read'], inputSchema: { type: 'object', properties: {}, additionalProperties: false } } }] }),
    invoke: async () => { calls++; return { invocationId: 'fixture-call', state: 'running' }; },
    getInvocation: async () => ({ invocationId: 'fixture-call', state: 'succeeded', result: { marker: 'MULTI_ENGINE_NATIVE_OK' } }),
    cancel: async () => ({})
  };
  conversation = new Conversations({ storage, pluginId: 'ai-agent-sessions', runtime: manager, capabilities,
    emit: () => {}, ownProcesses: () => {} });
  await conversation.load();
  const account = await conversation.account('account/read', { refreshToken: false }, 'codex');
  assert.ok(account.account);
  result.localAuthorizationCopy = 'recognized';
  const record = await conversation.create({ cwd: root, engineId: 'codex' });
  const { engine, gateway } = await conversation.connect(conversation.records.get(record.id));
  const status = await engine.request('mcpServerStatus/list');
  result.nativeToolCount = Object.keys(status.data.find(entry => entry.name === 'work_desk')?.tools || {}).length;
  const tool = gateway.tools[0].name;
  await conversation.send(record.id, `Call mcp__work_desk__${tool} once and return only the marker from its result. Do not use shell or other tools.`);
  const deadline = Date.now() + 90000;
  while (conversation.read(record.id).state === 'running' && Date.now() < deadline) { await delay(250); }
  const final = conversation.read(record.id);
  result.state = final.state;
  result.toolCalls = calls;
  result.errors = final.events.filter(event => event.method === 'error').map(event => ({ code: event.params?.error?.codexErrorInfo, message: event.params?.message || event.params?.error?.message }));
  result.eventTypes = [...new Set(final.events.map(event => event.method))];
  const text = final.events.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params.delta).join('');
  result.response = text.slice(0, 1200);
  result.markerReturned = text.includes('MULTI_ENGINE_NATIVE_OK') || final.events.some(event => event.params?.item?.text?.includes('MULTI_ENGINE_NATIVE_OK'));
  if (calls > 0 && result.markerReturned) { result.cloudModelToolCall = 'passed'; }
  else { result.cloudModelToolCall = 'not passed'; }
} catch (error) {
  result.failure = error.message;
} finally {
  await conversation?.stop();
  manager.stop();
  result.localAuthUnchanged = before === await hash(localAuth);
  assert.equal(result.localAuthUnchanged, true);
  console.log(JSON.stringify(result, null, 2));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (result.cloudModelToolCall !== 'passed') { process.exitCode = 1; }
