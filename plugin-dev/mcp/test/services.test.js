import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpServices } from '../src/main/common/services.js';
const require = createRequire(import.meta.url);
const load = name => import(pathToFileURL(require.resolve(name)).href);

test('real stdio MCP tools, authenticated HTTP gateway and process cleanup', async t => {
  const storage = await temporaryStore(t);
  const pids = [];
  const services = new McpServices({ storage, pluginId:'mcp-services', importModule:load,
    ownProcesses: values => pids.splice(0,pids.length,...values) });
  t.after(()=>services.close());
  await services.save({id:'echo',name:'Echo',transport:'stdio',command:process.execPath,
    args:[fileURLToPath(new URL('./fixture.mjs',import.meta.url))],env:{TEST_SECRET:'secret-do-not-log'}});
  await services.start('echo');
  assert.equal((await services.tools('echo')).tools[0].name,'echo');
  assert.equal((await services.call('echo','echo',{text:'direct'})).content[0].text,'direct');
  const connection = (await services.connections()).services[0];
  assert.equal((await fetch(connection.url)).status,401);
  const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({name:'test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:connection.headers}}));
  assert.equal((await client.callTool({name:'echo',arguments:{text:'gateway'}})).content[0].text,'gateway');
  assert.ok(pids.length >= 2);
  await client.close();
  const owned = [...pids];
  await services.stop('echo');
  assert.equal((await services.connections()).services[0].state,'stopped');
  for (const pid of owned) { assert.throws(()=>process.kill(pid,0)); }
  assert.ok(!JSON.stringify(await services.logs('echo')).includes('secret-do-not-log'));
});

test('invalid configurations fail without storing executable secrets in published connections', async t => {
  const storage = await temporaryStore(t);
  const services = new McpServices({storage,pluginId:'mcp-services',importModule:load,ownProcesses:()=>{}});
  t.after(()=>services.close());
  await assert.rejects(services.save({id:'bad',name:'Bad',transport:'http',url:'file:///tmp/test'}));
  await services.save({id:'offline',name:'Offline',transport:'stdio',command:'/does/not/exist',args:[],env:{TOKEN:'secret'}});
  await assert.rejects(services.start('offline'));
  const connections = await services.connections();
  assert.equal(connections.services[0].state,'error');
  assert.ok(!JSON.stringify(connections).includes('secret'));
  await services.close();
});

test('malformed initialize and ordinary client disconnect release upstream processes', async t => {
  const storage = await temporaryStore(t);
  const pids = new Set();
  const services = new McpServices({storage, pluginId:'mcp-services', importModule:load,
    ownProcesses:values => { pids.clear(); values.forEach(pid => pids.add(pid)); }});
  t.after(() => services.close());
  await services.save({id:'cleanup', name:'Cleanup', transport:'stdio', command:process.execPath,
    args:[fileURLToPath(new URL('./fixture.mjs',import.meta.url))]});
  await services.start('cleanup');
  const connection = (await services.connections()).services[0];
  const response = await fetch(connection.url, {method:'POST', headers:{...connection.headers,
    'Content-Type':'application/json', Accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})});
  assert.equal(response.status,400);
  assert.equal(pids.size,1);
  const {Client} = await load('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport} = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({name:'disconnect',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:connection.headers}}));
  assert.equal(pids.size,2);
  await client.close();
  const deadline = Date.now()+35000;
  while (pids.size > 1 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve,50)); }
  assert.equal(pids.size,1);
  assert.equal(services.running.get('cleanup').clients.size,0);
});

test('stdio parent exit cleans descendants before releasing process ownership', async t => {
  const {createStdioTransport} = await import('../src/main/os/posix/transport.js');
  const stdio = await load('@modelcontextprotocol/sdk/shared/stdio.js');
  let descendant;
  const owned = new Set();
  let closed;
  const done = new Promise(resolve => { closed = resolve; });
  const script = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.error(c.pid);c.unref();setTimeout(()=>process.exit(0),50)";
  const transport = createStdioTransport({command:process.execPath,args:['-e',script]},stdio,
    (pid,active)=>active ? owned.add(pid) : owned.delete(pid),
    (level,text)=>{ if (/^\d+\s*$/.test(text)) { descendant=Number(text.trim()); } });
  t.after(()=>transport.close());
  transport.onclose = closed;
  await transport.start();
  await done;
  assert.ok(descendant);
  assert.equal(owned.size,0);
  assert.throws(()=>process.kill(descendant,0));
});

test('remote key conversion rejects malformed headers and stores only the compatible header representation', async t => {
  const storage = await temporaryStore(t);
  const services = new McpServices({storage,pluginId:'mcp-services',ownProcesses:()=>{}});
  await assert.rejects(services.save({id:'invalid',name:'Invalid',transport:'http',url:'https://example.test/mcp',apiKey:'test',headers:[]}));
  await services.save({id:'remote',name:'Remote',transport:'http',url:'https://example.test/mcp',apiKey:'Bearer new-key',
    headers:{authorization:'Bearer old-key','X-Tenant':'test'}});
  const [config] = await services.definitions();
  assert.deepEqual(config.headers,{Authorization:'Bearer new-key','X-Tenant':'test'});
  assert.equal(Object.hasOwn(config,'apiKey'),false);
  await services.close();
});
