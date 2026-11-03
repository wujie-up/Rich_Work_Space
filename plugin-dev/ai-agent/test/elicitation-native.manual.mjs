// Real managed app-server, production service/relay/conversation path, isolated storage and deterministic local model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpServices } from '../../mcp/src/main/common/services.js';
import { Conversations } from '../src/main/common/conversations.js';
import { AgentTasks } from '../src/main/common/tasks.js';
import { createConversationMcp } from '../src/main/common/launch-config.js';
import { prepareProfile, managedArgs } from '../src/main/common/managed-runtime.js';

const cleanup = [];
const storage = await temporaryStore({ after: fn => cleanup.push(fn) });
const services = new McpServices({ storage, pluginId: 'mcp-services', importModule: name => import(name), ownProcesses: () => {} });
const steps = ['form', 'url'].flatMap(mode => ['accept', 'decline', 'cancel'].map(decision => ({ mode, decision })));
const content = { name: 'NATIVE_FORM_OK', count: 0, enabled: false, tags: ['one', 'two'] };
const replies = [];
const outcomes = [];
let rounds = 0;
let record;
let conversations;
let tasks;
function events(input, send) {
  const text = JSON.stringify(input);
  if (rounds > 0) {
    const previous = steps[rounds - 1];
    assert.ok(text.includes(`\\"fixture\\":\\"${previous.mode}\\"`), `Native tool result missing: ${text.slice(-3000)}`);
    assert.ok(text.includes(`\\"action\\":\\"${previous.decision}\\"`), `Native decision must return to the model: ${JSON.stringify(input.input)}`);
    if (previous.mode === 'form' && previous.decision === 'accept') { assert.ok(text.includes('NATIVE_FORM_OK')); }
    outcomes.push(previous);
  }
  const step = steps[rounds++];
  const catalog = (input.tools || []).flatMap(tool => tool.tools ? tool.tools.map(entry => ({ ...entry, namespace: tool.name })) : [tool]);
  const target = catalog.find(tool => /elicitation parity/.test(tool.description));
  const item = step ? { id: `fc_${rounds}`, type: 'function_call', call_id: `call_${rounds}`, name: target?.name,
    namespace: target?.namespace, arguments: JSON.stringify({ action: step.mode }) }
    : { id: 'final', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'NATIVE_ELICITATION_OK', annotations: [] }] };
  if (step) { assert.ok(target, 'Production native MCP route must be discovered'); }
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response: { id: `resp_${rounds}`, object: 'response', status: 'completed',
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
try {
  await services.save({ id: 'native-form', name: 'Native form', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/native-mcp.mjs', import.meta.url))] });
  await services.start('native-form');
  const service = (await services.connections()).services[0];
  const context = { pluginId: 'ai-agent-sessions', importModule: name => import(name), services: {
    discover: async () => [{ id: 'fixture-launch' }], invoke: async () => ({ version: 1, overrides: [
      `mcp_servers.desk_fixture.url=${JSON.stringify(service.url)}`,
      `mcp_servers.desk_fixture.http_headers={ Authorization = ${JSON.stringify(service.headers.Authorization)} }`
    ] })
  } };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = await prepareProfile(`${storage.root}/profile`);
  conversations = new Conversations({ storage, pluginId: context.pluginId, ownProcesses: () => {}, emit: () => {},
    createNativeMcp: (record, launch) => createConversationMcp(context, record, launch),
    capabilities: { discover: async () => ({ providers: [], catalogRevision: 1 }) },
    runtime: { launch: async () => ({ command: process.argv[2], runtimeId: 'native-test', env: { ...env, WORK_DESK_PROVIDER_KEY: 'fixture-key' },
      args: [...managedArgs, '-c', 'model_provider="local"', '-c', 'model="gpt-5.4"',
        '-c', 'model_providers.local.name="Local"', '-c', `model_providers.local.base_url="http://127.0.0.1:${server.address().port}/v1"`,
        '-c', 'model_providers.local.env_key="WORK_DESK_PROVIDER_KEY"', '-c', 'model_providers.local.wire_api="responses"'] }) } });
  await conversations.load();
  const input = { taskKey: 'e'.repeat(64), prompt: 'Run the local MCP form and URL fixture steps.' };
  if (process.env.NATIVE_TASK === '1') {
    tasks = new AgentTasks({ storage, conversations, pluginId: context.pluginId });
    await tasks.load();
    await tasks.start('plan', input, { background: { authorizationId: 'isolated-fixture' } });
  } else {
    record = await conversations.create({ cwd: storage.root });
    await conversations.send(record.id, input.prompt);
  }
  const deadline = Date.now() + 45000;
  while (true) {
    if (tasks) {
      const task = await tasks.read(input);
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) {
        assert.equal(task.state, 'succeeded', task.error);
        assert.equal(task.output, 'NATIVE_ELICITATION_OK');
        break;
      }
      const conversationId = tasks.get(input.taskKey).conversationId;
      record = conversationId ? await conversations.read(conversationId) : undefined;
    } else { record = await conversations.read(record.id); }
    for (const request of record?.events || []) {
      if (request.id === undefined || replies.some(reply => reply.id === request.id)) { continue; }
      assert.equal(request.method, 'mcpServer/elicitation/request');
      assert.equal(request.params.mode, steps[replies.length].mode);
      const decision = steps[replies.length].decision;
      const answer = request.params.mode === 'form' ? content : undefined;
      if (tasks) { await tasks.respond({ taskKey: input.taskKey, requestId: request.id, decision, answers: answer }); }
      else { conversations.elicit(record.id, request.id, decision, answer); }
      replies.push({ id: request.id, mode: request.params.mode, decision });
    }
    if (!tasks && record?.state === 'idle') { break; }
    assert.ok(Date.now() < deadline, `Native elicitation timed out: ${JSON.stringify(record?.events.slice(-3))}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(replies.length, 6);
  assert.equal(outcomes.length, 6);
  console.log(JSON.stringify({ binary: process.argv[2], route: tasks ? 'structured task' : 'structured conversation', rounds, replies, outcomes,
    model: 'local deterministic Responses fixture; real managed Codex and production MCP transports' }, null, 2));
} finally {
  await tasks?.stop();
  await conversations?.stop();
  await services.close();
  sockets.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const fn of cleanup.reverse()) { await fn(); }
}
