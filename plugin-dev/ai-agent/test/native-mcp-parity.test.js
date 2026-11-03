import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, ListRootsRequestSchema, CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpServices } from '../../mcp/src/main/common/services.js';
import { McpRelay } from '../src/main/common/mcp-relay.js';

async function connect(t, relayed, decision = 'accept') {
  const storage = await temporaryStore(t);
  const services = new McpServices({ storage, pluginId: 'mcp-services', importModule: name => import(name), ownProcesses: () => {} });
  t.after(() => services.close());
  await services.save({ id: 'parity', name: 'Parity', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/native-mcp.mjs', import.meta.url))] });
  await services.start('parity');
  const service = (await services.connections()).services[0];
  let url = service.url;
  let headers = service.headers;
  if (relayed) {
    const config = { mcpServers: { desk_parity: { type: 'http', url, headers } } };
    const relay = new McpRelay({ pluginId: 'ai-agent-sessions', sessionId: 'parity', importModule: name => import(name), resolve: async () => config });
    await relay.start('claude', config);
    t.after(() => relay.close());
    url = `${relay.url}/desk_parity`;
    headers = { Authorization: `Bearer ${relay.token}` };
  }
  const client = new Client({ name: 'native-parity', version: '1' }, { capabilities: { elicitation: { form: {} }, roots: { listChanged: true }, sampling: {} } });
  const prompts = [];
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    prompts.push(request.params.message);
    if (typeof decision === 'function') { return decision(request, extra); }
    return decision === 'accept' ? { action: decision, content: { value: 'USER_ANSWER' } } : { action: decision };
  });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: 'file:///native-fixture', name: 'fixture' }] }));
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({ role: 'assistant', model: 'fixture', content: { type: 'text', text: 'SAMPLED' } }));
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return { client, prompts };
}

for (const relayed of [false, true]) {
  test(`native MCP ${relayed ? 'AI relay' : 'service gateway'} forwards user input back to the tool`, async t => {
    const { client, prompts } = await connect(t, relayed);
    const result = await client.callTool({ name: 'interact', arguments: { action: 'prompt' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'accept', content: { value: 'USER_ANSWER' } });
    assert.deepEqual(prompts, ['Choose the local test value']);
  });
}

test('native MCP tool survives the old 18 second limits through both gateways', { timeout: 30000 }, async t => {
  const { client } = await connect(t, true);
  const result = await client.callTool({ name: 'interact', arguments: { action: 'slow' } }, undefined, { timeout: 25000 });
  assert.equal(result.content[0].text, 'SLOW_NATIVE_TOOL_OK');
});

for (const decision of ['decline', 'cancel']) {
  test(`native MCP forwards ${decision} without accepting or retrying`, async t => {
    const { client, prompts } = await connect(t, true, decision);
    const result = await client.callTool({ name: 'interact', arguments: { action: 'prompt' } });
    assert.deepEqual(JSON.parse(result.content[0].text), { action: decision });
    assert.equal(prompts.length, 1);
  });
}

for (const action of ['roots', 'sampling']) {
  test(`native MCP preserves negotiated ${action} callbacks`, async t => {
    const { client } = await connect(t, true);
    const result = await client.callTool({ name: 'interact', arguments: { action } });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, action === 'roots' ? /file:\/\/\/native-fixture/ : /SAMPLED/);
  });
}

test('native MCP cancellation leaves the route usable for subsequent calls', async t => {
  const { client } = await connect(t, true);
  const controller = new AbortController();
  const pending = client.callTool({ name: 'interact', arguments: { action: 'wait' } }, undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(Error('fixture cancellation')), 300);
  await assert.rejects(pending, /fixture cancellation/);
  const result = await client.callTool({ name: 'interact', arguments: { action: 'roots' } });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /native-fixture/);
});

test('cancelling a tool also dismisses its native user input request', { timeout: 5000 }, async t => {
  let offered;
  const waiting = new Promise(resolve => { offered = resolve; });
  let dismissed;
  const cancelled = new Promise(resolve => { dismissed = resolve; });
  const { client } = await connect(t, true, (request, extra) => new Promise(resolve => {
    extra.signal.addEventListener('abort', () => { dismissed(); resolve({ action: 'cancel' }); }, { once: true });
    offered();
  }));
  const controller = new AbortController();
  const pending = client.callTool({ name: 'interact', arguments: { action: 'prompt' } }, undefined, { signal: controller.signal });
  await waiting;
  controller.abort(Error('cancel user input'));
  await assert.rejects(pending, /cancel user input/);
  await cancelled;
});

test('native root changes reach the same upstream session', async t => {
  const { client } = await connect(t, true);
  await client.sendRootsListChanged();
  const result = await client.callTool({ name: 'interact', arguments: { action: 'rootChanges' } });
  assert.equal(result.content[0].text, '1');
});
