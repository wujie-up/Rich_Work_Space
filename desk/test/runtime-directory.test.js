import test from 'node:test';
import assert from 'node:assert/strict';
import { Plugins } from '../src/main/common/plugins.js';
import { pluginProperties } from '../src/main/common/plugin-manifest.js';
import { temporaryStore } from './helpers.js';

test('runtime directory exposes only live identities without activating lazy plugins or leaking persisted data', async t => {
  const plugins = new Plugins({ storage: await temporaryStore(t) });
  const source = { id: 'observer', instanceId: 'current', child: { pid: 42 }, ownedPids: new Set([43]) };
  plugins.records.set('observer', { id: 'observer', name: 'Observer', state: 'enabled', pid: 999, secret: 'hidden' });
  plugins.records.set('lazy', { id: 'lazy', name: 'Lazy', state: 'enabled' });
  plugins.loaded.set('observer', source);
  const read = () => plugins.serviceRequest({ action: 'host.runtimeDirectory' }, undefined, source);
  assert.deepEqual(await read(), { version: 1, plugins: [
    { pluginId: 'observer', name: 'Observer', state: 'enabled', instanceId: 'current', pid: 42, ownedPids: [43] }
  ] });
  assert.equal(plugins.loaded.has('lazy'), false);
  assert.equal(plugins.list()[0].running, true);
  source.closed = true;
  await assert.rejects(read(), { code: 'PLUGIN_UNAVAILABLE' });
  source.closed = false;
  plugins.loaded.delete('observer');
  await assert.rejects(read(), { code: 'PLUGIN_UNAVAILABLE' });
});

test('runtime directory rejects foreign instances and stopping callers and never returns closed peers', async t => {
  const plugins = new Plugins({ storage: await temporaryStore(t) });
  const source = { id: 'observer', instanceId: 'new', child: { pid: 42 }, ownedPids: new Set() };
  plugins.records.set('observer', { id: 'observer', name: 'Observer', state: 'enabled' });
  plugins.loaded.set('observer', source);
  await assert.rejects(plugins.serviceRequest({ action: 'host.runtimeDirectory' }, undefined, { ...source }),
    { code: 'PLUGIN_UNAVAILABLE' });
  plugins.loaded.set('dead', { id: 'dead', closed: true, child: { pid: 55 } });
  assert.equal((await plugins.serviceRequest({ action: 'host.runtimeDirectory' }, undefined, source)).plugins.length, 1);
  plugins.quitting = true;
  await assert.rejects(plugins.serviceRequest({ action: 'host.runtimeDirectory' }, undefined, source), { code: 'PLUGIN_BUSY' });
});

const manifest = { type: 'application', showIcon: true, loadOnStartup: true, background: 'service', main: 'index.mjs',
  requiredHostFeatures: ['desk.overlays.v1', 'desk.runtime-directory.v1'],
  views: [{ id: 'main', title: 'Metrics', entry: 'index.html', presentation:
    { type: 'overlay', width: 380, height: 360, collapsedWidth: 340, collapsedHeight: 36 } }] };

test('overlay contract accepts bounded geometry and rejects malformed presentations', () => {
  assert.equal(pluginProperties(manifest).views[0].presentation.type, 'overlay');
  for (const change of [{ type: 'unknown' }, { width: -1 }, { height: Infinity }, { collapsedHeight: 1 }, { width: '380' }]) {
    const value = structuredClone(manifest);
    Object.assign(value.views[0].presentation, change);
    assert.throws(() => pluginProperties(value), { code: 'INVALID_PACKAGE' });
  }
});
