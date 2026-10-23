import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchConfig } from '../src/main/common/launch-config.js';
import { temporaryStore } from '../../../../desk/test/helpers.js';
import { resolveLaunchConfig } from '../../ai-agent/src/main/common/launch-config.js';
import { createCodexAdapter } from '../../ai-agent/src/main/common/adapters/codex.js';

test('adapter persists only selection IDs and resolves live gateway settings', async t => {
  const storage = await temporaryStore(t);
  const context = {storage,pluginId:'mcp-services', services:{
    discover:async()=>[{pluginId:'other-mcp',contract:'mcp.connections.v1',method:'mcp.connections'}],
    invoke:async()=>({version:1,services:[{id:'echo',name:'Echo',state:'running',url:'http://127.0.0.1:123/mcp',headers:{Authorization:'Bearer secret'}}]})}};
  const config = new LaunchConfig(context, async () => ({ version: 1, services: [] }));
  assert.deepEqual(await config.launch({clientId:'codex'}),{version:1,overrides:[]});
  await config.save([{pluginId:'other-mcp',serviceId:'echo'}]);
  const value = await config.launch({clientId:'codex'});
  assert.ok(value.overrides.some(line=>line.includes('http://127.0.0.1:123/mcp')));
  assert.ok(!JSON.stringify(await storage.readJson('plugin-data/mcp-services/ai-config.json')).includes('secret'));
  context.services.discover=async()=>[];
  await assert.rejects(config.launch({clientId:'codex'}),{code:'MCP_SELECTION_UNAVAILABLE'});
  assert.deepEqual(await config.launch({clientId:'custom-cli'}),{version:1,overrides:[]});
});

test('AI optional discovery, conflict, permission preservation and resume/fork ordering', async()=>{
  const context={services:{discover:async()=>[]}};
  assert.deepEqual(await resolveLaunchConfig(context,'codex'),[]);
  context.services.discover=async()=>[{},{}];
  await assert.rejects(resolveLaunchConfig(context,'codex'),{code:'LAUNCH_PROVIDER_CONFLICT'});
  context.services.discover=async()=>[{}];
  context.services.invoke=async()=>({version:1,overrides:['mcp_servers.desk_test.url="http://localhost/mcp"']});
  const overrides=await resolveLaunchConfig(context,'codex');
  for (const mode of ['resume','fork']) {
    const launch=createCodexAdapter().buildLaunch({mode,contextId:'context',sessionDataDir:'/tmp/data',permission:'unrestricted',launchOverrides:overrides});
    assert.ok(launch.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.deepEqual(launch.args.slice(-2),[mode,'context']);
    assert.ok(launch.args.indexOf(overrides[0]) < launch.args.indexOf(mode));
  }
});

test('running owned services are automatically exposed without saved selections and stopped ones are omitted', async t => {
  const storage = await temporaryStore(t);
  const service = {id:'remote',name:'Remote',state:'running',url:'http://127.0.0.1:123/mcp',headers:{Authorization:'Bearer gateway'}};
  const config = new LaunchConfig({storage,pluginId:'mcp-services',services:{discover:async()=>[]}},
    async () => ({version:1,services:[service]}));
  assert.equal((await config.launch({clientId:'codex'})).overrides.length,2);
  await config.save([{pluginId:'mcp-services',serviceId:'remote'}]);
  service.state='stopped';
  assert.deepEqual(await config.launch({clientId:'codex'}),{version:1,overrides:[]});
  assert.deepEqual(await config.selected(),[{pluginId:'mcp-services',serviceId:'remote'}]);
});
