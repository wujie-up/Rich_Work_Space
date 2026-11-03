import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => { for (const runtime of plugins.loaded.values()) { await runtime.close(); } });
  const source = await fixture(storage);
  await plugins.install(source);
  return { storage, plugins, source };
}

async function version(source, changes) {
  const path = join(source, 'plugin.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path)), ...changes }));
}

test('new plugins remain disabled without starting code, including after restart', async t => {
  const { storage, plugins } = await setup(t);
  assert.equal(plugins.record('test-agent').state, 'disabled');
  assert.equal(plugins.loaded.size, 0);
  const restarted = new Plugins({ storage });
  await restarted.load();
  assert.equal(restarted.record('test-agent').state, 'disabled');
  assert.equal(restarted.loaded.size, 0);
});

test('upgrade replaces only the selected package and retains data and enablement', async t => {
  const { storage, plugins, source } = await setup(t);
  await plugins.enable('test-agent');
  const old = plugins.loaded.get('test-agent');
  await storage.writeJson('plugin-data/test-agent/history.json', { saved: true });
  const other = await fixture(storage, 'other-plugin');
  await plugins.install(other);
  await plugins.enable('other-plugin');
  const otherRuntime = plugins.loaded.get('other-plugin');
  await version(source, { version: '2.0.0' });
  const preview = await plugins.preview('test-agent', 'upgrade');
  await plugins.upgrade('test-agent', source, preview.confirmationToken);
  assert.equal(old.closed, true);
  assert.equal(plugins.record('test-agent').version, '2.0.0');
  assert.equal(plugins.record('test-agent').state, 'enabled');
  assert.equal(plugins.loaded.get('other-plugin'), otherRuntime);
  assert.notEqual(otherRuntime.closed, true);
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/history.json'), { saved: true });
  assert.equal(JSON.parse(await readFile(join(await storage.packageDirectory('test-agent'), 'plugin.json'))).version, '2.0.0');
});

test('upgrade validates identity and data version before stopping the old plugin', async t => {
  const { plugins, source } = await setup(t);
  await plugins.enable('test-agent');
  const old = plugins.loaded.get('test-agent');
  const preview = await plugins.preview('test-agent', 'upgrade');
  await version(source, { id: 'wrong-plugin' });
  await assert.rejects(plugins.upgrade('test-agent', source, preview.confirmationToken), { code: 'INVALID_PACKAGE' });
  await version(source, { id: 'test-agent', dataVersion: 2 });
  await assert.rejects(plugins.upgrade('test-agent', source, preview.confirmationToken), { code: 'INVALID_PACKAGE' });
  assert.equal(plugins.loaded.get('test-agent'), old);
  assert.notEqual(old.closed, true);
});

test('failed upgraded activation restores the old package and saved data', async t => {
  const { storage, plugins, source } = await setup(t);
  await plugins.enable('test-agent');
  await storage.writeJson('plugin-data/test-agent/history.json', { saved: true });
  await version(source, { version: '2.0.0' });
  await writeFile(join(source, 'index.mjs'), 'export function activate() { throw Error("broken upgrade"); } export function deactivate() {}');
  const preview = await plugins.preview('test-agent', 'upgrade');
  await assert.rejects(plugins.upgrade('test-agent', source, preview.confirmationToken), /broken upgrade/);
  assert.equal(plugins.record('test-agent').version, '1.0.0');
  assert.equal(plugins.record('test-agent').state, 'enabled');
  assert.equal(plugins.loaded.has('test-agent'), true);
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/history.json'), { saved: true });
  assert.equal((await readdir(await storage.path('plugins'))).some(name => name.startsWith('.upgrade-')), false);
});

test('disabled plugin upgrades remain disabled', async t => {
  const { plugins, source } = await setup(t);
  await version(source, { version: '2.0.0' });
  const preview = await plugins.preview('test-agent', 'upgrade');
  await plugins.upgrade('test-agent', source, preview.confirmationToken);
  assert.equal(plugins.record('test-agent').state, 'disabled');
  assert.equal(plugins.loaded.size, 0);
});
