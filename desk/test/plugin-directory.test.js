import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';
import { packPackage, withPackageSource, inspectPackage } from '../src/main/common/plugin-package.js';

test('discovers extracted plugins, preserves disabled state and data, rejects damaged siblings', async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  await mkdir(join(storage.root, 'plugins'));
  await cp(source, join(storage.root, 'plugins/test-agent'), { recursive: true });
  const broken = await fixture(storage, 'broken-agent');
  await cp(broken, join(storage.root, 'plugins/broken-agent'), { recursive: true });
  await rm(join(storage.root, 'plugins/broken-agent/index.mjs'));
  await storage.writeJson('plugin-data/test-agent/history.json', { keep: true });
  const plugins = new Plugins({ storage });
  t.after(() => plugins.forceQuit());
  await plugins.load();
  assert.equal(plugins.record('test-agent').state, 'enabled');
  assert.equal(plugins.record('broken-agent').state, 'disabled');
  assert.equal(plugins.record('broken-agent').lastError.stage, 'integrity');
  const preview = await plugins.preview('test-agent', 'disable');
  await plugins.disable('test-agent', preview.confirmationToken);
  const restored = new Plugins({ storage });
  t.after(() => restored.forceQuit());
  await restored.load();
  assert.equal(restored.record('test-agent').state, 'disabled');
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/history.json'), { keep: true });
});

test('legacy packages still activate and uninstall removes installed files', async (t) => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(() => plugins.forceQuit());
  await plugins.install(await fixture(storage));
  await plugins.forceQuit();
  await mkdir(join(storage.root, 'packages'));
  await rename(join(storage.root, 'plugins/test-agent'), join(storage.root, 'packages/test-agent'));
  const restored = new Plugins({ storage });
  t.after(() => restored.forceQuit());
  await restored.load();
  assert.equal(restored.loaded.has('test-agent'), true);
  const preview = await restored.preview('test-agent', 'remove');
  await restored.remove('test-agent', 'keep', preview.confirmationToken);
  assert.equal(restored.record('test-agent').state, 'uninstalled');
});

test('new archives detect changed and missing files using integrity hashes', async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  const archive = join(storage.root, 'test.plg');
  await packPackage(source, archive);
  await withPackageSource(archive, async directory => {
    await writeFile(join(directory, 'index.mjs'), 'changed');
    await assert.rejects(inspectPackage(directory), /完整性/);
  });
});
