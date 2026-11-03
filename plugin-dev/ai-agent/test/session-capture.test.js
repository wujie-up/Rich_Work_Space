import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CaptureManager } from '../src/main/common/capture/manager.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('Claude capture retains the official upstream when no provider address is configured', async () => {
  const manager = new CaptureManager({});
  const target = await manager.target({ engineId: 'claude' }, { env: {} });
  assert.equal(target.upstream, 'https://api.anthropic.com');
  assert.ok(target.paths.test('/v1/messages'));
  assert.ok(target.paths.test('/v1/messages/count_tokens'));
  assert.ok(target.paths.test('/v1/models'));
  assert.equal(target.paths.test('/outside'), false);
});

for (const protocol of ['managed-conversation', 'managed-terminal']) {
  test(`Claude ${protocol} capture forwards to the configured provider with its path and redacts credentials`, async t => {
    const storage = await temporaryStore(t);
    const received = [];
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) { chunks.push(chunk); }
      received.push({ path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: provider-response\n\n');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    });
    const record = { id: randomUUID(), windowId: randomUUID(), engineId: 'claude', protocol, state: 'idle' };
    const manager = new CaptureManager({ root: storage.root,
      conversations: { records: new Map([[record.id, record]]), engines: new Map() } });
    t.after(() => manager.close());
    const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}/anthropic/`,
      ANTHROPIC_AUTH_TOKEN: 'synthetic-provider-token', ANTHROPIC_MODEL: 'configured-model' };
    assert.equal((await manager.target(record, { env })).upstream, env.ANTHROPIC_BASE_URL);
    await manager.handle({ action: 'configure', instanceId: manager.instanceId, windowId: record.windowId,
      conversationId: record.id, ownerId: randomUUID(), enabled: true });
    const launch = await manager.prepare(record, { args: [], env });
    const body = JSON.stringify({ model: launch.env.ANTHROPIC_MODEL, messages: [{ role: 'user', content: 'provider-context' }] });
    const response = await fetch(`${launch.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST',
      headers: { authorization: `Bearer ${launch.env.ANTHROPIC_AUTH_TOKEN}` }, body });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: provider-response\n\n');
    assert.deepEqual(received, [{ path: '/anthropic/v1/messages?beta=true', authorization: 'Bearer synthetic-provider-token', body }]);
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${upstream.address().port}/anthropic/`);
    const log = manager.relays.get(record.id).log;
    await log.flush();
    const logs = (await Promise.all((await readdir(log.root)).map(file => readFile(join(log.root, file), 'utf8')))).join('');
    assert.ok(logs.includes('provider-context'));
    assert.ok(logs.includes('provider-response'));
    assert.equal(logs.includes(env.ANTHROPIC_AUTH_TOKEN), false);
  });
}

test('capture is per conversation, validates window and instance, leases expire without breaking forwarding', async t => {
  const storage = await temporaryStore(t);
  const windowId = randomUUID();
  const a = { id: randomUUID(), windowId, engineId: 'codex', state: 'idle' };
  const b = { id: randomUUID(), windowId, engineId: 'claude', state: 'idle' };
  const records = [a, b];
  const conversations = { windows: new Map([[windowId, { id: windowId, name: '窗口 1' }]]), list: () => records,
    read: id => records.find(r => r.id === id), engines: new Map(), locks: new Set() };
  let now = 0;
  const relays = [];
  const manager = new CaptureManager({ root: storage.root, conversations, now: () => now,
    destination: async record => ({ upstream: record.engineId === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://api.anthropic.com' }),
    createProxy: options => { const relay = { ...options, url: `http://127.0.0.1:1234/${'a'.repeat(64)}`, start: async () => {}, close: async () => {},
      log: { sequence: 0, list: async () => [], flush: async () => {}, root: storage.root } }; relays.push(relay); return relay; } });
  t.after(() => manager.close());
  const catalog = manager.catalog();
  assert.equal(catalog.windows[0].conversations.length, 2);
  const target = { instanceId: manager.instanceId, windowId, conversationId: a.id, ownerId: randomUUID() };
  await assert.rejects(manager.handle({ ...target, instanceId: randomUUID(), action: 'status' }), /实例/);
  await assert.rejects(manager.handle({ ...target, windowId: randomUUID(), action: 'status' }), /窗口/);
  assert.equal((await manager.prepare(a, { args: [], env: {} })).key, null);
  await manager.handle({ ...target, action: 'configure', enabled: true });
  const launch = await manager.prepare(a, { args: ['original'], env: {} });
  assert.ok(launch.args.includes(`openai_base_url=${JSON.stringify(relays[0].url)}`));
  assert.equal((await manager.prepare(b, { args: [], env: {} })).key, null);
  await assert.rejects(manager.handle({ ...target, action: 'configure', enabled: true, ownerId: randomUUID() }), /占用/);
  now = 21000;
  assert.equal(relays[0].isRecording(), false);
  assert.equal((await manager.prepare(a, { args: [], env: {} })).key, relays[0].url, 'expired recording keeps original relay forwarding');
  const claudeTarget = { ...target, conversationId: b.id };
  await manager.handle({ ...claudeTarget, action: 'configure', enabled: true });
  const claude = await manager.prepare(b, { args: [], env: { ORIGINAL: 'kept' } });
  assert.equal(claude.env.ANTHROPIC_BASE_URL, relays[1].url);
  assert.equal(claude.env.ORIGINAL, 'kept');
  assert.equal(relays[1].identity.conversationId, b.id);
});

test('terminal sessions appear in their owning window and managed launches are routed before recording is selected', async t => {
  const storage = await temporaryStore(t);
  const windowId = randomUUID();
  const session = { id: randomUUID(), windowId, adapterId: 'codex', protocol: 'managed-terminal', name: '终端会话', activity: 'idle' };
  const sessions = { active: new Map([[session.id, session]]) };
  const manager = new CaptureManager({ root: storage.root, sessions,
    conversations: { windows: new Map([[windowId, { name: '窗口 1' }]]), records: new Map(), engines: new Map() },
    destination: async () => ({ upstream: 'http://127.0.0.1:1' }),
    createProxy: options => ({ ...options, url: 'http://127.0.0.1:1234/proxy', log: { sequence: 0 },
      start: async () => {}, close: async () => {} }) });
  t.after(() => manager.close());
  const catalog = manager.catalog();
  assert.equal(catalog.windows[0].conversations[0].id, session.id);
  assert.equal(catalog.windows[0].conversations[0].supported, true);
  const launch = await manager.prepare({ ...session, engineId: session.adapterId }, { args: [], env: {} });
  session.captureKey = launch.key;
  const target = { instanceId: manager.instanceId, windowId, conversationId: session.id, ownerId: randomUUID() };
  assert.equal(manager.relays.get(session.id).isRecording(), false);
  assert.equal((await manager.handle({ ...target, action: 'configure', enabled: true })).state, 'connected');
  assert.equal(manager.relays.get(session.id).isRecording(), true);
  await assert.rejects(manager.handle({ ...target, windowId: randomUUID(), action: 'status' }), /窗口/);
  session.protocol = 'legacy';
  assert.equal(manager.catalog().windows[0].conversations[0].supported, false);
  await assert.rejects(manager.handle({ ...target, action: 'configure', enabled: true }), /支持/);
  await manager.release(session.id);
  assert.equal(manager.relays.has(session.id), false);
  assert.equal(manager.leases.has(session.id), false);
});
