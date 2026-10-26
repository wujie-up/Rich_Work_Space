import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversations } from '../src/main/common/conversations.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('engine selection is persisted per conversation even after the default changes', async t => {
  const storage = await temporaryStore(t);
  let selected = 'claude';
  const service = new Conversations({ storage, pluginId: 'ai-test', runtime: { launch: async (_profile, id = selected) => ({
    engineId: id, runtimeId: `${id}-fixed`, runtimeVersion: '1', profileId: 'default', env: { HOME: storage.root }
  }) }, emit: () => {}, ownProcesses: () => {} });
  await service.load();
  const claude = await service.create();
  selected = 'codex';
  const codex = await service.create();
  assert.equal(service.read(claude.id).engineId, 'claude');
  assert.equal(claude.protocol, 'claude-stream');
  assert.equal(codex.engineId, 'codex');
  const explicit = await service.create({ engineId: 'claude' });
  assert.equal(explicit.runtimeId, 'claude-fixed');
  await service.stop();
});
