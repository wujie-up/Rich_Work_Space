import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Capabilities } from '../../../desk/src/main/common/capabilities.js';
import { CapabilityGateway } from '../../ai-agent/src/main/common/capability-gateway.js';
import { BuiltinTools } from '../src/main/common/builtin-tools.js';

test('native MCP client discovers and calls built-ins through the real host authorization boundary', async t => {
  const storage = await temporaryStore(t);
  const handlers = new Map();
  const provider = { id: 'mcp-services', instanceId: 'mcp-one', services: [],
    executeCapability: (input, context) => handlers.get(context.capabilityId)(input, context) };
  const agent = { id: 'ai-agent-sessions', instanceId: 'agent-one', services: [] };
  const host = new Capabilities({ storage, loaded: new Map([[provider.id, provider], [agent.id, agent]]), usable: () => true });
  await host.load();
  let documentReady = false;
  const image = { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] };
  const tools = new BuiltinTools({ storage, pluginId: provider.id, capabilities: {
    register: async (descriptor, handler) => { handlers.set(descriptor.id, handler); await host.register(provider, descriptor); },
    unregister: (id, version) => host.unregister(provider, id, version)
  }, host: { messages: {
    request: input => host.messages.request(provider, input),
    get: id => host.messages.get(provider, id), cancel: id => host.messages.cancel(provider, id)
  } } }, { computer: { supported: true, permissions: async () => ({ screen: true, accessibility: true }), execute: async input => {
    assert.equal(input.bundleId, 'com.google.Chrome');
    return image;
  } },
    documents: { read: async () => {
      if (!documentReady) { throw Object.assign(Error('请完成文档授权'), { code: 'FEISHU_AUTH_REQUIRED' }); }
      return { content: [{ type: 'text', text: '需求正文' }] };
    } } });
  await tools.load();
  t.after(async () => { await tools.close(); await host.flush(); });
  const authorization = await host.authorizations.request(agent, {
    scopeKey: 'workflow-test', providers: host.discover().providers.map(entry => entry.handle)
  });
  await host.messages.respond(host.messages.list()[0].id, { text: '允许并记住' });
  const gateway = await new CapabilityGateway({ task: { kind: 'plan', background: { authorizationId: authorization.id } },
    capabilities: { discover: () => host.discover(), invoke: (handle, input, options) => host.invoke(agent, handle, input, options),
      getInvocation: id => host.get(agent, id), cancel: id => host.cancel(agent, id) }, onInvocation: () => {} }).start();
  t.after(() => gateway.close());
  const client = new Client({ name: 'workflow-agent-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), {
    requestInit: { headers: { Authorization: `Bearer ${gateway.token}` } }
  }));
  const catalog = (await client.listTools()).tools;
  assert.equal(catalog.length, 2);
  const computer = catalog.find(entry => entry.title.includes('电脑'));
  assert.deepEqual(await client.callTool({ name: computer.name,
    arguments: { action: 'screenshot', bundleId: 'com.google.Chrome' } }), image);
  const document = catalog.find(entry => entry.title.includes('飞书'));
  const pending = client.callTool({ name: document.name, arguments: { url: 'https://team.feishu.cn/docx/document' } });
  for (let n = 0; !host.messages.list().length && n < 100; n++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const prompt = host.messages.list()[0];
  assert.equal(prompt.required, true);
  assert.equal(prompt.placement, 'center');
  assert.throws(() => host.messages.defer(prompt.id), { code: 'MESSAGE_REQUIRED' });
  documentReady = true;
  await host.messages.respond(prompt.id, { text: '已完成授权，重试' });
  assert.match((await pending).content[0].text, /需求正文/);
  assert.equal(host.messages.list().length, 0);
});
