import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';
import { createHandlers, dispatch } from '../src/main/common/ipc.js';

test('nativeOnly survives worker registration and refuses Web/direct/service callers', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => { for (const runtime of plugins.loaded.values()) { await runtime.close(); } });
  const dir = await fixture(storage, 'native-test');
  await writeFile(join(dir, 'index.mjs'), `export function activate(c) {
    c.methods.register('admin.start', () => 'started', {nativeOnly:true});
    c.methods.register('normal', () => 'read');
    c.methods.register('bridge', () => c.host.transport.describe());
  } export function deactivate() {}`);
  await plugins.install(dir);
  await plugins.enable('native-test');
  assert.equal(await plugins.invoke('native-test', 'normal'), 'read');
  await assert.rejects(plugins.invoke('native-test', 'admin.start', [{origin:'native'}]), {code:'NATIVE_ONLY'});
  await assert.rejects(plugins.invoke('native-test', 'admin.start', [], {chain:['peer','native-test'],origin:'native'}), {code:'NATIVE_ONLY'});
  const handlers = createHandlers({plugins,storage});
  const webContents = {mainFrame:{}};
  const event = {sender:webContents,senderFrame:webContents.mainFrame};
  assert.deepEqual(await dispatch(event,webContents,handlers,'plugins.invoke',['native-test','admin.start',[]]), {ok:true,value:'started'});
  assert.equal((await dispatch({...event,senderFrame:{}},webContents,handlers,'plugins.invoke',['native-test','admin.start',[]])).ok,false);
  await assert.rejects(handlers['plugins.invoke']('native-test','admin.start',[]), {code:'NATIVE_ONLY'});
});

test('transport provider receives the live runtime and cleanup owns only that instance', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => { for (const runtime of plugins.loaded.values()) { await runtime.close(); } });
  const dir = await fixture(storage, 'transport-test');
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({ id: 'transport-test', name: 'Transport', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, main: 'index.mjs', requiredHostFeatures: ['desk.service-transport.v1'] }));
  await writeFile(join(dir, 'index.mjs'), `export function activate(c) {
    c.methods.register('describe', () => c.host.transport.describe());
  } export function deactivate() {}`);
  const calls = [];
  const closed = [];
  plugins.transport = { request: async (owner, action) => { calls.push(owner); return action; }, closeOwner: async owner => { closed.push(owner); } };
  await plugins.install(dir);
  await plugins.enable('transport-test');
  const first = plugins.loaded.get('transport-test');
  assert.equal(await plugins.invoke('transport-test', 'describe'), 'describe');
  assert.equal(calls[0], first);
  await plugins.disable('transport-test', (await plugins.preview('transport-test', 'disable')).confirmationToken);
  assert.equal(closed[0], first);
  await plugins.enable('transport-test');
  const second = plugins.loaded.get('transport-test');
  assert.notEqual(second, first);
  await assert.rejects(plugins.serviceRequest({ action: 'host.transport.describe' }, null, first));
  assert.equal(await plugins.invoke('transport-test', 'describe'), 'describe');
  assert.equal(calls[1], second);
});

test('quit allows live plugin cleanup while rejecting new work and stale instances', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => { for (const runtime of plugins.loaded.values()) { await runtime.close(); } });
  const dir = await fixture(storage, 'quit-cleanup');
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({ id: 'quit-cleanup', name: 'Quit cleanup', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, main: 'index.mjs', requiredHostFeatures: ['desk.service-transport.v1'] }));
  await writeFile(join(dir, 'index.mjs'), `export function activate(c) {
    c.lifecycle.register({ snapshot: () => [], stop: async () => {
      await c.host.transport.revoke('grant');
      await c.host.messages.cancel('request');
    } });
  } export function deactivate() {}`);
  const cleaned = [];
  plugins.transport = { request: async (owner, action, input) => { cleaned.push([owner.id, action, input]); }, closeOwner: async () => {} };
  plugins.capabilities.messages.cancel = async (owner, input) => { cleaned.push([owner.id, 'cancel', input]); };
  await plugins.install(dir);
  await plugins.enable('quit-cleanup');
  const runtime = plugins.loaded.get('quit-cleanup');
  assert.deepEqual(await plugins.prepareQuit(), []);
  for (const action of ['host.transport.open', 'host.transport.describe', 'host.messages.request', 'host.messages.get']) {
    await assert.rejects(plugins.serviceRequest({ action }, null, runtime), { code: 'PLUGIN_UNAVAILABLE' });
  }
  await plugins.confirmQuit();
  assert.deepEqual(cleaned, [['quit-cleanup', 'revoke', 'grant'], ['quit-cleanup', 'cancel', 'request']]);
  assert.equal(plugins.loaded.size, 0);
  for (const action of ['host.transport.revoke', 'host.messages.cancel']) {
    await assert.rejects(plugins.serviceRequest({ action }, null, runtime), { code: 'PLUGIN_UNAVAILABLE' });
  }
});
