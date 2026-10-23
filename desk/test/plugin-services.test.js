import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { Plugins } from '../src/main/common/plugins.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => { for (const runtime of plugins.loaded.values()) { await runtime.close(); } });
  for (const id of ['caller', 'provider']) {
    const source = await fixture(storage, id);
    await writeFile(join(source, 'index.mjs'), `export function activate(c) {
      c.methods.register('service.echo', async input => {
        if(input?.hang) { return new Promise(()=>{}); }
        if(input?.next) { return c.services.invoke((await c.services.discover('echo.v1')).find(p=>p.pluginId===input.next), {}); }
        return {value:input,owner:c.pluginId};
      });
      c.methods.register('private.echo',()=>42);
      c.methods.register('service.resource',()=>42,{resource:()=>c.services.invoke(
        {pluginId:'caller',contract:'echo.v1',method:'service.echo'}, {})});
      c.services.register({contract:'resource.v1',method:'service.resource'});
      c.methods.register('probe.resource',()=>c.services.invoke(
        {pluginId:'provider',contract:'resource.v1',method:'service.resource'}, {}));
      c.services.register({contract:'echo.v1',method:'service.echo'});
      c.methods.register('probe.discover',()=>c.services.discover('echo.v1'));
      c.methods.register('probe.call', (input, timeout=1000)=>c.services.invoke(
        {pluginId:'provider',contract:'echo.v1',method:'service.echo'},input,{timeout}));
      c.methods.register('probe.private',()=>c.services.invoke(
        {pluginId:'provider',contract:'echo.v1',method:'private.echo'},{}));
    } export function deactivate(){}`);
    await plugins.install(source);
  }
  return plugins;
}

test('services discover live providers and call across real workers without exposing private methods', async t => {
  const plugins = await setup(t);
  assert.equal((await plugins.invoke('caller','probe.discover')).length, 2);
  assert.deepEqual(await plugins.invoke('caller','probe.call',[{text:'hello'}]), {value:{text:'hello'},owner:'provider'});
  await assert.rejects(plugins.invoke('caller','probe.private'),{code:'SERVICE_UNAVAILABLE'});
  const preview = await plugins.preview('provider','disable');
  await plugins.disable('provider',preview.confirmationToken);
  assert.equal((await plugins.invoke('caller','probe.discover')).length,1);
  await assert.rejects(plugins.invoke('caller','probe.call',[{}]),{code:'SERVICE_UNAVAILABLE'});
});

test('service cycles and dependency timeouts return errors while the caller remains usable', async t => {
  const plugins = await setup(t);
  await assert.rejects(plugins.invoke('caller','probe.call',[{next:'caller'}]),{code:'SERVICE_CYCLE'});
  await assert.rejects(plugins.invoke('caller','probe.resource'),{code:'SERVICE_CYCLE'});
  const started = Date.now();
  await assert.rejects(plugins.invoke('caller','probe.call',[{hang:true},100]), error =>
    ['SERVICE_TIMEOUT','PLUGIN_TIMEOUT'].includes(error.code));
  assert.ok(Date.now()-started < 1500);
  assert.ok(!plugins.loaded.get('caller').closed);
  assert.ok(await plugins.invoke('caller','probe.discover'));
});
