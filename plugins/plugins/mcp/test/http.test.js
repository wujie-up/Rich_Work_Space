import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as types from '@modelcontextprotocol/sdk/types.js';
import { temporaryStore } from '../../../../desk/test/helpers.js';
import { McpServices } from '../src/main/common/services.js';
const require=createRequire(import.meta.url);

test('remote HTTP authentication, two independent downstreams, resources and prompts',async t=>{
  const transports=new Map();
  const http=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer upstream-secret'){res.writeHead(403).end();return;}
    const existing=transports.get(req.headers['mcp-session-id']);
    if(existing){await existing.handleRequest(req,res);return;}
    let counter=0;
    const server=new Server({name:'http-fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}});
    server.setRequestHandler(types.ListToolsRequestSchema,async()=>({tools:[{name:'increment',inputSchema:{type:'object'}}]}));
    server.setRequestHandler(types.CallToolRequestSchema,async()=>({content:[{type:'text',text:String(++counter)}]}));
    server.setRequestHandler(types.ListResourcesRequestSchema,async()=>({resources:[{uri:'test://value',name:'Value'}]}));
    server.setRequestHandler(types.ReadResourceRequestSchema,async()=>({contents:[{uri:'test://value',text:'resource-value'}]}));
    server.setRequestHandler(types.ListResourceTemplatesRequestSchema,async()=>({resourceTemplates:[]}));
    server.setRequestHandler(types.ListPromptsRequestSchema,async()=>({prompts:[{name:'greet'}]}));
    server.setRequestHandler(types.GetPromptRequestSchema,async()=>({messages:[{role:'user',content:{type:'text',text:'hello'}}]}));
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,onsessioninitialized:id=>transports.set(id,transport)});
    await server.connect(transport);
    await transport.handleRequest(req,res);
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const transport of transports.values()){await transport.close();} http.closeAllConnections();await new Promise(resolve=>http.close(resolve));});
  const storage=await temporaryStore(t);
  const services=new McpServices({storage,pluginId:'mcp-services',importModule:name=>import(pathToFileURL(require.resolve(name)).href),ownProcesses:()=>{}});
  t.after(()=>services.close());
  const url=`http://127.0.0.1:${http.address().port}/mcp`;
  await services.save({id:'bad-auth',name:'Bad',transport:'http',url,headers:{Authorization:'Bearer wrong'}});
  await assert.rejects(services.start('bad-auth'),{code:'MCP_START_FAILED'});
  await services.save({id:'remote',name:'Remote',transport:'http',url,apiKey:'upstream-secret'});
  assert.equal((await services.list()).find(value=>value.id==='remote').headers.Authorization,'Bearer upstream-secret');
  services.log((await services.list()).find(value=>value.id==='remote'),'error','echoed upstream-secret');
  assert.ok(!(await services.logs('remote')).includes('upstream-secret'));
  await services.start('remote');
  const connection=(await services.connections()).services.find(value=>value.id==='remote');
  assert.ok(!JSON.stringify(connection).includes('upstream-secret'));
  const clients=await Promise.all([1,2].map(async()=>{
    const client=new Client({name:'independent-test',version:'1'});
    const transport=new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:connection.headers}});
    await client.connect(transport);
    return {client,transport};
  }));
  for(const {client} of clients){assert.equal((await client.callTool({name:'increment',arguments:{}})).content[0].text,'1');}
  assert.equal((await clients[1].client.readResource({uri:'test://value'})).contents[0].text,'resource-value');
  assert.equal((await clients[1].client.getPrompt({name:'greet'})).messages[0].content.text,'hello');
  await clients[0].transport.terminateSession();await clients[0].client.close();
  assert.equal((await clients[1].client.callTool({name:'increment',arguments:{}})).content[0].text,'2');
  await services.stop('remote');
  await assert.rejects(clients[1].client.listTools());
  await clients[1].client.close();
  assert.ok(!(await services.logs('bad-auth')).includes('Bearer wrong'));
  await services.close();
  const reloaded=new McpServices({storage,pluginId:'mcp-services',ownProcesses:()=>{}});
  assert.equal((await reloaded.list()).length,2);
  assert.ok((await reloaded.logs('remote')).includes('服务已停止'));
});

test('complete HTTP handshake times out without stopping a healthy service', {timeout:25000}, async t => {
  let terminated = 0;
  const http = createServer(async (req,res) => {
    if (req.method === 'DELETE') { terminated++; res.writeHead(200).end(); return; }
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    const message = JSON.parse(Buffer.concat(chunks));
    if (message.method === 'initialize') {
      res.writeHead(200, {'Content-Type':'application/json','mcp-session-id':'hanging'});
      res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-11-25',
        capabilities:{tools:{}},serverInfo:{name:'hang',version:'1'}}}));
    }
    // Intentionally leave notifications/initialized pending.
  });
  await new Promise(resolve => http.listen(0,'127.0.0.1',resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const storage = await temporaryStore(t);
  const services = new McpServices({storage, pluginId:'mcp-services', importModule:name=>import(pathToFileURL(require.resolve(name)).href),
    ownProcesses:()=>{}});
  t.after(() => services.close());
  await services.save({id:'healthy',name:'Healthy',transport:'stdio',command:process.execPath,
    args:[fileURLToPath(new URL('./fixture.mjs',import.meta.url))]});
  await services.start('healthy');
  await services.save({id:'hang',name:'Hang',transport:'http',url:`http://127.0.0.1:${http.address().port}/mcp`});
  const started = Date.now();
  await assert.rejects(services.start('hang'), {code:'MCP_START_FAILED'});
  assert.ok(Date.now()-started < 20000);
  assert.equal(terminated,1);
  assert.equal((await services.call('healthy','echo',{text:'still alive'})).content[0].text,'still alive');
  await services.close();
});

test('stop cancels a downstream still connecting and releases its reserved slot', async t => {
  const storage = await temporaryStore(t);
  const pids = new Set();
  const services = new McpServices({storage,pluginId:'mcp-services',importModule:name=>import(pathToFileURL(require.resolve(name)).href),
    ownProcesses:values=>{pids.clear(); values.forEach(pid=>pids.add(pid));}});
  t.after(()=>services.close());
  await services.save({id:'race',name:'Race',transport:'stdio',command:process.execPath,args:[fileURLToPath(new URL('./fixture.mjs',import.meta.url))]});
  await services.start('race');
  const connection=(await services.connections()).services[0];
  const runtime=services.running.get('race');
  const request=fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'race',version:'1'}}})}).catch(()=>null);
  while (!runtime.sessions.size) { await new Promise(resolve=>setTimeout(resolve,1)); }
  await services.stop('race');
  await request;
  assert.equal(runtime.sessions.size,0);
  assert.equal(pids.size,0);
  await services.close();
});


test('remote notification stream survives the ordinary request deadline', {timeout:25000}, async t => {
  let upstream;
  const transports = new Set();
  const http = createServer(async (request, response) => {
    const existing = [...transports].find(value => value.sessionId === request.headers['mcp-session-id']);
    if (existing) {
      await existing.handleRequest(request, response);
      return;
    }
    upstream = new Server({name:'notifications',version:'1'}, {capabilities:{tools:{listChanged:true}}});
    upstream.setRequestHandler(types.ListToolsRequestSchema, async () => ({tools:[]}));
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID});
    transports.add(transport);
    await upstream.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise(resolve => http.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    for (const transport of transports) { await transport.close(); }
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });
  const storage = await temporaryStore(t);
  const services = new McpServices({storage, pluginId:'mcp-services',
    importModule:name=>import(pathToFileURL(require.resolve(name)).href), ownProcesses:()=>{}});
  t.after(()=>services.close());
  const client = await services.connect({id:'stream',transport:'http',url:`http://127.0.0.1:${http.address().port}/mcp`});
  t.after(()=>client.close());
  let notifications = 0;
  client.setNotificationHandler(types.ToolListChangedNotificationSchema, () => { notifications++; });
  await new Promise(resolve=>setTimeout(resolve,100));
  await upstream.sendToolListChanged();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(notifications,1);
  await new Promise(resolve=>setTimeout(resolve,19000));
  await upstream.sendToolListChanged();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(notifications,2);
});
