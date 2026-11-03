import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { create } from 'tar';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';
import { packPackage } from '../src/main/common/plugin-package.js';
import { PluginUpdates, compareVersions } from '../src/main/common/plugin-updates.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => { for (const runtime of plugins.loaded.values()) { await runtime.close(); } });
  const source = await fixture(storage);
  await plugins.install(source);
  const directory = join(storage.root, 'updates');
  await mkdir(directory);
  const updates = new PluginUpdates({ storage, plugins });
  return { storage, plugins, source, directory, updates };
}

async function archive(source, path, changes) {
  const manifest = join(source, 'plugin.json');
  await rm(join(source, 'integrity.json'), { force: true });
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest)), ...changes }));
  await packPackage(source, path);
}

test('semantic versions compare prereleases and ignore build metadata', () => {
  for (const [left, right] of [['2.0.0', '1.10.0'], ['1.0.0', '1.0.0-rc.1'], ['1.0.0-rc.10', '1.0.0-rc.2']]) {
    assert.equal(compareVersions(left, right), 1);
    assert.equal(compareVersions(right, left), -1);
  }
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(compareVersions('latest', '1.0.0'), null);
});

test('scan discovers higher versions from direct filenames without opening archives', async t => {
  const { directory, updates, storage } = await setup(t);
  for (const name of ['test-agent-1.1.0.plg', 'test-agent-2.0.0.plg', 'unknown-plugin-9.0.0.plg',
    'test-agent-3.0.0.zip', 'test-agent-4.0.0.plg.tmp', 'test-agent-latest.plg', 'broken.plg']) {
    await writeFile(join(directory, name), 'not an archive');
  }
  await mkdir(join(directory, 'test-agent-9.0.0.plg'));
  await writeFile(join(directory, 'test-agent-9.0.0.plg', 'test-agent-10.0.0.plg'), 'not an archive');
  await updates.configure(directory);
  const result = await updates.scan();
  assert.deepEqual(result.updates.map(({ id, version }) => ({ id, version })), [{ id: 'test-agent', version: '2.0.0' }]);
  assert.deepEqual(result.errors, []);
  assert.equal((await storage.readJson('preferences.json')).pluginPackageDirectory, directory);
  assert.equal((await new PluginUpdates({ storage, plugins: updates.plugins }).scan()).updates[0].version, '2.0.0');
  await assert.rejects(updates.upgrade('test-agent', '2.0.0'), /./);
  assert.equal(updates.plugins.record('test-agent').version, '1.0.0');
  assert.deepEqual((await updates.configure('')).updates, []);
});

test('scanning executes no plugin code and failed automatic upgrades restore the running version and settings', async t => {
  const { source, directory, updates, plugins, storage } = await setup(t);
  await plugins.enable('test-agent');
  await plugins.setAutoStart('test-agent', true);
  const running = plugins.loaded.get('test-agent');
  await writeFile(join(source, 'index.mjs'), 'throw Error("candidate must not execute during discovery");');
  await archive(source, join(directory, 'test-agent-2.0.0.plg'), { version: '2.0.0' });
  await updates.configure(directory);
  const result = await updates.scan();
  assert.equal(result.updates[0].version, '2.0.0');
  assert.equal(plugins.loaded.get('test-agent'), running);
  const preview = await plugins.preview('test-agent', 'upgrade');
  await assert.rejects(updates.upgrade('test-agent', '2.0.0', preview.confirmationToken), /candidate must not execute/);
  assert.equal(plugins.record('test-agent').version, '1.0.0');
  assert.equal(plugins.record('test-agent').state, 'enabled');
  assert.equal(plugins.record('test-agent').autoStart, true);
  assert.equal(plugins.loaded.has('test-agent'), true);
  assert.equal((await storage.readJson('preferences.json')).pluginPackageDirectory, directory);
});

test('one-click upgrade preserves disabled state, config and history and rejects replaced or deleted candidates', async t => {
  const { source, directory, updates, plugins, storage } = await setup(t);
  const path = join(directory, 'test-agent-2.0.0.plg');
  await storage.writeJson('plugin-data/test-agent/history.json', { saved: true });
  await archive(source, path, { version: '2.0.0' });
  await updates.configure(directory);
  await updates.scan();
  const preview = await plugins.preview('test-agent', 'upgrade');
  await archive(source, path, { version: '0.9.0' });
  await assert.rejects(updates.upgrade('test-agent', '2.0.0', preview.confirmationToken), { code: 'UPDATE_CHANGED' });
  assert.equal(plugins.record('test-agent').version, '1.0.0');
  await archive(source, path, { version: '2.0.0' });
  await updates.scan();
  await updates.upgrade('test-agent', '2.0.0', preview.confirmationToken);
  assert.equal(plugins.record('test-agent').version, '2.0.0');
  assert.equal(plugins.record('test-agent').state, 'disabled');
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/history.json'), { saved: true });
  assert.deepEqual((await updates.scan()).updates, []);
  const nextPath = join(directory, 'test-agent-3.0.0.plg');
  await archive(source, nextPath, { version: '3.0.0' });
  await updates.scan();
  await rm(nextPath);
  await assert.rejects(updates.upgrade('test-agent', '3.0.0', preview.confirmationToken), { code: 'UPDATE_CHANGED' });
});

test('missing scan directory reports an error without changing plugins', async t => {
  const { directory, updates, plugins } = await setup(t);
  await updates.configure(join(directory, 'missing'));
  const result = await updates.scan();
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.updates, []);
  assert.equal(plugins.record('test-agent').version, '1.0.0');
});

test('scans ignore nested packages and non-plg files', async t => {
  const { source, directory, updates } = await setup(t);
  await archive(source, join(directory, 'test-agent-2.0.0.plg'), { version: '2.0.0' });
  await writeFile(join(directory, 'ignore.zip'), 'not an archive');
  await writeFile(join(directory, 'ignore.plg.tmp'), 'not an archive');
  await mkdir(join(directory, 'folder.plg'));
  await archive(source, join(directory, 'folder.plg', 'nested.plg'), { version: '3.0.0' });
  await updates.configure(directory);
  const result = await updates.scan();
  assert.deepEqual(result.errors, []);
  assert.equal(result.updates[0]?.version, '2.0.0');
});

test('configuration and cached reads never scan; explicit checks discover new packages', async t => {
  const { source, directory, updates } = await setup(t);
  await archive(source, join(directory, 'test-agent-2.0.0.plg'), { version: '2.0.0' });
  assert.deepEqual((await updates.configure(directory)).updates, []);
  assert.deepEqual((await updates.snapshot()).updates, []);
  await updates.scan();
  assert.equal((await updates.snapshot()).updates[0].version, '2.0.0');
  await archive(source, join(directory, 'test-agent-3.0.0.plg'), { version: '3.0.0' });
  assert.equal((await updates.snapshot()).updates[0].version, '2.0.0');
  await updates.scan();
  assert.equal((await updates.snapshot()).updates[0].version, '3.0.0');
});

test('concurrent manual checks coalesce without blocking cached list reads', async () => {
  const updates = new PluginUpdates({
    storage: { readJson: async () => ({ pluginPackageDirectory: '/packages' }) },
    plugins: { list: () => [] }
  });
  let complete;
  let scans = 0;
  updates.inspectDirectory = () => {
    scans++;
    return new Promise(resolve => { complete = resolve; });
  };
  const first = updates.scan();
  const second = updates.scan();
  assert.equal(scans, 1);
  assert.equal(first, second);
  assert.deepEqual(await updates.snapshot(), { directory: '/packages', updates: [], errors: [] });
  complete({ directory: '/packages', updates: [], errors: [] });
  await first;
  assert.equal(updates.pending, null);
});


test('installation rejects filename mismatches and incompatible data before replacing the plugin', async t => {
  const { source, directory, updates, plugins, storage } = await setup(t);
  await storage.writeJson('plugin-data/test-agent/history.json', { saved: true });
  const path = join(directory, 'test-agent-2.0.0.plg');
  await updates.configure(directory);
  const preview = await plugins.preview('test-agent', 'upgrade');
  for (const changes of [{ id: 'another-agent', version: '2.0.0' },
    { id: 'test-agent', version: '1.9.0' }, { id: 'test-agent', version: '2.0.0', dataVersion: 2 }]) {
    if (changes.dataVersion === 2) {
      await writeFile(join(source, 'plugin.json'), JSON.stringify({
        ...JSON.parse(await readFile(join(source, 'plugin.json'))), ...changes
      }));
      await create({ gzip: true, file: path, cwd: source }, ['plugin.json', 'index.mjs']);
    } else {
      await archive(source, path, changes);
    }
    assert.equal((await updates.scan()).updates[0].version, '2.0.0');
    await assert.rejects(updates.upgrade('test-agent', '2.0.0', preview.confirmationToken));
    assert.equal(plugins.record('test-agent').version, '1.0.0');
  }
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/history.json'), { saved: true });
});

test('filename discovery handles hyphenated IDs, prereleases and build metadata', () => {
  const updates = new PluginUpdates({ plugins: { list: () => [{ id: 'test-agent', version: '1.0.0' }] } });
  assert.equal(updates.selectUpdates(['/packages/test-agent-2.0.0-rc.2+build.1.plg',
    '/packages/test-agent-2.0.0-rc.10.plg', '/packages/test-agent-other-9.0.0.plg'])[0].version, '2.0.0-rc.10');
});
