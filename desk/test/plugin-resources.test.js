import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => {
    await Promise.all([...plugins.loaded.values(), ...plugins.recovering.values()].map(runtime => runtime.close()));
    await plugins.capabilities.flush();
  });
  for (const id of ['owner', 'peer']) {
    const source = await fixture(storage, id);
    await writeFile(join(source, 'index.mjs'), `import {spawn} from 'node:child_process';
      let lease;
      export async function activate(c) {
        await c.capabilities.register({id:'resource.static',version:1,title:'Read',description:'Read',
          inputSchema:{type:'object'},outputSchema:{type:'object'},effects:['document.read'],confirmation:'policy',
          execution:{timeoutMs:300,cancellable:true,retry:'never',resource:'workspace'}}, async input => {
            if (input.hang) { return new Promise(() => {}); }
            return input;
          });
        await c.capabilities.register({id:'resource.dynamic',version:1,title:'Background',description:'Background',
          inputSchema:{type:'object'},outputSchema:{type:'object'},effects:['document.read'],confirmation:'policy',
          execution:{timeoutMs:100,cancellable:true,retry:'never'}}, async input => {
            lease = await c.resources.acquire('workspace',{exclusive:true});
            if (input.hang) { return new Promise(() => {}); }
            return input;
          });
        c.lifecycle.register({snapshot:()=>[],stop:async()=>{if(lease){await lease.release();}}});
        c.methods.register('lease.acquire', async (key = 'workspace', exclusive = true) => {
          lease = await c.resources.acquire(key, {exclusive}); return true;
        });
        c.methods.register('lease.release', async () => { await lease.release(); await lease.release(); return true; });
        c.methods.register('owned.start', () => {
          const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
          c.ownProcesses([child.pid]);
          return child.pid;
        });
        c.methods.register('shared', () => true, {resource: () => 'workspace'});
        c.methods.register('exclusive', () => true, {resource: () => 'workspace', resourceExclusive: true});
        c.methods.register('report', busy => { c.resources.report([{key:'workspace',busy,busyUntil:0}]); return true; });
      }
      export function deactivate() {}`);
    await plugins.install(source);
    await plugins.enable(id);
  }
  return plugins;
}

test('persistent leases outlive RPC and coordinate existing shared and exclusive method locks', async t => {
  const plugins = await setup(t);
  assert.equal(await plugins.invoke('owner', 'lease.acquire'), true);
  for (const method of ['shared', 'exclusive', 'lease.acquire']) {
    await assert.rejects(plugins.invoke('peer', method), {code: 'RESOURCE_BUSY'});
  }
  assert.equal(await plugins.invoke('owner', 'lease.release'), true);
  assert.equal(await plugins.invoke('peer', 'shared'), true);
  assert.equal(await plugins.invoke('peer', 'lease.acquire', ['workspace', false]), true);
  assert.equal(await plugins.invoke('owner', 'shared'), true);
  await assert.rejects(plugins.invoke('owner', 'exclusive'), {code: 'RESOURCE_BUSY'});
});

test('busy reports, invalid keys and closed runtime ownership cannot bypass resource coordination', async t => {
  const plugins = await setup(t);
  await plugins.invoke('peer', 'report', [true]);
  await assert.rejects(plugins.invoke('owner', 'lease.acquire'), {code: 'RESOURCE_BUSY'});
  await plugins.invoke('peer', 'report', [false]);
  for (const key of ['', 42, 'x'.repeat(4097)]) {
    await assert.rejects(plugins.invoke('owner', 'lease.acquire', [key]), {code: 'INVALID_ARGUMENT'});
  }
  await plugins.invoke('owner', 'lease.acquire');
  const owner = plugins.loaded.get('owner');
  await owner.close();
  assert.equal(await plugins.invoke('peer', 'exclusive'), true);
  assert.equal(plugins.resourceLocks.size, 0);
});

async function completed(plugins, caller, id) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const task = plugins.capabilities.get(caller, id);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) {
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Capability did not complete');
}

test('capability resource declarations share locks with methods and retained leases', async t => {
  const plugins = await setup(t);
  const caller = plugins.loaded.get('peer');
  const handle = plugins.capabilities.discover().providers.find(entry =>
    entry.handle.pluginId === 'owner' && entry.handle.capabilityId === 'resource.static')?.handle;
  assert.ok(handle);
  await plugins.invoke('peer', 'lease.acquire');
  let task = await plugins.capabilities.invoke(caller, handle, {});
  assert.equal((await completed(plugins, caller, task.invocationId)).error.code, 'RESOURCE_BUSY');
  await plugins.invoke('peer', 'lease.release');
  task = await plugins.capabilities.invoke(caller, handle, {});
  assert.equal((await completed(plugins, caller, task.invocationId)).state, 'succeeded');
  task = await plugins.capabilities.invoke(caller, handle, {hang:true});
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(plugins.invoke('peer', 'shared'), {code:'RESOURCE_BUSY'});
  await completed(plugins, caller, task.invocationId);
  assert.equal(await plugins.invoke('peer', 'shared'), true);
});

test('capability timeout and cancellation retain a background lease until explicit release or owner cleanup', async t => {
  const plugins = await setup(t);
  const caller = plugins.loaded.get('peer');
  const handle = plugins.capabilities.discover().providers.find(entry =>
    entry.handle.pluginId === 'owner' && entry.handle.capabilityId === 'resource.dynamic')?.handle;
  assert.ok(handle);
  let task = await plugins.capabilities.invoke(caller, handle, {hang:true});
  assert.equal((await completed(plugins, caller, task.invocationId)).error.code, 'CALL_TIMEOUT');
  await assert.rejects(plugins.invoke('peer', 'shared'), {code:'RESOURCE_BUSY'});
  await plugins.invoke('owner', 'lease.release');
  task = await plugins.capabilities.invoke(caller, handle, {hang:true});
  await new Promise(resolve => setTimeout(resolve, 20));
  plugins.capabilities.cancel(caller, task.invocationId);
  await completed(plugins, caller, task.invocationId);
  await assert.rejects(plugins.invoke('peer', 'shared'), {code:'RESOURCE_BUSY'});
  await plugins.forceDisable('owner');
  assert.equal(await plugins.invoke('peer', 'exclusive'), true);
});

test('graceful stop can release a lease and a crashed owner never blocks another live runtime after cleanup', async t => {
  const plugins = await setup(t);
  await plugins.invoke('owner', 'lease.acquire');
  const preview = await plugins.preview('owner', 'disable');
  await plugins.disable('owner', preview.confirmationToken);
  assert.equal(await plugins.invoke('peer', 'exclusive'), true);
  await plugins.enable('owner');
  await plugins.invoke('owner', 'lease.acquire');
  const owner = plugins.loaded.get('owner');
  owner.child.kill('SIGKILL');
  await new Promise(resolve => owner.child.once('exit', resolve));
  await owner.cleanup;
  assert.equal(await plugins.invoke('peer', 'exclusive'), true);
});

test('owner cleanup reaps only its registered child processes before releasing persistent resources', async t => {
  const plugins = await setup(t);
  const childPid = await plugins.invoke('owner', 'owned.start');
  const peerPid = plugins.loaded.get('peer').child.pid;
  await plugins.invoke('owner', 'lease.acquire');
  await plugins.forceDisable('owner');
  assert.throws(() => process.kill(childPid, 0), {code:'ESRCH'});
  assert.doesNotThrow(() => process.kill(peerPid, 0));
  assert.equal(await plugins.invoke('peer', 'exclusive'), true);
});

test('a lease token is scoped to its original live runtime and release never removes another owner lock', async t => {
  const plugins = await setup(t);
  await plugins.invoke('owner', 'lease.acquire');
  const token = [...plugins.resourceLocks.get('workspace')][0].token;
  const peer = plugins.loaded.get('peer');
  plugins.resourceRequest({action:'resources.release',input:{token}}, undefined, peer);
  await assert.rejects(plugins.invoke('peer', 'shared'), {code:'RESOURCE_BUSY'});
  assert.throws(() => plugins.resourceRequest({action:'resources.release',input:{}}, undefined, peer), {code:'INVALID_ARGUMENT'});
  const owner = plugins.loaded.get('owner');
  await plugins.forceDisable('owner');
  await plugins.enable('owner');
  await plugins.invoke('owner', 'lease.acquire');
  assert.throws(() => plugins.resourceRequest({action:'resources.release',input:{token}}, undefined, owner), {code:'PLUGIN_UNAVAILABLE'});
  await assert.rejects(plugins.invoke('peer', 'shared'), {code:'RESOURCE_BUSY'});
});
