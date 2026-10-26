// Uses an isolated synthetic account and a local upstream; never reads real credentials or calls a paid model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaptureManager } from '../src/main/common/capture/manager.js';
import { WebSocketServer } from 'ws';

const binary = process.argv[2];
assert.ok(binary, 'Pass the managed Codex executable path');
const root = await mkdtemp(join(tmpdir(), 'codex-capture-native-'));
const received = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) { chunks.push(chunk); }
  received.push({ path: req.url, bytes: Buffer.concat(chunks).length });
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Local capture probe complete', type: 'invalid_request_error' } }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const wss = new WebSocketServer({ server: upstream });
wss.on('connection', socket => socket.on('message', data => {
  received.push({ path: '/v1/responses', bytes: data.length });
  const item = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'CAPTURE_LOCAL_OK', annotations: [] }] };
  socket.send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }));
  socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_probe', object: 'response', status: 'completed',
    created_at: Math.floor(Date.now() / 1000), output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
}));
const record = { id: randomUUID(), windowId: randomUUID(), engineId: 'codex', state: 'idle' };
const manager = new CaptureManager({ root: join(root, 'logs'), conversations: { read: () => record, engines: new Map() } });
let proxy;
try {
  const home = join(root, 'home');
  const codexHome = join(root, 'codex');
  await mkdir(home);
  await mkdir(codexHome);
  const mode = process.argv[3] || 'api';
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const jwt = `${encode({ alg: 'RS256' })}.${encode({ sub: 'capture-synthetic', exp: 4102444800,
    'https://api.openai.com/auth': { chatgpt_account_id: 'capture-synthetic-account', chatgpt_plan_type: 'plus' } })}.synthetic`;
  const auth = mode === 'chatgpt' ? { auth_mode: 'chatgpt', last_refresh: new Date().toISOString(),
    tokens: { id_token: jwt, access_token: jwt, refresh_token: 'capture-synthetic-refresh', account_id: 'capture-synthetic-account' } }
    : { OPENAI_API_KEY: 'capture-synthetic-key' };
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  const launch = { args: [], env: { CODEX_HOME: codexHome } };
  const original = await manager.target(record, launch);
  assert.equal(original.upstream, mode === 'api' ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api/codex');
  manager.destination = async () => ({ upstream: `http://127.0.0.1:${upstream.address().port}/v1` });
  await manager.handle({ action: 'configure', instanceId: manager.instanceId, windowId: record.windowId, conversationId: record.id, ownerId: randomUUID(), enabled: true });
  const { args } = await manager.prepare(record, launch);
  proxy = manager.relays.get(record.id);
  const child = spawn(binary, [...args, '-c', 'model="gpt-5.4"',
    'exec', '--skip-git-repo-check', '--sandbox', 'read-only', 'Reply CAPTURE_SYNTHETIC_ONLY'], {
    cwd: home, env: { HOME: home, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  await proxy.log.flush();
  assert.ok(received.some(req => req.path.startsWith('/v1/responses') && req.bytes > 0), `Native route did not arrive: ${output.slice(-2500)}`);
  const logs = (await Promise.all((await readdir(proxy.log.root)).map(file => readFile(join(proxy.log.root, file), 'utf8')))).join('');
  assert.ok(!logs.includes('capture-synthetic-key'));
  assert.ok(!logs.includes(jwt));
  assert.ok(logs.includes('CAPTURE_SYNTHETIC_ONLY'));
  assert.equal(code, 0, `Native probe did not complete cleanly: ${output.slice(-2000)}`);
  console.log(JSON.stringify({ result: 'PASS', authMode: mode, upstream: 'local mock only', requests: received, nativeExit: code, authRedacted: true }));
} finally {
  await manager.close();
  wss.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await rm(root, { recursive: true });
}
