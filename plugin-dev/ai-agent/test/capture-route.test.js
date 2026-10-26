import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineManager } from '../src/main/common/engines.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('engine preparation never globally captures account probes or unrelated conversations', async t => {
  const storage = await temporaryStore(t);
  let calls = 0;
  const manager = new EngineManager({ root: storage.root, tar: {}, captureRoute: async () => { calls++; return ['-c', 'unexpected=true']; } });
  manager.runtime('codex').launch = async () => ({ command: '/codex', profileId: 'default', args: ['original'], env: {} });
  manager.prepareSources = async () => {};
  assert.deepEqual((await manager.launch(undefined, 'codex')).args, ['original']);
  assert.equal(calls, 0);
});
