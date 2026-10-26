import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Conversations } from '../../ai-agent/src/main/common/conversations.js';
import { CaptureManager } from '../../ai-agent/src/main/common/capture/manager.js';
import { SessionCaptureClient } from '../src/main/common/session-client.js';

test('two real conversation groups capture only the selected dialogue through the public service contract', async t => {
  let conversations;
  let manager;
  let upstream;
  t.after(async () => {
    await conversations?.stop();
    await manager?.close();
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  });
  const storage = await temporaryStore(t);
  upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the real request stream. */ }
    res.setHeader('content-type', 'application/json');
    res.end('{"output":"local response"}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const original = `http://127.0.0.1:${upstream.address().port}/v1`;
  class NetworkEngine {
    constructor(options) { Object.assign(this, options); }
    async start(launch) {
      const override = launch.args.find(arg => arg.startsWith('openai_base_url='));
      this.url = override ? JSON.parse(override.slice('openai_base_url='.length)) : original;
    }
    async request(method, params) {
      if (method === 'thread/start') { return { thread: { id: randomUUID() } }; }
      if (method === 'turn/start') {
        await (await fetch(`${this.url}/responses`, { method: 'POST', body: JSON.stringify(params.input) })).text();
        this.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        return { turn: { id: randomUUID() } };
      }
      return {};
    }
    close() {}
  }
  const runtime = { launch: async () => ({ engineId: 'codex', profileId: 'default', runtimeId: 'test', args: [], env: {} }) };
  conversations = new Conversations({ storage, pluginId: 'ai-test', runtime, Engine: NetworkEngine, emit() {}, ownProcesses() {},
    createGateway: () => ({ start: async () => {}, close: async () => {}, refreshCatalog: async () => false }) });
  await conversations.load();
  const aWindow = await conversations.registerWindow({ id: randomUUID() });
  const bWindow = await conversations.registerWindow({ id: randomUUID() });
  const a = await conversations.create({ cwd: storage.root, windowId: aWindow.id });
  const b = await conversations.create({ cwd: storage.root, windowId: bWindow.id });
  manager = new CaptureManager({ root: join(storage.root, 'capture'), conversations, destination: async () => ({ upstream: original }) });
  conversations.capture = manager;
  const provider = { pluginId: 'ai-test', contract: 'agent.capture.v2', method: 'capture.service' };
  const viewer = new SessionCaptureClient({ discover: async () => [provider], invoke: (_provider, input) => manager.handle(input) });
  const sources = await viewer.sources();
  assert.equal(sources[0].windows.length, 2);
  const target = record => ({ pluginId: provider.pluginId, instanceId: manager.instanceId, windowId: record.windowId, conversationId: record.id });
  await viewer.configure({ target: target(a), enabled: true });
  await conversations.send(a.id, 'WINDOW_A_CONTEXT');
  await conversations.send(b.id, 'WINDOW_B_CONTEXT');
  await manager.relays.get(a.id).log.flush();
  assert.equal(manager.relays.has(b.id), false);
  const filesA = await viewer.list();
  const pageA = await viewer.read(filesA[0].id, 0);
  const logA = Buffer.from(pageA.data, 'base64').toString();
  assert.ok(logA.includes('WINDOW_A_CONTEXT'));
  assert.ok(!logA.includes('WINDOW_B_CONTEXT'));
  assert.equal((await viewer.status()).state, 'captured');
  await viewer.configure({ target: target(b), enabled: true });
  const sequenceA = manager.relays.get(a.id).log.sequence;
  await conversations.send(a.id, 'A_AFTER_STOP');
  await conversations.send(b.id, 'B_AFTER_START');
  await manager.relays.get(b.id).log.flush();
  assert.equal(manager.relays.get(a.id).log.sequence, sequenceA);
  const filesB = await viewer.list();
  const logB = Buffer.from((await viewer.read(filesB[0].id, 0)).data, 'base64').toString();
  assert.ok(logB.includes('B_AFTER_START'));
  assert.ok(!logB.includes('A_AFTER_STOP'));
  await viewer.stop();
});
