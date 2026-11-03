import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Capabilities } from '../../../desk/src/main/common/capabilities.js';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpRelay } from '../src/main/common/mcp-relay.js';

for (const [engineId, capabilityId, title] of [
  ['codex', 'mcp.computer.control', '电脑操作'], ['codex', 'mcp.browser.control', '浏览器操作'],
  ['claude', 'mcp.computer.control', '电脑操作'], ['claude', 'mcp.browser.control', '浏览器操作']
]) {
  test(`${engineId} native session discovers ${capabilityId} and preserves host authorization and images`, async t => {
    const storage = await temporaryStore(t);
    const image = { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] };
    let executions = 0;
    const provider = { id: 'mcp-services', instanceId: 'mcp-one', services: [], executeCapability: async () => { executions++; return image; } };
    const agent = { id: 'ai-agent-sessions', instanceId: 'agent-one', services: [] };
    let approval;
    const host = new Capabilities({ storage, loaded: new Map([[provider.id, provider], [agent.id, agent]]), usable: () => true,
      emit: (channel, value) => { if (channel === 'capabilities.approval') { approval = value; } } });
    await host.load();
    await host.register(provider, { id: capabilityId, version: 1, title, description: 'External UI control',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, effects: [capabilityId.slice(4)],
      confirmation: 'policy', execution: { timeoutMs: 10000, cancellable: true, retry: 'never' }, source: { builtin: true } });
    await host.register(provider, { id: 'external.query', version: 1, title: 'External MCP query', description: 'Already on its own MCP route',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, effects: ['network.read'],
      confirmation: 'policy', execution: { timeoutMs: 10000, cancellable: true, retry: 'never' }, source: { serviceId: 'external' } });
    const relay = new McpRelay({ pluginId: agent.id, sessionId: 'tester', capabilities: {
      discover: () => host.discover(), invoke: (handle, input) => host.invoke(agent, handle, input),
      getInvocation: id => host.get(agent, id), cancel: id => host.cancel(agent, id)
    }, resolve: async () => engineId === 'codex' ? [] : { mcpServers: {} } });
    t.after(async () => { await relay.close(); await host.flush(); });
    const launch = await relay.start(engineId, engineId === 'codex' ? [] : { mcpServers: {} });
    assert.ok(engineId === 'codex' ? launch.some(value => value.startsWith('mcp_servers.desk_capabilities.url='))
      : launch.mcpServers.desk_capabilities, 'native launch must include the desktop capability server');
    const url = engineId === 'codex'
      ? JSON.parse(launch.find(value => value.startsWith('mcp_servers.desk_capabilities.url=')).split('=').slice(1).join('='))
      : launch.mcpServers.desk_capabilities.url;
    const client = new Client({ name: 'native-browser-regression', version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${relay.token}` } }
    }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].title, title);
    assert.equal(relay.automaticInputReason, null, 'capability route must not block peer input as an unresolved MCP service');
    const pending = client.callTool({ name: tools[0].name, arguments: { action: 'screenshot' } });
    for (let n = 0; !approval && n < 100; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(approval, 'computer control must pass the host approval boundary');
    assert.equal(host.get(agent, approval.invocationId).approvalRequired, true);
    await host.approve(approval.invocationId, true);
    assert.deepEqual(await pending, image);
    approval = null;
    const cancelled = client.callTool({ name: tools[0].name, arguments: { action: 'screenshot' } });
    for (let n = 0; !approval && n < 100; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(approval);
    await host.approve(approval.invocationId, false);
    assert.equal((await cancelled).isError, true, 'declining approval must not run computer control');
    assert.equal(executions, 1);
    await host.unregister(provider, capabilityId, 1);
    await relay.refresh();
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal((await client.callTool({ name: tools[0].name, arguments: {} })).isError, true);
    await relay.close();
    await assert.rejects(fetch(url));
  });
}

test('native capability discovery failure does not block session tools and can recover', async t => {
  let available = false;
  const relay = new McpRelay({ pluginId: 'ai-agent-sessions', sessionId: 'recovering',
    builtin: { tools: [{ name: 'agent_messages_read', inputSchema: { type: 'object' } }] },
    capabilities: { discover: async () => {
      if (!available) { throw Error('provider unavailable'); }
      return { catalogRevision: 1, providers: [] };
    } } });
  t.after(() => relay.close());
  await relay.start('codex', []);
  assert.equal(relay.automaticInputReason, null);
  assert.deepEqual(relay.gateway.tools, []);
  const response = await fetch(`${relay.url}/desk_agent_sessions`, {
    method: 'POST', headers: { Authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal((await response.json()).result.tools[0].name, 'agent_messages_read');
  available = true;
  await relay.refresh();
  assert.equal(relay.gateway.catalogRevision, 1);
});

test('closing a native session cancels its capability calls while another relay stays available', async t => {
  const cancelled = [];
  const capabilities = {
    discover: async () => ({ providers: [{ state: 'ready', handle: { capabilityId: 'computer' }, descriptor: {
      id: 'computer', inputSchema: { type: 'object' }, effects: ['computer.control']
    } }] }),
    invoke: async () => ({ invocationId: 'pending' }),
    getInvocation: async () => ({ state: 'running' }),
    cancel: async id => cancelled.push(id)
  };
  const first = new McpRelay({ pluginId: 'ai-agent-sessions', sessionId: 'first', capabilities });
  const peer = new McpRelay({ pluginId: 'ai-agent-sessions', sessionId: 'peer', capabilities });
  t.after(async () => { await first.close(); await peer.close(); });
  await first.start('codex', []);
  await peer.start('claude', { mcpServers: {} });
  const pending = first.gateway.call({ name: first.gateway.tools[0].name, arguments: {} });
  for (let n = 0; !first.gateway.active.size && n < 100; n++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(first.gateway.active.size, 1);
  await first.close();
  assert.equal((await pending).isError, true);
  assert.deepEqual(cancelled, ['pending']);
  const response = await fetch(`${peer.url}/desk_capabilities`, {
    method: 'POST', headers: { Authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal((await response.json()).result.tools.length, 1);
});
