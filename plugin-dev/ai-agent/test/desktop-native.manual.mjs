// Usage: NATIVE_ROUTE=relay node test/desktop-native.manual.mjs <managed-codex-binary>
// Requires macOS screen/accessibility permission, Xcode command line tools and Chrome.
// Real managed Codex and real native tools; temporary test application/browser/profile, local model fixture only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Capabilities } from '../../../desk/src/main/common/capabilities.js';
import { AppServer } from '../src/main/common/app-server.js';
import { McpRelay } from '../src/main/common/mcp-relay.js';
import { Conversations } from '../src/main/common/conversations.js';
import { AgentTasks } from '../src/main/common/tasks.js';
import { prepareProfile, managedArgs } from '../src/main/common/managed-runtime.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BrowserTools } from '../../mcp/src/main/common/browser-tools.js';
import { BuiltinTools } from '../../mcp/src/main/common/builtin-tools.js';

const cleanup = [];
const storage = await temporaryStore({ after: fn => cleanup.push(fn) });
const handlers = new Map();
const provider = { id: 'mcp-services', instanceId: 'mcp-test', services: [],
  executeCapability: (input, context) => handlers.get(context.capabilityId)(input, context) };
const agent = { id: 'ai-agent-sessions', instanceId: 'agent-test', services: [] };
const host = new Capabilities({ storage, loaded: new Map([[provider.id, provider], [agent.id, agent]]), usable: () => true });
const actions = [];
const context = { storage, pluginId: provider.id, ownProcesses: () => {}, capabilities: {
  register: async (descriptor, handler) => {
    handlers.set(descriptor.id, async (input, invocation) => {
      actions.push(input.action);
      const result = await handler(input, invocation);
      if (descriptor.id === 'mcp.browser.control' && input.action === 'open') {
        tabId = JSON.parse(result.content[0].text).tabId;
      }
      if (input.action === 'click' && descriptor.id === 'mcp.browser.control') {
        assert.match(JSON.parse(result.content[0].text).snapshot, /status: BROWSER_NATIVE_OK/);
        browserVerified = true;
      }
      return result;
    });
    await host.register(provider, descriptor);
  },
  unregister: (id, version) => host.unregister(provider, id, version)
}, host: { messages: {
  request: input => host.messages.request(provider, input), get: id => host.messages.get(provider, id),
  cancel: id => host.messages.cancel(provider, id)
} } };
const tools = new BuiltinTools(context);
const browser = new BrowserTools(context);
let tabId;
let browserVerified = false;
let probeState;
let probeProcess;
const bundleId = `local.workdesk.parity.${randomUUID()}`;
const appRoot = `${storage.root}/NativeProbe.app/Contents`;
const statePath = `${storage.root}/probe.json`;
let modelRequests = 0;
const discovered = new Set();
let imageReturns = 0;
function countImages(value) {
  if (!value || typeof value !== 'object') { return 0; }
  return (value.type === 'input_image' ? 1 : 0) + Object.values(value).reduce((sum, child) => sum + countImages(child), 0);
}
function output(input) {
  modelRequests++;
  imageReturns = Math.max(imageReturns, countImages(input));
  const catalog = (input.tools || []).flatMap(tool => tool.tools ? tool.tools.map(entry => ({ ...entry, namespace: tool.name })) : [tool]);
  catalog.filter(tool => /^mcp__(work_desk|desk_capabilities)$/.test(tool.namespace)).forEach(tool => discovered.add(tool.name));
  const steps = [
    ['computer', { action: 'screenshot', bundleId }],
    ['computer', { action: 'click', bundleId, x: probeState.x, y: probeState.y }],
    ['computer', { action: 'type', bundleId, text: 'COMPUTER_NATIVE_OK' }],
    ['computer', { action: 'key', bundleId, key: 'ENTER' }],
    ['computer', { action: 'screenshot', bundleId }],
    ['browser', { action: 'open', url: `http://127.0.0.1:${server.address().port}/probe` }],
    ['browser', { action: 'fill', tabId, role: 'textbox', name: 'Probe', text: 'BROWSER_NATIVE_OK' }],
    ['browser', { action: 'click', tabId, role: 'button', name: 'Apply' }],
    ['browser', { action: 'screenshot', tabId }],
    ['browser', { action: 'close', tabId }]
  ];
  const step = steps[modelRequests - 1];
  if (step) {
    const target = catalog.find(tool => step[0] === 'computer' ? /操作用户电脑/.test(tool.description) : /操作插件独立的 Chrome/.test(tool.description));
    assert.ok(target, `Native model catalog missing ${step[0]}`);
    return { id: `fc_${modelRequests}`, type: 'function_call', call_id: `call_${modelRequests}`, namespace: target.namespace, name: target.name,
      arguments: JSON.stringify(step[1]) };
  }
  assert.ok(browserVerified);
  assert.ok(imageReturns >= 3, 'Native model must receive actual desktop and browser images');
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
  if (request.url === '/probe') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Isolated native SDK probe</title><label>Probe<input id="probe"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output>`);
    return;
  }
  if (request.method !== 'POST') { response.writeHead(404).end(); return; }
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
let relay;
let nativeEngine;
let completed;
try {
  await mkdir(`${appRoot}/MacOS`, { recursive: true });
  await writeFile(`${appRoot}/Info.plist`, `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('./fixtures/native-desktop.swift', import.meta.url)), '-o', `${appRoot}/MacOS/Probe`]);

  await host.load();
  await tools.load();
  await browser.load();
  probeProcess = spawn(`${appRoot}/MacOS/Probe`, [statePath], { stdio: 'ignore' });
  const probeDeadline = Date.now() + 10000;
  while (!probeState && Date.now() < probeDeadline) {
    try {
      probeState = JSON.parse(await readFile(statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') { throw error; }
      probeState = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(probeState, 'Disposable desktop app must be ready');
  const authorization = await host.authorizations.request(agent, {
    scopeKey: 'native-smoke', providers: host.discover().providers.map(entry => entry.handle)
  });
  await host.messages.respond(host.messages.list()[0].id, { text: '允许并记住' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = await prepareProfile(`${storage.root}/profile`);
  const input = { taskKey: 'a'.repeat(64), prompt: 'Operate the disposable native test app and isolated browser, inspect screenshots, return JSON.' };
  if (process.env.NATIVE_ROUTE === 'relay') {
    relay = new McpRelay({ pluginId: agent.id, sessionId: 'real-native-parity', importModule: name => import(name), resolve: async () => [],
      capabilities: { discover: () => host.discover(), invoke: (handle, value) => host.invoke(agent, handle, value, { authorizationId: authorization.id }),
        getInvocation: id => host.get(agent, id), cancel: id => host.cancel(agent, id) } });
    const overrides = await relay.start('codex', []);
    nativeEngine = new AppServer({ onEvent: event => {
      if (event.method === 'turn/completed') { completed = event.params.turn; }
    } });
    await nativeEngine.start({ command: process.argv[2], env: { ...env, WORK_DESK_PROVIDER_KEY: 'fixture-key' }, cwd: storage.root,
      args: [...managedArgs, ...overrides.flatMap(override => ['-c', override]),
        '-c', 'model_provider="local"', '-c', 'model="gpt-5.4"', '-c', 'model_providers.local.name="Local"',
        '-c', `model_providers.local.base_url="http://127.0.0.1:${server.address().port}/v1"`,
        '-c', 'model_providers.local.env_key="WORK_DESK_PROVIDER_KEY"', '-c', 'model_providers.local.wire_api="responses"'] });
    const { thread } = await nativeEngine.request('thread/start', { cwd: storage.root, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    await nativeEngine.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: input.prompt }] });
  } else {
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
    await tasks.start('plan', input, { background: { authorizationId: authorization.id } });
  }
  const deadline = Date.now() + 90000;
  let result;
  while (true) {
    result = tasks ? await tasks.read(input) : completed ? { state: completed.status === 'completed' ? 'succeeded' : 'failed', output: '{"passed":true}', error: completed.error } : { state: 'running' };
    for (const request of result.requests || []) {
      assert.equal(request.method, 'mcpServer/elicitation/request');
      assert.equal(request.params._meta.codex_approval_kind, 'mcp_tool_call');
      await tasks.respond({ taskKey: input.taskKey, requestId: request.id, decision: 'accept' });
    }
    if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(result.state)) { break; }
    assert.ok(Date.now() < deadline, 'Native smoke timed out');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(result.state, 'succeeded', result.error);
  assert.equal(result.output, '{"passed":true}');
  const finalState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(finalState.text, 'COMPUTER_NATIVE_OK');
  assert.equal(actions.filter(action => action === 'screenshot').length, 3);
  assert.ok(browserVerified);
  assert.ok(imageReturns >= 3);
  console.log(JSON.stringify({ nativeModelToolCatalog: [...discovered], modelRequests, actions,
    nativeComputerInput: finalState.text, browserVerified, imagesReturnedToModel: imageReturns,
    route: process.env.NATIVE_ROUTE || 'structured', state: result.state, model: 'local deterministic fixture', profile: 'isolated' }, null, 2));
} finally {
  await nativeEngine?.closeTask();
  await relay?.close();
  await tasks?.stop();
  for (const id of conversations?.engines.keys() || []) { await conversations.cancelTask(id); }
  await conversations?.stop();
  if (probeProcess && probeProcess.exitCode === null && !probeProcess.signalCode) {
    const stopped = once(probeProcess, 'exit');
    probeProcess.kill('SIGTERM');
    await stopped;
  }
  await browser.close();
  await tools.close();
  await host.flush();
  sockets.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const fn of cleanup.reverse()) { await fn(); }
}
