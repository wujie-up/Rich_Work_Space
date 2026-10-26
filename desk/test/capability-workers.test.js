import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';

const descriptor = { id: 'sample.echo', version: 1, title: 'Echo', description: 'Read test data',
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, effects: ['document.read'], confirmation: 'policy',
  execution: { timeoutMs: 300, cancellable: true, retry: 'never' } };
test('real workers register, call, cancel and revoke capability handles independently of RPC watchdog', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  for (const id of ['caller', 'provider']) {
    const source = await fixture(storage, id);
    await writeFile(join(source, 'index.mjs'), `export async function activate(c) {
      if(c.pluginId==='provider') { await c.capabilities.register(${JSON.stringify(descriptor)}, async (input,ctx)=> {
        if(input.ignore) { return new Promise(()=>{}); }
        if(input.hang) { return new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancel'),{code:'CANCELLED'})))); }
        return input;
      }); }
      c.methods.register('probe.discover',()=>c.capabilities.discover());
      c.methods.register('probe.call',(handle,input)=>c.capabilities.invoke(handle,input));
      c.methods.register('probe.get',id=>c.capabilities.getInvocation(id));
      c.methods.register('probe.cancel',id=>c.capabilities.cancel(id));
    } export function deactivate(){}`);
    await plugins.install(source);
  }
  try {
    const handle = (await plugins.invoke('caller', 'probe.discover')).providers[0].handle;
    let task = await plugins.invoke('caller', 'probe.call', [handle, { value: 42 }]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await plugins.invoke('caller', 'probe.get', [task.invocationId])).result.value, 42);
    task = await plugins.invoke('caller', 'probe.call', [handle, { hang: true }]);
    await new Promise(resolve => setTimeout(resolve, 30));
    await plugins.invoke('caller', 'probe.cancel', [task.invocationId]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await plugins.invoke('caller', 'probe.get', [task.invocationId])).state, 'cancelled');
    task = await plugins.invoke('caller', 'probe.call', [handle, { ignore: true }]);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal((await plugins.invoke('caller', 'probe.get', [task.invocationId])).error.code, 'CALL_TIMEOUT');
    assert.equal(plugins.loaded.get('provider').capabilityPending.size, 0);
    assert.equal(Boolean(plugins.loaded.get('provider').closed), false);
    await plugins.forceDisable('provider');
    assert.equal((await plugins.invoke('caller', 'probe.discover')).providers.length, 0);
    await plugins.enable('provider');
    await assert.rejects(plugins.invoke('caller', 'probe.call', [handle, {}]), { code: 'CAPABILITY_CHANGED' });
  } finally {
    await plugins.forceQuit();
    await plugins.capabilities.flush();
  }
});

test('normal host quit lets live providers unregister while blocking new registrations', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  const source = await fixture(storage, 'provider');
  await writeFile(join(source, 'index.mjs'), `export async function activate(c) {
    await c.capabilities.register(${JSON.stringify(descriptor)}, async input=>input);
    c.lifecycle.register({snapshot:()=>[],stop:async()=> {
      await c.capabilities.unregister('sample.echo',1);
      try { await c.capabilities.register(${JSON.stringify(descriptor)}, async input=>input); }
      catch(error) { if(error.code==='PROVIDER_UNAVAILABLE') { return; } throw error; }
      throw Error('Registration must be blocked during quit');
    }});
  } export function deactivate(){}`);
  await plugins.install(source);
  try {
    await plugins.prepareQuit();
    await plugins.confirmQuit();
    assert.equal(plugins.loaded.size, 0);
    assert.equal(plugins.capabilities.discover().providers.length, 0);
  } finally {
    await plugins.forceQuit();
    await plugins.capabilities.flush();
  }
});

test('stop callback can finish cross-plugin cleanup while normal calls remain blocked', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  for (const id of ['caller', 'provider']) {
    const source = await fixture(storage, id);
    await writeFile(join(source, 'index.mjs'), `export async function activate(c) {
      if(c.pluginId==='provider') {
        let release;
        let started = false;
        let cleaned = false;
        c.methods.register('probe.state',()=>({started,cleaned}));
        c.methods.register('probe.release',()=>release());
        await c.capabilities.register(${JSON.stringify(descriptor)},async()=> {
          started = true;
          await new Promise(resolve=>{release=resolve;});
          cleaned = true;
          return {cleaned};
        });
      } else {
        c.methods.register('probe.ping',()=>true);
        c.lifecycle.register({snapshot:()=>[],stop:async()=> {
          const catalog = await c.capabilities.discover();
          const task = await c.capabilities.invoke(catalog.providers[0].handle,{});
          while((await c.capabilities.getInvocation(task.invocationId)).state!=='succeeded') {
            await new Promise(resolve=>setTimeout(resolve,5));
          }
          await c.capabilities.cancel(task.invocationId);
        }});
      }
    } export function deactivate(){}`);
    await plugins.install(source);
  }
  try {
    const preview = await plugins.preview('caller', 'disable');
    const stopping = plugins.disable('caller', preview.confirmationToken);
    // Attach rejection immediately so an early lifecycle failure is reported by this assertion.
    const stopped = stopping.then(() => null, error => error);
    await assert.rejects(async () => plugins.invoke('caller', 'probe.ping'), { code: 'PLUGIN_BUSY' });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !(await plugins.invoke('provider', 'probe.state')).started) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await plugins.invoke('provider', 'probe.state')).started, true);
    await plugins.invoke('provider', 'probe.release');
    assert.equal(await stopped, null);
    assert.equal(plugins.record('caller').state, 'disabled');
    assert.equal((await plugins.invoke('provider', 'probe.state')).cleaned, true);
  } finally {
    await plugins.forceQuit();
    await plugins.capabilities.flush();
  }
});

test('long-lived gateway starts fresh capability calls after its creating RPC has returned', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  const gatewayModule = new URL('../../plugin-dev/ai-agent/src/main/common/capability-gateway.js', import.meta.url).href;
  for (const id of ['caller', 'provider']) {
    const source = await fixture(storage, id);
    await writeFile(join(source, 'index.mjs'), `import { CapabilityGateway } from ${JSON.stringify(gatewayModule)};
      let gateway;
      export async function activate(c) {
        if(c.pluginId==='provider') {
          await c.capabilities.register(${JSON.stringify(descriptor)}, async input=>input);
        } else {
          c.methods.register('probe.start',async()=> {
            gateway = new CapabilityGateway({capabilities:c.capabilities,onInvocation:()=>{}});
            await gateway.start();
            return {url:gateway.url,token:gateway.token};
          });
        }
      }
      export async function deactivate() { await gateway?.close(); }`);
    await plugins.install(source);
  }
  try {
    const { url, token } = await plugins.invoke('caller', 'probe.start');
    const request = async (method, params = {}) => {
      const response = await fetch(url, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return response.json();
    };
    const catalog = await request('tools/list');
    assert.equal(catalog.error, undefined);
    assert.equal(catalog.result.tools.length, 1);
    const result = await request('tools/call', { name: catalog.result.tools[0].name, arguments: { value: 42 } });
    assert.equal(result.result.isError, false);
    assert.deepEqual(JSON.parse(result.result.content[0].text), { value: 42 });
    await plugins.forceDisable('provider');
    assert.equal((await request('tools/list')).result.tools.length, 0);
  } finally {
    await plugins.forceQuit();
    await plugins.capabilities.flush();
  }
});
