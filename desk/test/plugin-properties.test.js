import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { inspectPackage } from '../src/main/common/plugin-package.js';
import { Plugins } from '../src/main/common/plugins.js';

async function source(t, properties) {
  const storage = await temporaryStore(t);
  const directory = await fixture(storage);
  const manifest = await storage.readJson('source-test-agent/plugin.json');
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({ ...manifest, ...properties }));
  const plugins = new Plugins({ storage });
  t.after(async () => {
    for (const runtime of plugins.loaded.values()) {
      await runtime.close();
    }
  });
  return { storage, directory, plugins };
}

test('legacy manifests keep their application and persistent startup defaults', async t => {
  const { directory } = await source(t, {});
  const manifest = await inspectPackage(directory);
  assert.deepEqual([manifest.type, manifest.showIcon, manifest.loadOnStartup, manifest.background],
    ['application', true, true, 'service']);
});

test('resource and pure UI packages have no backend and survive keep-data reinstall', async t => {
  const { directory, plugins, storage } = await source(t, {
    type: 'resource', showIcon: false, loadOnStartup: true, background: 'none', main: undefined
  });
  await plugins.install(directory);
  assert.equal(plugins.loaded.size, 0);
  assert.equal(plugins.list()[0].showIcon, false);
  await storage.writeJson('plugin-data/test-agent/settings.json', { retained: true });
  const preview = await plugins.preview('test-agent', 'remove');
  await plugins.remove('test-agent', 'keep', preview.confirmationToken);
  await plugins.install(directory);
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/settings.json'), { retained: true });
  const manifest = await storage.readJson('source-test-agent/plugin.json');
  await writeFile(join(directory, 'index.html'), '<h1>Pure UI</h1>');
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({ ...manifest, type: 'application', showIcon: true,
    views: [{ id: 'view', title: 'Pure UI', entry: 'index.html' }] }));
  const remove = await plugins.preview('test-agent', 'remove');
  await plugins.remove('test-agent', 'keep', remove.confirmationToken);
  await plugins.install(directory);
  assert.equal(plugins.loaded.size, 0);
  assert.equal(plugins.list()[0].views[0].title, 'Pure UI');
  await assert.rejects(async () => plugins.invoke('test-agent', 'unknown'), { code: 'METHOD_NOT_FOUND' });
});

test('invalid plugin property combinations and escaping static views are rejected', async t => {
  const { directory, storage } = await source(t, {});
  const manifest = await storage.readJson('source-test-agent/plugin.json');
  for (const properties of [
    { type: 'unknown' }, { showIcon: 'yes' }, { loadOnStartup: 1 }, { background: 'daemon' },
    { type: 'resource', background: 'service', showIcon: false },
    { type: 'service', showIcon: true }, { background: 'none' },
    { background: 'task', loadOnStartup: true },
    { views: [{ id: 'bad', title: 'Bad', entry: '../index.html' }] }
  ]) {
    await writeFile(join(directory, 'plugin.json'), JSON.stringify({ ...manifest, ...properties }));
    await assert.rejects(inspectPackage(directory), { code: 'INVALID_PACKAGE' });
  }
});

test('lazy service creates one backend for concurrent calls and stays alive until disabled', async t => {
  const { directory, plugins, storage } = await source(t, {
    type: 'service', showIcon: false, loadOnStartup: false, background: 'service'
  });
  await writeFile(join(directory, 'index.mjs'), `export function activate(c) {
    c.methods.register('test.pid', async () => { await new Promise(r => setTimeout(r, 30)); return process.pid; });
  } export function deactivate() {}`);
  await plugins.install(directory);
  assert.equal(plugins.loaded.size, 0);
  const restarted = new Plugins({ storage });
  await restarted.load();
  assert.equal(restarted.loaded.size, 0);
  const pids = await Promise.all([plugins.invoke('test-agent', 'test.pid'), plugins.invoke('test-agent', 'test.pid')]);
  assert.equal(pids[0], pids[1]);
  assert.notEqual(pids[0], process.pid);
  assert.equal(plugins.loaded.size, 1);
  const preview = await plugins.preview('test-agent', 'disable');
  await plugins.disable('test-agent', preview.confirmationToken);
  assert.equal(plugins.loaded.size, 0);
});

test('task backend exits after the last invocation and cannot be removed during a call', async t => {
  const { directory, plugins } = await source(t, {
    type: 'service', showIcon: false, loadOnStartup: false, background: 'task'
  });
  await writeFile(join(directory, 'index.mjs'), `export function activate(c) {
    c.methods.register('test.run', async () => { await new Promise(r => setTimeout(r, 60)); return process.pid; });
    c.methods.register('test.fail', () => { throw Error('task failed'); });
  } export function deactivate() {}`);
  await plugins.install(directory);
  assert.equal(plugins.loaded.size, 0);
  const running = plugins.invoke('test-agent', 'test.run');
  const parallel = plugins.invoke('test-agent', 'test.run');
  await assert.rejects(plugins.preview('test-agent', 'remove'), { code: 'PLUGIN_BUSY' });
  const pids = await Promise.all([running, parallel]);
  assert.equal(pids[0], pids[1]);
  assert.equal(plugins.loaded.size, 0);
  assert.equal(plugins.record('test-agent').state, 'enabled');
  const next = await plugins.invoke('test-agent', 'test.run');
  assert.notEqual(next, pids[0]);
  await assert.rejects(plugins.invoke('test-agent', 'test.fail'), /task failed/);
  assert.equal(plugins.loaded.size, 0);
});

test('declarative views remain available after a lazy application starts its backend', async t => {
  const { directory, plugins } = await source(t, {
    type: 'application', showIcon: true, loadOnStartup: false, background: 'service',
    views: [{ id: 'main', title: 'Declared UI', entry: 'index.html' }]
  });
  await writeFile(join(directory, 'index.html'), '<h1>Declared UI</h1>');
  await writeFile(join(directory, 'index.mjs'), `export function activate(c) {
    c.methods.register('test.ping', () => 'pong');
  } export function deactivate() {}`);
  await plugins.install(directory);
  assert.equal(plugins.list()[0].views[0].title, 'Declared UI');
  await plugins.invoke('test-agent', 'test.ping');
  assert.equal(plugins.list()[0].views[0]?.title, 'Declared UI');
});

test('failed activation retains an instance whose owned-process cleanup needs retry', async t => {
  const { directory, storage } = await source(t, {});
  let closes = 0;
  const runtime = {
    get ready() { return Promise.reject(Error('activation failed')); }, closed: true,
    cleanupError: Error('cleanup failed'), cleanup: Promise.resolve(),
    async close() {
      closes++;
      if (closes === 1) { throw this.cleanupError; }
      this.cleanupError = null;
    }
  };
  const plugins = new Plugins({ storage, runtimeFactory: () => runtime });
  await assert.rejects(plugins.install(directory), /cleanup failed/);
  assert.equal(plugins.recovering.get('test-agent'), runtime);
  const preview = await plugins.preview('test-agent', 'remove');
  await plugins.remove('test-agent', 'keep', preview.confirmationToken);
  assert.equal(closes, 2);
  assert.equal(plugins.recovering.size, 0);
  assert.equal(plugins.record('test-agent').state, 'uninstalled');
});
