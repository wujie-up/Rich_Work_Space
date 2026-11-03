import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectPackage, withPackageSource } from '../../../desk/src/main/common/plugin-package.js';
import { Plugins } from '../../../desk/src/main/common/plugins.js';
import { Storage } from '../../../desk/src/main/common/storage.js';

const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
const archive = resolve(`plugin-dev/dist/pingcode-${manifest.version}.plg`);

test('runtime-only gzip package has verified integrity, required views and no credential/test payload', async () => {
  const magic = (await readFile(archive)).subarray(0, 2);
  assert.equal(magic.toString('hex'), '1f8b');
  await withPackageSource(archive, async directory => {
    const manifest = await inspectPackage(directory);
    assert.equal(manifest.id, 'pingcode');
    assert.equal(manifest.singleInstance, true);
    assert.equal(manifest.loadOnStartup, false);
    assert.equal(manifest.background, 'service');
    assert.equal(manifest.settings.entry, 'dist/renderer/settings.html');
    const integrity = JSON.parse(await readFile(join(directory, 'integrity.json'), 'utf8'));
    assert.equal(integrity.algorithm, 'sha256');
    assert.ok(Object.keys(integrity.files).some(name => name.endsWith('app.css')));
    assert.equal(Object.keys(integrity.files).some(name => /^test\/|^src\/|connection\.json|\.env$/.test(name)), false);
    assert.equal(Object.keys(integrity.files).filter(name => name.startsWith('node_modules/'))
      .every(name => name.startsWith('node_modules/playwright-core/')), true);
    await writeFile(join(directory, manifest.main), '// tampered');
    await assert.rejects(inspectPackage(directory), /完整性/);
  });
});

test('packaged plugin uses an independent lazy worker, handles missing auth and preserves settings across reinstall', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pingcode-contract-'));
  const storage = new Storage(directory);
  const plugins = new Plugins({ storage });
  t.after(async () => {
    for (const runtime of plugins.loaded.values()) {
      await runtime.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  await plugins.install(archive);
  await plugins.enable('pingcode');
  assert.equal(plugins.loaded.size, 0);
  const settings = await plugins.invoke('pingcode', 'pingcode.settings');
  assert.equal(settings.valueKey, 'renwujiazhifen');
  const runtime = plugins.loaded.get('pingcode');
  assert.notEqual(runtime.child.pid, process.pid);
  const { id } = await plugins.invoke('pingcode', 'pingcode.start', [{ kind: 'projects' }]);
  let status;
  for (let i = 0; i < 100; i++) {
    status = await plugins.invoke('pingcode', 'pingcode.status', [id]);
    if (status.state !== 'running') {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(status.state, 'failed');
  assert.equal(status.error.code, 'LOGIN_REQUIRED');
  assert.equal(runtime.closed, undefined, 'expected API errors must not crash the worker');
  await plugins.invoke('pingcode', 'pingcode.saveSettings', [{ projectId: 'saved-project' }]);
  const remove = await plugins.preview('pingcode', 'remove');
  await plugins.remove('pingcode', 'keep', remove.confirmationToken);
  await plugins.install(archive);
  await plugins.enable('pingcode');
  assert.equal((await plugins.invoke('pingcode', 'pingcode.settings')).projectId, 'saved-project');
});
