// Real managed Codex, isolated profile and local model fixture; never touches live sessions or the real desktop.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Capabilities } from '../../../desk/src/main/common/capabilities.js';
import { Conversations } from '../src/main/common/conversations.js';
import { AgentTasks } from '../src/main/common/tasks.js';
import { prepareProfile, managedArgs } from '../src/main/common/managed-runtime.js';
import { BuiltinTools } from '../../mcp/src/main/common/builtin-tools.js';

const cleanup = [];
const storage = await temporaryStore({ after: fn => cleanup.push(fn) });
const handlers = new Map();
const provider = { id: 'mcp-services', instanceId: 'mcp-test', services: [],
  executeCapability: (input, context) => handlers.get(context.capabilityId)(input, context) };
const agent = { id: 'ai-agent-sessions', instanceId: 'agent-test', services: [] };
const host = new Capabilities({ storage, loaded: new Map([[provider.id, provider], [agent.id, agent]]), usable: () => true });
const actions = [];
let documentReady = false;
const tools = new BuiltinTools({ storage, pluginId: provider.id, capabilities: {
  register: async (descriptor, handler) => { handlers.set(descriptor.id, handler); await host.register(provider, descriptor); },
  unregister: (id, version) => host.unregister(provider, id, version)
}, host: { messages: {
  request: input => host.messages.request(provider, input), get: id => host.messages.get(provider, id),
  cancel: id => host.messages.cancel(provider, id)
} } }, { computer: { supported: true, permissions: async () => ({ screen: true, accessibility: true }), execute: async input => {
  actions.push(input.action);
  return { content: [{ type: 'image', mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=' }] };
} }, documents: { read: async () => {
  if (!documentReady) { throw Object.assign(Error('local authorization fixture'), { code: 'FEISHU_AUTH_REQUIRED' }); }
  actions.push('document.read');
  return { content: [{ type: 'text', text: 'LOCAL_FEISHU_DOCUMENT_OK' }] };
} } });
let modelRequests = 0;
const discovered = new Set();
function output(input) {
  modelRequests++;
  const catalog = (input.tools || []).flatMap(tool => tool.tools ? tool.tools.map(entry => ({ ...entry, namespace: tool.name })) : [tool]);
  const names = catalog.map(tool => tool.name);
  catalog.filter(tool => tool.namespace === 'mcp__work_desk').forEach(tool => discovered.add(tool.name));
  const target = modelRequests === 1 ? catalog.find(tool => /飞书/.test(tool.description))
    : modelRequests <= 3 ? catalog.find(tool => /操作用户电脑/.test(tool.description)) : null;
  if (modelRequests <= 3) {
    assert.ok(target, `Native model catalog missing built-in: ${JSON.stringify(names)}`);
    return { id: `fc_${modelRequests}`, type: 'function_call', call_id: `call_${modelRequests}`, namespace: target.namespace, name: target.name,
      arguments: JSON.stringify(modelRequests === 1 ? { url: 'https://team.feishu.cn/docx/local' } : { action: 'screenshot' }) };
  }
  assert.ok(actions.includes('document.read') && actions.includes('screenshot'));
  return { id: 'msg_final', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '{"passed":true}', annotations: [] }] };
}
function events(input, send) {
  const item = output(input);
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response: { id: `resp_${modelRequests}`, object: 'response', status: 'completed',
    created_at: Math.floor(Date.now() / 1000), output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
}
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) { body += chunk; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  events(JSON.parse(body), event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  response.end();
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', socket => socket.on('message', data => events(JSON.parse(data), event => socket.send(JSON.stringify(event)))));
let conversations;
let tasks;
let confirmations = 0;
let nativeApprovals = 0;
try {
  await host.load();
  await tools.load();
  const authorization = await host.authorizations.request(agent, {
    scopeKey: 'native-smoke', providers: host.discover().providers.map(entry => entry.handle)
  });
  await host.messages.respond(host.messages.list()[0].id, { text: '允许并记住' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = await prepareProfile(`${storage.root}/profile`);
  conversations = new Conversations({ storage, pluginId: agent.id, ownProcesses: () => {}, emit: () => {},
    capabilities: { discover: () => host.discover(), invoke: (handle, input, options) => host.invoke(agent, handle, input, options),
      getInvocation: id => host.get(agent, id), cancel: id => host.cancel(agent, id) },
    runtime: { launch: async () => ({ command: process.argv[2], runtimeId: 'native-test', env: { ...env, WORK_DESK_PROVIDER_KEY: 'fixture-key' },
      args: [...managedArgs, '-c', 'model_provider="local"', '-c', 'model="gpt-5.4"',
        '-c', 'model_providers.local.name="Local"', '-c', `model_providers.local.base_url="http://127.0.0.1:${server.address().port}/v1"`,
        '-c', 'model_providers.local.env_key="WORK_DESK_PROVIDER_KEY"', '-c', 'model_providers.local.wire_api="responses"'] }) } });
  await conversations.load();
  tasks = new AgentTasks({ conversations, storage, pluginId: agent.id });
  await tasks.load();
  const input = { taskKey: 'a'.repeat(64), prompt: 'Read Feishu document, inspect screenshot, return JSON.' };
  await tasks.start('plan', input, { background: { authorizationId: authorization.id } });
  const deadline = Date.now() + 45000;
  let result;
  while (true) {
    const prompt = host.messages.list()[0];
    if (prompt) {
      assert.equal(prompt.required, true);
      assert.equal(prompt.placement, 'center');
      assert.throws(() => host.messages.defer(prompt.id), { code: 'MESSAGE_REQUIRED' });
      documentReady = true;
      confirmations++;
      await host.messages.respond(prompt.id, { text: '已完成授权，重试' });
    }
    result = await tasks.read(input);
    for (const request of result.requests || []) {
      assert.equal(request.method, 'mcpServer/elicitation/request');
      assert.equal(request.params._meta.codex_approval_kind, 'mcp_tool_call');
      await tasks.respond({ taskKey: input.taskKey, requestId: request.id, decision: 'accept' });
      nativeApprovals++;
    }
    if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(result.state)) { break; }
    assert.ok(Date.now() < deadline, 'Native smoke timed out');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(result.state, 'succeeded', result.error);
  assert.equal(result.output, '{"passed":true}');
  assert.equal(confirmations, 1);
  assert.equal(actions.filter(action => action === 'screenshot').length, 2);
  assert.equal(nativeApprovals, 0);
  console.log(JSON.stringify({ nativeModelToolCatalog: [...discovered], modelRequests, actions, confirmations, nativeApprovals,
    state: result.state, output: result.output, externalServices: 'local fixtures only' }, null, 2));
} finally {
  await tasks?.stop();
  for (const id of conversations?.engines.keys() || []) { await conversations.cancelTask(id); }
  await conversations?.stop();
  await tools.close();
  await host.flush();
  sockets.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const fn of cleanup.reverse()) { await fn(); }
}
