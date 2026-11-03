import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineStore } from '../src/main/common/engine.js';
import { descriptors } from '../src/main/common/capabilities.js';
import { validateDescriptor, matchesSchema } from '../../../desk/src/main/common/capability-schema.js';

test('settings persist only supported engines without launching or installing anything', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ai-browser-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'chrome');
  await writeFile(executable, 'fixture');
  const store = new EngineStore({ root, platform: { chromePath: async () => executable },
    chromium: { executablePath: () => join(root, 'not-installed') }, ownProcesses: () => {} });
  assert.equal((await store.status()).engine, 'chromium');
  assert.equal((await store.status()).ready, false);
  await assert.rejects(store.save({ engine: 'arbitrary-shell' }));
  await store.save({ engine: 'chrome' });
  assert.equal((await store.status()).ready, true);
  assert.equal((await store.status()).engine, 'chrome');
  assert.equal(await store.executable(), executable);
  assert.equal((await new EngineStore({ ...store, root }).status()).engine, 'chrome');
});

test('four compact tools fit host schemas and distinguish reads from webpage mutations', () => {
  assert.equal(descriptors.length, 4);
  descriptors.forEach(descriptor => validateDescriptor(descriptor));
  const act = descriptors.find(item => item.id === 'browser.act.v1');
  assert.deepEqual(act.effects, ['browser.control']);
  assert.equal(act.execution.retry, 'never');
  assert.equal(matchesSchema({ steps: [{ op: 'fill', ref: 'e1', value: 'Ada' }], snapshotId: 'id' }, act.inputSchema), true);
  assert.equal(matchesSchema({ steps: [{ op: 'evaluate', script: 'anything' }] }, act.inputSchema), false);
  assert.equal(matchesSchema({ steps: Array.from({ length: 13 }, () => ({ op: 'reload' })) }, act.inputSchema), false);
  const observe = descriptors.find(item => item.id === 'browser.observe.v1');
  assert.equal(matchesSchema({ maxChars: 12001 }, observe.inputSchema), false);
  assert.equal(matchesSchema({ maxChars: 4000, since: 'id', mode: 'elements' }, observe.inputSchema), true);
});
