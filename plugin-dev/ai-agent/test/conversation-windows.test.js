import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Conversations } from '../src/main/common/conversations.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('window ownership persists, groups multiple conversations and never steals another window history', async t => {
  const storage = await temporaryStore(t);
  const options = { storage, pluginId: 'ai-test', runtime: { launch: async () => ({ engineId: 'codex', env: {}, profileId: 'default' }) } };
  const service = new Conversations(options);
  await service.load();
  const one = await service.registerWindow({ id: randomUUID() });
  const two = await service.registerWindow({ id: randomUUID() });
  const a = await service.create({ cwd: storage.root, windowId: one.id });
  const b = await service.create({ cwd: storage.root, windowId: one.id });
  const c = await service.create({ cwd: storage.root, windowId: two.id });
  assert.deepEqual(service.list().filter(r => r.windowId === one.id).map(r => r.id).sort(), [a.id, b.id].sort());
  await assert.rejects(service.attachWindow(c.id, one.id), /其他窗口/);
  const legacy = await service.create({ cwd: storage.root });
  await service.attachWindow(legacy.id, two.id);
  const restarted = new Conversations(options);
  await restarted.load();
  assert.equal(restarted.windows.size, 2);
  assert.equal(restarted.read(legacy.id).windowId, two.id);
  assert.equal(restarted.read(a.id).windowId, one.id);
  await assert.rejects(service.create({ cwd: storage.root, windowId: randomUUID() }), /窗口/);
});
