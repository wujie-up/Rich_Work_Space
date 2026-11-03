import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activate, deactivate } from '../src/main/common/index.js';
import { SettingsStore } from '../src/main/common/settings.js';

test('unsupported extension sites are rejected before persistence and bridge failure never locks configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-extension-config-'));
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await deactivate(); await new Promise(resolve => occupied.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const store = new SettingsStore(root);
  const defaults = await store.read();
  await assert.rejects(store.save({ site: 'https://private.example', authMode: 'web', webMode: 'extension' }), /独立登录窗口/);
  assert.equal((await store.read()).site, defaults.site);
  await writeFile(join(root, 'browser-bridge.json'), JSON.stringify({ port: occupied.address().port, token: 'a'.repeat(43) }));
  const methods = new Map();
  await activate({ pluginId: 'pingcode', storage: { path: async () => root }, ownProcesses() {},
    methods: { register: (name, method) => methods.set(name, method) }, lifecycle: { register() {} } });
  const config = await methods.get('pingcode.settings')();
  assert.equal(config.webSession.state, 'error');
  assert.ok(config.site);
  const switched = await methods.get('pingcode.saveSettings')({ webMode: 'window', site: 'https://private.example' });
  assert.equal(switched.webMode, 'window');
});
