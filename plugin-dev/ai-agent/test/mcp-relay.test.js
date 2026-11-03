import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpRelay } from '../src/main/common/mcp-relay.js';

async function upstream(t, token, value, capabilities = { tools: {} }) {
  const calls = [];
  const watchers = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && capabilities.tools?.listChanged) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      watchers.add(response);
      response.once('close', () => watchers.delete(response));
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let body = '';
    for await (const chunk of request) { body += chunk; }
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    calls.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities, serverInfo: { name: 'fixture', version: '1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'query', inputSchema: { type: 'object' }, description: value }] };
    } else if (message.method === 'resources/list') { result = { resources: [{ uri: 'fixture://read', name: 'read' }] };
    } else if (message.method === 'resources/templates/list') { result = { resourceTemplates: [] };
    } else if (message.method === 'resources/read') { result = { contents: [{ uri: 'fixture://read', text: value }] };
    } else if (message.method === 'prompts/list') { result = { prompts: [{ name: 'explain' }] };
    } else if (message.method === 'prompts/get') { result = { messages: [{ role: 'user', content: { type: 'text', text: value } }] };
    } else { result = { content: [{ type: 'text', text: value }] }; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: `Bearer ${token}` }, calls, server, watchers };
}
const config = service => ({ mcpServers: service ? { desk_db: { type: 'http', ...service } } : {} });
const options = { pluginId: 'ai-agent-sessions', sessionId: 'test', importModule: name => import(name) };
async function request(relay, method = 'tools/call', headers = {}) {
  const response = await fetch(`${relay.url}/desk_db`, { method: 'POST', headers: {
    Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json', ...headers
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name: 'query', arguments: {} } : {} }) });
  return response;
}

test('same native route uses endpoints and credentials refreshed before the next turn', async t => {
  const first = await upstream(t, 'first-secret', 'first');
  const next = await upstream(t, 'next-secret', 'next');
  let current = config(first);
  const relay = new McpRelay({ ...options, resolve: async () => current });
  await relay.start('claude', current);
  t.after(() => relay.close());
  const stable = relay.url;
  assert.equal((await (await request(relay)).json()).result.content[0].text, 'first');
  assert.equal((await (await request(relay)).json()).result.content[0].text, 'first');
  assert.equal(first.calls.filter(m => m === 'initialize').length, 1, 'keep OAuth/stateful upstream session alive');
  current = config(next);
  await relay.refresh();
  assert.equal((await (await request(relay)).json()).result.content[0].text, 'next');
  assert.equal(relay.url, stable);
  assert.equal(first.calls.filter(m => m === 'tools/call').length, 2);
  assert.equal(next.calls.filter(m => m === 'tools/call').length, 1);
  const listed = await (await request(relay, 'tools/list')).json();
  assert.equal(listed.result.tools[0].name, 'query');
  assert.equal(listed.result.tools[0].description, 'next');
  current = config(null);
  await relay.refresh();
  assert.match((await (await request(relay)).json()).error.message, /未启用|不可用/);
});

test('relay rejects wrong auth and browser origins, never retries a failed tool, and closes its own listener', async t => {
  const service = await upstream(t, 'secret', 'result');
  const relay = new McpRelay({ ...options, resolve: async () => config(service) });
  await relay.start('claude', config(service));
  t.after(() => relay.close());
  assert.equal((await request(relay, 'tools/list', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(relay, 'tools/list', { Origin: 'https://example.test' })).status, 405);
  assert.equal(service.calls.length, 0);
  // Simulate a connection disappearing after receiving a write: no retry is safe.
  service.server.removeAllListeners('request');
  let attempts = 0;
  service.server.on('request', async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) { body += chunk; }
    const message = JSON.parse(body);
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
    } else if (message.id === undefined) { res.writeHead(202).end(); }
    else { attempts++; req.socket.destroy(); }
  });
  assert.ok((await (await request(relay)).json()).error);
  assert.equal(attempts, 1);
  const url = relay.url;
  await relay.close();
  await assert.rejects(fetch(url));
});

test('endpoint changes drain in-flight requests and leave other service routes usable', async t => {
  const old = await upstream(t, 'old', 'old-result');
  const replacement = await upstream(t, 'new', 'new-result');
  const other = await upstream(t, 'peer', 'peer-result');
  const initial = { mcpServers: { ...config(old).mcpServers, desk_peer: { type: 'http', ...other } } };
  let current = initial;
  let arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const original = old.server.listeners('request')[0];
  old.server.removeAllListeners('request');
  old.server.on('request', async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) { body += chunk; }
    const message = JSON.parse(body);
    if (message.method !== 'tools/call') {
      // Let the fixture consume the already buffered request body.
      req[Symbol.asyncIterator] = async function* () { yield Buffer.from(body); };
      return original(req, res);
    }
    arrived();
    await hold;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { content: [{ type: 'text', text: 'old-result' }] } }));
  });
  const relay = new McpRelay({ ...options, resolve: async () => current });
  await relay.start('claude', initial);
  t.after(() => relay.close());
  const running = request(relay);
  await waiting;
  current = { mcpServers: { ...config(replacement).mcpServers, desk_peer: { type: 'http', ...other } } };
  await relay.refresh();
  assert.equal((await (await request(relay)).json()).result.content[0].text, 'new-result');
  release();
  assert.equal((await (await running).json()).result.content[0].text, 'old-result');
  const peer = await fetch(`${relay.url}/desk_peer`, { method: 'POST', headers: {
    Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await peer.json()).result.tools[0].description, 'peer-result');
});

test('real native MCP discovery retains original tool names and the same client survives provider rotation', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const first = await upstream(t, 'first', 'first');
  const second = await upstream(t, 'second', 'second');
  let target = first;
  const overrides = service => [`mcp_servers.desk_db.url=${JSON.stringify(service.url)}`,
    `mcp_servers.desk_db.http_headers={ Authorization = ${JSON.stringify(service.headers.Authorization)} }`];
  const relay = new McpRelay({ ...options, resolve: async () => overrides(target) });
  const rewritten = await relay.start('codex', overrides(first));
  t.after(() => relay.close());
  assert.ok(rewritten[0].includes(`${relay.url}/desk_db`));
  assert.ok(!rewritten.join('').includes('Bearer first'));
  const client = new Client({ name: 'native-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${relay.url}/desk_db`), {
    requestInit: { headers: { Authorization: `Bearer ${relay.token}` } }
  }));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools[0].name, 'query');
  assert.equal((await client.callTool({ name: 'query', arguments: {} })).content[0].text, 'first');
  target = second;
  await relay.refresh();
  assert.equal((await client.callTool({ name: 'query', arguments: {} })).content[0].text, 'second');
});

test('relay preserves resource and prompt capabilities alongside native tools', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const service = await upstream(t, 'secret', 'contents', { tools: {}, resources: {}, prompts: {} });
  const relay = new McpRelay({ ...options, resolve: async name => {
    assert.equal(name, 'desk_db');
    return config(service);
  } });
  await relay.start('claude', config(service));
  t.after(() => relay.close());
  const client = new Client({ name: 'native-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${relay.url}/desk_db`), {
    requestInit: { headers: { Authorization: `Bearer ${relay.token}` } }
  }));
  t.after(() => client.close());
  assert.ok(client.getServerCapabilities().resources);
  assert.ok(client.getServerCapabilities().prompts);
  assert.equal((await client.listResources()).resources[0].uri, 'fixture://read');
  assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
  assert.equal((await client.readResource({ uri: 'fixture://read' })).contents[0].text, 'contents');
  assert.equal((await client.listPrompts()).prompts[0].name, 'explain');
  assert.equal((await client.getPrompt({ name: 'explain' })).messages[0].content.text, 'contents');
});

test('upstream tool list changes reach the native client over the relay SSE stream', { timeout: 5000 }, async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const service = await upstream(t, 'secret', 'result', { tools: { listChanged: true } });
  const relay = new McpRelay({ ...options, resolve: async () => config(service) });
  await relay.start('claude', config(service));
  t.after(() => relay.close());
  const client = new Client({ name: 'native-fixture', version: '1' });
  let notified;
  const notification = new Promise(resolve => { notified = resolve; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => notified());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${relay.url}/desk_db`), {
    requestInit: { headers: { Authorization: `Bearer ${relay.token}` } }
  }));
  t.after(() => client.close());
  for (let attempt = 0; attempt < 100 && (!service.watchers.size || !relay.watchers.get('desk_db')?.size); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(service.watchers.size && relay.watchers.get('desk_db')?.size);
  for (const response of service.watchers) {
    response.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  }
  await notification;
});

test('native Codex and Claude discover authenticated built-ins without detached service resolution', async t => {
  for (const engineId of ['codex', 'claude']) {
    const calls = [];
    const relay = new McpRelay({ ...options, builtin: { tools: [{ name: 'agent_sessions_list', inputSchema: { type: 'object' } }],
      call: (name, args) => { calls.push({ name, args }); return { self: options.sessionId, sessions: [] }; } },
      resolve: () => { throw Error('must not resolve a detached provider'); } });
    t.after(() => relay.close());
    const launch = await relay.start(engineId, engineId === 'claude' ? config() : []);
    assert.match(JSON.stringify(launch), /desk_agent_sessions/);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: `fixture-${engineId}`, version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`${relay.url}/desk_agent_sessions`),
      { requestInit: { headers: { Authorization: `Bearer ${relay.token}` } } }));
    assert.equal((await client.listTools()).tools[0].name, 'agent_sessions_list');
    assert.equal(JSON.parse((await client.callTool({ name: 'agent_sessions_list', arguments: {} })).content[0].text).self, 'test');
    assert.deepEqual(calls, [{ name: 'agent_sessions_list', args: {} }]);
    await relay.refresh();
    assert.equal(relay.automaticInputReason, null);
    const rejected = await fetch(`${relay.url}/desk_agent_sessions`, { method: 'POST' });
    assert.equal(rejected.status, 401);
    const origin = await fetch(`${relay.url}/desk_agent_sessions`, { method: 'POST',
      headers: { Authorization: `Bearer ${relay.token}`, Origin: 'https://example.test' } });
    assert.equal(origin.status, 405);
  }
});

test('valid cached external endpoints allow peer turns; missing refresh targets hold them', async t => {
  let current = config({ url: 'http://127.0.0.1:9/mcp', headers: {} });
  const relay = new McpRelay({ ...options, resolve: async () => current,
    builtin: { tools: [], call: () => ({}) } });
  t.after(() => relay.close());
  await relay.start('claude', current);
  assert.equal(relay.automaticInputReason, null);
  current = config();
  await relay.refresh();
  assert.equal(relay.automaticInputReason, 'connection_refresh_required');
  current = config({ url: 'http://127.0.0.1:9/new', headers: {} });
  await relay.refresh();
  assert.equal(relay.automaticInputReason, null);
});
