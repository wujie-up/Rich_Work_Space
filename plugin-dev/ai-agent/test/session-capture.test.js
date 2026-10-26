import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CaptureManager } from '../src/main/common/capture/manager.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

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
