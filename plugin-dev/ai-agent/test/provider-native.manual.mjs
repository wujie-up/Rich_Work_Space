// Real native engines against a local protocol fixture; no real credentials or paid model requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { WebSocketServer } from 'ws';
import { EngineManager } from '../src/main/common/engines.js';

const root = await mkdtemp(join(tmpdir(), 'agent-provider-native-'));
const manager = new EngineManager({ root, tar });
const requests = [];
const item = { id: 'msg_local', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'LOCAL_PROVIDER_OK', annotations: [] }] };
const completed = { id: 'resp_local', object: 'response', status: 'completed', created_at: Math.floor(Date.now() / 1000),
  output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
const server = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) { text += chunk; }
  const input = text ? JSON.parse(text) : {};
  requests.push({ path: request.url, model: input.model, authenticated: Boolean(request.headers.authorization || request.headers['x-api-key']) });
  if (request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  if (request.url.includes('/messages')) {
    event('message_start', { message: { id: 'msg_local', type: 'message', role: 'assistant', model: input.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'LOCAL_PROVIDER_OK' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {});
  } else {
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: completed });
  }
  response.end();
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket, request) => socket.on('message', data => {
  const input = JSON.parse(data);
  requests.push({ path: request.url, model: input.model, authenticated: Boolean(request.headers.authorization) });
  socket.send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }));
  socket.send(JSON.stringify({ type: 'response.completed', response: completed }));
}));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const results = [];
  for (const [id, archive] of [['codex', process.argv[2]], ['claude', process.argv[3]]]) {
    await manager.runtime(id).install(archive);
    const profile = await manager.providers.save({ name: 'Local fixture', engineId: id,
      protocol: id === 'codex' ? 'responses' : 'anthropic', baseUrl: `http://127.0.0.1:${server.address().port}${id === 'codex' ? '/v1' : ''}`,
      model: id === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-5', apiKey: 'synthetic-provider-key' });
    await manager.configure({ engines: { [id]: { providerId: profile.id } } });
    const launch = await manager.launch(undefined, id);
    assert.equal(JSON.stringify(launch.launchSettings).includes('synthetic-provider-key'), false);
    const args = id === 'codex' ? [...launch.args, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', 'Reply OK']
      : [...launch.args, '--print', '--max-turns', '1', 'Reply OK'];
    const child = spawn(launch.command, args, { cwd: launch.env.HOME, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    const [code] = await once(child, 'close');
    clearTimeout(timer);
    assert.equal(code, 0, output.slice(-2000));
    assert.ok(output.includes('LOCAL_PROVIDER_OK'), output.slice(-2000));
    assert.ok(requests.some(request => request.model === profile.model && request.authenticated));
    results.push({ engine: id, version: launch.runtimeVersion, nativeProviderRequest: 'PASS', exit: code });
  }
  console.log(JSON.stringify({ upstream: 'local protocol fixture only', results, requests }, null, 2));
} finally {
  manager.stop();
  sockets.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
