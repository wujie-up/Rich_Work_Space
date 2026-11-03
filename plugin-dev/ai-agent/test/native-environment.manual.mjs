// Usage: node test/native-environment.manual.mjs <managed-codex-binary>
// A local model fixture exercises native shell tools without live credentials or desktop interaction.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { AppServer } from '../src/main/common/app-server.js';
import { managedArgs, prepareProfile } from '../src/main/common/managed-runtime.js';

assert.ok(process.argv[2], 'provide the managed Codex binary');
const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-native-environment-')));
const env = await prepareProfile(root);
await writeFile(join(root, 'browser-helper'), `#!/bin/sh
test "$HOME" = '${env.HOME}' || exit 11
test "$CODEX_HOME" = '${env.CODEX_HOME}' || exit 12
test "$HTTPS_PROXY" = 'http://127.0.0.1:9' || exit 13
test -z "$WORK_DESK_PROVIDER_KEY" || exit 14
test -z "$WORK_DESK_MCP_TOKEN" || exit 15
printf NATIVE_ENV_OK
`, { mode: 0o700 });
// Supply a known helper directory so this test independently catches Codex clearing the child environment.
env.PATH = `${root}:${env.PATH}`;
Object.assign(env, { WORK_DESK_PROVIDER_KEY: 'local-fixture', WORK_DESK_MCP_TOKEN: 'must-not-reach-shell',
  HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
const requests = [];
const notifications = [];
let completed;
function events(input, send) {
  requests.push(input);
  const tools = (input.tools || []).flatMap(tool => tool.tools ? tool.tools.map(entry => ({ ...entry, namespace: tool.name })) : [tool]);
  const command = tools.find(tool => tool.name === 'exec_command' || tool.name === 'shell_command');
  const item = requests.length === 1 && command
    ? { type: 'function_call', id: 'fc_environment', call_id: 'call_environment', name: command.name, namespace: command.namespace,
      arguments: JSON.stringify({ cmd: 'browser-helper', command: 'browser-helper', login: false, timeout_ms: 10000 }) }
    : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'fixture finished', annotations: [] }] };
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response: { id: `resp_${requests.length}`, object: 'response', status: 'completed',
    created_at: Math.floor(Date.now() / 1000), output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
}
const model = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) { body += chunk; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  events(JSON.parse(body), event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  response.end();
});
const sockets = new WebSocketServer({ server: model });
sockets.on('connection', socket => socket.on('message', data => events(JSON.parse(data), event => socket.send(JSON.stringify(event)))));
const engine = new AppServer({ onEvent: event => {
  notifications.push(event);
  if (event.method === 'turn/completed') { completed = event.params.turn; }
} });
try {
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  await engine.start({ command: process.argv[2], env, cwd: root, args: [...managedArgs,
    '-c', 'model_provider="local"', '-c', 'model="gpt-5.4"', '-c', 'model_providers.local.name="Local"',
    '-c', `model_providers.local.base_url="http://127.0.0.1:${model.address().port}/v1"`,
    '-c', 'model_providers.local.env_key="WORK_DESK_PROVIDER_KEY"', '-c', 'model_providers.local.wire_api="responses"'] });
  assert.equal((await engine.request('account/read', { refreshToken: false })).account, null);
  const { thread } = await engine.request('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  await engine.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run the local browser helper.' }] });
  const deadline = Date.now() + 20000;
  while (!completed && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(completed?.status, 'completed', JSON.stringify(completed));
  const calls = notifications.filter(event => event.method === 'item/completed' && event.params.item.type === 'commandExecution');
  assert.equal(calls.length, 1, 'native command tool must be available');
  assert.equal(calls[0].params.item.exitCode, 0, calls[0].params.item.aggregatedOutput);
  assert.match(calls[0].params.item.aggregatedOutput, /NATIVE_ENV_OK/);
  assert.ok(JSON.stringify(requests.slice(1)).includes('NATIVE_ENV_OK'), 'native model must receive the real helper output');
  console.log(JSON.stringify({ nativeShell: 'passed', localHelper: 'resolved', profile: 'isolated', proxy: 'preserved',
    providerAndMcpTokens: 'excluded', account: 'isolated-null', model: 'local fixture' }));
} finally {
  await engine.closeTask();
  for (const socket of sockets.clients) { socket.terminate(); }
  sockets.close();
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
