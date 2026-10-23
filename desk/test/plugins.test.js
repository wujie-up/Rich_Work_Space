import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';
import { PluginRuntime } from '../src/main/common/plugin-runtime.js';

const implementation = `let tasks=[]; let attempts=0; let context;
export function activate(c) {
 context=c;
 c.methods.register('tasks.create', async(name)=>{await new Promise(r=>setTimeout(r,40)); const task={id:String(tasks.length),name};tasks.push(task);return task;},{exclusive:true});
 c.methods.register('tasks.list',()=>tasks);
 c.methods.register('tasks.crash',()=>process.exit(23));
 c.methods.register('tasks.hang',()=>{while(true){}});
 c.methods.register('tasks.ping',()=> 'pong');
 c.lifecycle.register({snapshot:()=>tasks,stop:async(reason)=>{await c.storage.writeJson('plugin-data/'+c.pluginId+'/closed.json',{reason,tasks});tasks=[];}});
 c.views.register({id:'view',title:'Test',entry:'index.html'});
}
export function deactivate() {if (context.pluginId==='retry-plugin' && attempts++===0) throw Error('deactivate failed');}`;
async function setup(t, id = 'test-agent', options = {}) {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage, ...options });
  t.after(async () => {
    for (const runtime of plugins.loaded.values()) {
      await runtime.close();
    }
  });
  const source = await fixture(storage, id);
  await writeFile(join(source, 'index.mjs'), implementation);
  await plugins.install(source);
  return { storage, plugins, source };
}
async function ready(plugins, id) {
  for (let n = 0; n < 200 && plugins.operations.has(id); n++) {
    await delay(10);
  }
}

test('force quit bypasses a hung snapshot and preserves enabled records and saved data', async (t) => {
  const { plugins, storage } = await setup(t);
  await storage.writeJson('plugin-data/test-agent/retained.json', { history: ['kept'] });
  const runtime = plugins.loaded.get('test-agent');
  const hanging = plugins.invoke('test-agent', 'tasks.hang').catch(error => error.code);
  await delay(50);
  await plugins.forceQuit();
  assert.equal(await hanging, 'PLUGIN_UNAVAILABLE');
  assert.equal(runtime.closed, true);
  assert.equal(plugins.quitting, true);
  assert.equal(plugins.record('test-agent').state, 'enabled');
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/retained.json'), { history: ['kept'] });
});

test('force quit also terminates a plugin frozen during activation', async (t) => {
  const storage = await temporaryStore(t);
  let runtime;
  const plugins = new Plugins({ storage, runtimeFactory: options => {
    runtime = new PluginRuntime(options);
    return runtime;
  } });
  t.after(async () => { await runtime?.close(); });
  const source = await fixture(storage, 'frozen-start');
  await writeFile(join(source, 'index.mjs'), 'export function activate() { while (true) {} }');
  const installing = plugins.install(source).catch(error => error.code);
  while (!runtime) {
    await delay(10);
  }
  await plugins.forceQuit();
  assert.equal(runtime.closed, true);
  assert.equal(await installing, 'PLUGIN_UNAVAILABLE');
});

test('stale confirmation, concurrent creation and distinct lifecycle intents are rejected', async (t) => {
  const { plugins } = await setup(t);
  await plugins.invoke('test-agent', 'tasks.create', ['first']);
  const stale = await plugins.preview('test-agent', 'disable');
  const creation = plugins.invoke('test-agent', 'tasks.create', ['second']);
  await assert.rejects(plugins.preview('test-agent', 'disable'), { code: 'PLUGIN_BUSY' });
  await creation;
  await assert.rejects(plugins.disable('test-agent', stale.confirmationToken), { code: 'CONFIRMATION_STALE' });
  assert.equal((await plugins.invoke('test-agent', 'tasks.list')).length, 2);
  const preview = await plugins.preview('test-agent', 'disable');
  const disabling = plugins.disable('test-agent', preview.confirmationToken);
  await assert.rejects(plugins.remove('test-agent', 'clear', preview.confirmationToken), { code: 'PLUGIN_BUSY' });
  await disabling;
  assert.equal(plugins.record('test-agent').state, 'disabled');
  await plugins.enable('test-agent');
  assert.deepEqual(await plugins.invoke('test-agent', 'tasks.list'), []);
});

test('keep tombstone survives restart; clear failure is visible and retryable', async (t) => {
  const { storage, plugins, source } = await setup(t);
  await plugins.invoke('test-agent', 'tasks.create', ['retained']);
  let preview = await plugins.preview('test-agent', 'remove');
  await plugins.remove('test-agent', 'keep', preview.confirmationToken);
  const restarted = new Plugins({ storage, builtins: [source] });
  await restarted.load();
  assert.equal(restarted.record('test-agent').state, 'uninstalled');
  await plugins.install(source);
  assert.equal((await storage.readJson('plugin-data/test-agent/closed.json')).tasks[0].name, 'retained');
  const clear = storage.clearPluginData.bind(storage);
  storage.clearPluginData = async () => { throw Error('disk failure'); };
  preview = await plugins.preview('test-agent', 'remove');
  await assert.rejects(plugins.remove('test-agent', 'clear', preview.confirmationToken), { code: 'DATA_CLEANUP_FAILED' });
  assert.equal(plugins.record('test-agent').cleanupPending, true);
  storage.clearPluginData = clear;
  await plugins.retryCleanup('test-agent');
  assert.equal(await storage.readJson('plugin-data/test-agent/closed.json'), null);
});

test('deactivation and registry write failures remain visible and retryable', async (t) => {
  const { storage, plugins } = await setup(t, 'retry-plugin');
  let preview = await plugins.preview('retry-plugin', 'disable');
  await assert.rejects(plugins.disable('retry-plugin', preview.confirmationToken), /deactivate failed/);
  assert.equal(plugins.record('retry-plugin').state, 'enabled');
  preview = await plugins.preview('retry-plugin', 'disable');
  await plugins.disable('retry-plugin', preview.confirmationToken);
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async (key, value) => {
    if (key === 'plugins.json') { throw Error('full disk'); }
    return write(key, value);
  };
  await assert.rejects(plugins.enable('retry-plugin'), /full disk/);
  assert.match(plugins.record('retry-plugin').lastError.message, /full disk/);
  storage.writeJson = write;
  await plugins.enable('retry-plugin');
  assert.equal(plugins.record('retry-plugin').lastError, null);
});

test('interrupted removal stays disabled without executing plugin code', async (t) => {
  const { storage, plugins } = await setup(t);
  const record = plugins.record('test-agent');
  await storage.writeJson('plugins.json', [{ ...record, operation: 'deleting' }]);
  const restarted = new Plugins({ storage });
  await restarted.load();
  assert.equal(restarted.loaded.size, 0);
  assert.equal(restarted.record(record.id).lastError.code, 'INTERRUPTED_OPERATION');
  const preview = await restarted.preview(record.id, 'remove');
  await restarted.remove(record.id, 'keep', preview.confirmationToken);
});

test('activation failure is contained; API 1 is rejected without running its entry', async (t) => {
  const { storage, plugins } = await setup(t);
  const source = await fixture(storage, 'broken-agent');
  await writeFile(join(source, 'index.mjs'), 'export function activate(){throw Error("activate failed");} export function deactivate(){}');
  await assert.rejects(plugins.install(source), /activate failed/);
  assert.equal(plugins.loaded.has('broken-agent'), false);
  assert.equal(plugins.record('broken-agent').state, 'disabled');
  assert.equal(await plugins.invoke('test-agent', 'tasks.ping'), 'pong');
  const manifest = await storage.readJson('source-broken-agent/plugin.json');
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, apiVersion: 1 }));
  await assert.rejects(plugins.install(source), /apiVersion=2/);
});

test('real plugin process exit and infinite loop do not stop another plugin; restart works', async (t) => {
  const { storage, plugins } = await setup(t, 'healthy-plugin', {
    runtimeFactory: (options) => new PluginRuntime({ ...options, timeout: 1000 })
  });
  const source = await fixture(storage, 'crash-plugin');
  await writeFile(join(source, 'index.mjs'), implementation);
  await plugins.install(source);
  const healthyPid = plugins.loaded.get('healthy-plugin').child.pid;
  const crashPid = plugins.loaded.get('crash-plugin').child.pid;
  assert.notEqual(healthyPid, crashPid);
  assert.notEqual(crashPid, process.pid);
  await assert.rejects(plugins.invoke('crash-plugin', 'tasks.crash'), { code: 'PLUGIN_CRASHED' });
  await ready(plugins, 'crash-plugin');
  assert.equal(await plugins.invoke('healthy-plugin', 'tasks.ping'), 'pong');
  await plugins.enable('crash-plugin');
  assert.notEqual(plugins.loaded.get('crash-plugin').child.pid, crashPid);
  await assert.rejects(plugins.invoke('crash-plugin', 'tasks.hang'), { code: 'PLUGIN_TIMEOUT' });
  await ready(plugins, 'crash-plugin');
  assert.equal(await plugins.invoke('healthy-plugin', 'tasks.ping'), 'pong');
  await plugins.enable('crash-plugin');
  assert.equal(await plugins.invoke('crash-plugin', 'tasks.ping'), 'pong');
});

test('quit blocks activation/import; failed close can be retried without claiming a closed runtime is enabled', async (t) => {
  const { storage, plugins } = await setup(t);
  const source = await fixture(storage, 'new-plugin');
  const preview = await plugins.preview('test-agent', 'disable');
  await plugins.disable('test-agent', preview.confirmationToken);
  await plugins.prepareQuit();
  await assert.rejects(plugins.enable('test-agent'), { code: 'PLUGIN_BUSY' });
  await assert.rejects(plugins.install(source), { code: 'PLUGIN_BUSY' });
  plugins.cancelQuit();
  await plugins.enable('test-agent');
  const runtime = plugins.loaded.get('test-agent');
  const close = runtime.close.bind(runtime);
  let failed = false;
  runtime.close = async () => {
    await close();
    if (!failed) {
      failed = true;
      throw Error('simulated cleanup failure');
    }
  };
  const next = await plugins.preview('test-agent', 'disable');
  await assert.rejects(plugins.disable('test-agent', next.confirmationToken), /cleanup failure/);
  assert.equal(plugins.record('test-agent').state, 'disabled');
  await plugins.enable('test-agent');
  assert.notEqual(plugins.loaded.get('test-agent'), runtime);
  assert.equal(await plugins.invoke('test-agent', 'tasks.ping'), 'pong');
});

test('invalid plugin process payload stays inside its worker', async (t) => {
  const { storage, plugins } = await setup(t);
  const source = await fixture(storage, 'bad-payload');
  await writeFile(join(source, 'index.mjs'), `export function activate(c) {
    c.methods.register('broken.call',()=>c.ownProcesses(null));
    c.methods.register('broken.raw',()=>process.send({type:'processes',pids:null}));
  } export function deactivate(){}`);
  await plugins.install(source);
  await assert.rejects(plugins.invoke('bad-payload', 'broken.call'), /进程列表无效/);
  await assert.rejects(plugins.invoke('bad-payload', 'broken.raw'), { code: 'PLUGIN_PROTOCOL_ERROR' });
  await ready(plugins, 'bad-payload');
  assert.equal(plugins.record('bad-payload').state, 'disabled');
  assert.equal(await plugins.invoke('test-agent', 'tasks.ping'), 'pong');
});

test('quit and removal retry failed crash cleanup before completing the transition', async (t) => {
  for (const action of ['quit', 'remove']) {
    const { plugins } = await setup(t, `cleanup-${action}`);
    const id = `cleanup-${action}`;
    const runtime = plugins.loaded.get(id);
    await runtime.close();
    runtime.cleanupError = Error('owned process cleanup failed');
    runtime.cleanup = Promise.reject(runtime.cleanupError);
    let retries = 0;
    let allowCleanup = false;
    runtime.close = async () => {
      retries++;
      if (!allowCleanup) {
        throw runtime.cleanupError;
      }
      runtime.cleanupError = null;
    };
    plugins.crashed(id, Error('worker exited'), runtime);
    await ready(plugins, id);
    const transition = async () => {
      if (action === 'quit') {
        await plugins.prepareQuit();
        return plugins.confirmQuit();
      }
      const preview = await plugins.preview(id, 'remove');
      return plugins.remove(id, 'keep', preview.confirmationToken);
    };
    await assert.rejects(transition(), /owned process cleanup failed/);
    assert.equal(retries, 1);
    assert.equal(plugins.recovering.get(id), runtime);
    assert.notEqual(plugins.record(id).state, 'uninstalled');
    assert.equal(Boolean(plugins.quitting), false);
    allowCleanup = true;
    await transition();
    assert.equal(retries, 2);
    assert.equal(plugins.recovering.has(id), false);
  }
});

test('opaque resource coordination blocks busy peers and writes during exclusive work, without blocking other resources', async (t) => {
  const { storage, plugins } = await setup(t);
  const sourceCode = `export function activate(c) {
    c.methods.register('resource.busy',(key,busy)=>c.resources.report([{key,busy,busyUntil:0}]));
    c.methods.register('resource.write',()=> 'written',{resource:key=>key});
    c.methods.register('resource.switch',async()=>{await new Promise(r=>setTimeout(r,80));return 'switched';},
      {resource:key=>key,resourceExclusive:true});
  } export function deactivate(){}`;
  for (const id of ['first-resource', 'second-resource']) {
    const source = await fixture(storage, id);
    await writeFile(join(source, 'index.mjs'), sourceCode);
    await plugins.install(source);
  }
  await plugins.invoke('first-resource', 'resource.busy', ['worktree-a', true]);
  await assert.rejects(plugins.invoke('second-resource', 'resource.switch', ['worktree-a']), { code: 'RESOURCE_BUSY' });
  assert.equal(await plugins.invoke('second-resource', 'resource.switch', ['worktree-b']), 'switched');
  await plugins.invoke('first-resource', 'resource.busy', ['worktree-a', false]);
  const switching = plugins.invoke('second-resource', 'resource.switch', ['worktree-a']);
  while (!plugins.resourceLocks.get('worktree-a')?.size) {
    await delay(1);
  }
  await assert.rejects(plugins.invoke('first-resource', 'resource.write', ['worktree-a']), { code: 'RESOURCE_BUSY' });
  assert.equal(await plugins.invoke('first-resource', 'resource.write', ['worktree-b']), 'written');
  await switching;
  assert.equal(await plugins.invoke('first-resource', 'resource.write', ['worktree-a']), 'written');
});

test('force disable bypasses an unresponsive plugin and preserves its data and another runtime', async (t) => {
  const { plugins, storage } = await setup(t, 'stuck-plugin');
  const other = await fixture(storage, 'healthy-plugin');
  await writeFile(join(other, 'index.mjs'), implementation);
  await plugins.install(other);
  await storage.writeJson('plugin-data/stuck-plugin/retained.json', { history: 'keep' });
  const runtime = plugins.loaded.get('stuck-plugin');
  const hanging = plugins.invoke('stuck-plugin', 'tasks.hang').catch(error => error.code);
  await delay(100);
  await plugins.forceDisable('stuck-plugin');
  assert.equal(await hanging, 'PLUGIN_UNAVAILABLE');
  assert.equal(runtime.closed, true);
  assert.equal(plugins.loaded.has('stuck-plugin'), false);
  assert.equal(plugins.record('stuck-plugin').state, 'disabled');
  assert.deepEqual(await storage.readJson('plugin-data/stuck-plugin/retained.json'), { history: 'keep' });
  assert.equal(await plugins.invoke('healthy-plugin', 'tasks.ping'), 'pong');
});

test('force disable interrupts a stuck graceful transition instead of leaving it permanently busy', async (t) => {
  const { plugins, storage } = await setup(t, 'stuck-stop');
  const source = await fixture(storage, 'stuck-stop-hook');
  await writeFile(join(source, 'index.mjs'), implementation.replace('stop:async(reason)=>{', 'stop:async(reason)=>{while(true){};'));
  await plugins.install(source);
  const preview = await plugins.preview('stuck-stop-hook', 'disable');
  const disabling = plugins.disable('stuck-stop-hook', preview.confirmationToken).catch(error => error.code);
  await delay(100);
  await plugins.forceDisable('stuck-stop-hook');
  assert.equal(await disabling, 'PLUGIN_UNAVAILABLE');
  assert.equal(plugins.record('stuck-stop-hook').state, 'disabled');
  assert.equal(plugins.loaded.has('stuck-stop-hook'), false);
  assert.equal(plugins.operations.has('stuck-stop-hook'), false);
});
