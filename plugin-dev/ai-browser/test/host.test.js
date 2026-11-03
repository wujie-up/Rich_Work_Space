import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryStore, fixture } from '../../../desk/test/helpers.js';
import { Plugins } from '../../../desk/src/main/common/plugins.js';
import { createServer } from 'node:http';

test('distribution runs in a real isolated worker and exposes native tools without installing an engine', { timeout: 60000 }, async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => { await plugins.forceQuit(); await plugins.capabilities.flush(); });
  const server = createServer((req, res) => res.end('<h1>Host capability fixture</h1><button>Continue</button>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await plugins.load();
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
  await plugins.install(fileURLToPath(new URL(`../../dist/ai-browser-${manifest.version}.plg`, import.meta.url)));
  await plugins.enable('ai-browser');
  const source = await fixture(storage, 'browser-consumer');
  await writeFile(join(source, 'index.mjs'), `export function activate(c) {
    c.methods.register('probe.discover',()=>c.capabilities.discover({pluginId:'ai-browser'}));
    c.methods.register('probe.call',(handle,input)=>c.capabilities.invoke(handle,input));
    c.methods.register('probe.get',id=>c.capabilities.getInvocation(id));
  } export function deactivate(){}`);
  await plugins.install(source);
  await plugins.enable('browser-consumer');
  const catalog = await plugins.invoke('browser-consumer', 'probe.discover');
  assert.equal(catalog.providers.length, 4);
  const status = await plugins.invoke('ai-browser', 'browser.status');
  assert.equal(status.ready, false, 'host must not reuse the development machine browser cache');
  assert.equal(status.running, false);
  assert.deepEqual(status.tabs, []);
  assert.equal(plugins.loaded.get('ai-browser').ownedPids.size, 0);
  assert.notEqual(plugins.loaded.get('ai-browser').child.pid, process.pid);
  await assert.rejects(plugins.invoke('ai-browser', 'browser.install'), { code: 'NATIVE_ONLY' });
  await assert.rejects(plugins.invoke('ai-browser', 'browser.openHtml', [{ path: '/tmp/report.html' }]), { code: 'NATIVE_ONLY' });
  const tabs = catalog.providers.find(item => item.descriptor.id === 'browser.tabs.v1');
  const task = await plugins.invoke('browser-consumer', 'probe.call', [tabs.handle, {}]);
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await plugins.invoke('browser-consumer', 'probe.get', [task.invocationId]);
    if (['succeeded', 'failed'].includes(result.state)) {
      break;
    }
    await delay(20);
  }
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.result, { tabs: [], nextOffset: null });
  await plugins.invoke('ai-browser', 'browser.settings', [{ engine: 'chrome' }]);
  const control = catalog.providers.find(item => item.descriptor.id === 'browser.act.v1');
  const opening = await plugins.invoke('browser-consumer', 'probe.call', [control.handle,
    { steps: [{ op: 'open', url: `http://127.0.0.1:${server.address().port}` }] }]);
  assert.equal(plugins.capabilities.get(plugins.loaded.get('browser-consumer'), opening.invocationId).approvalRequired, true);
  await plugins.capabilities.approve(opening.invocationId, true);
  let opened;
  for (let attempt = 0; attempt < 500; attempt++) {
    opened = await plugins.invoke('browser-consumer', 'probe.get', [opening.invocationId]);
    if (['succeeded', 'failed'].includes(opened.state)) {
      break;
    }
    await delay(20);
  }
  assert.equal(opened.state, 'succeeded');
  assert.equal(opened.result.completed, 1);
  const waiting = await plugins.invoke('browser-consumer', 'probe.call', [control.handle,
    { tabId: opened.result.tabId, steps: [{ op: 'click', selector: '#does-not-exist' }] }]);
  await plugins.capabilities.approve(waiting.invocationId, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await plugins.invoke('browser-consumer', 'probe.get', [waiting.invocationId])).state === 'running') {
      break;
    }
    await delay(10);
  }
  await assert.rejects(plugins.invoke('ai-browser', 'browser.settings', [{ engine: 'chromium' }]), { code: 'RESOURCE_BUSY' },
    'changing engine cannot race with Agent operations');
  for (let attempt = 0; attempt < 250; attempt++) {
    if ((await plugins.invoke('browser-consumer', 'probe.get', [waiting.invocationId])).state === 'succeeded') {
      break;
    }
    await delay(20);
  }
  const owned = [...plugins.loaded.get('ai-browser').ownedPids];
  assert.equal(owned.length, 1);
  plugins.loaded.get('ai-browser').child.kill('SIGKILL');
  for (let attempt = 0; attempt < 250; attempt++) {
    if (plugins.record('ai-browser').state === 'disabled' && !plugins.record('ai-browser').operation) {
      break;
    }
    await delay(20);
  }
  assert.throws(() => process.kill(owned[0], 0), { code: 'ESRCH' }, 'crashed plugin cleans only its registered browser');
  assert.equal(plugins.loaded.get('browser-consumer').closed, undefined);
  assert.equal((await plugins.invoke('browser-consumer', 'probe.discover')).providers.length, 0);
  await plugins.enable('ai-browser');
  assert.equal((await plugins.invoke('ai-browser', 'browser.status')).engine, 'chrome');
  assert.equal(JSON.parse(await readFile(join(storage.root, 'plugin-data/ai-browser/settings.json'), 'utf8')).engine, 'chrome');
  await assert.rejects(plugins.invoke('browser-consumer', 'probe.call', [tabs.handle, {}]), { code: 'CAPABILITY_CHANGED' });
});
