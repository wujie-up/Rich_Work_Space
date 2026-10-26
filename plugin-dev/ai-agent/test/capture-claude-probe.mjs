// Extracts the pinned offline engine to a temporary directory; no installation or real account is used.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm, chmod, readFile, readdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CaptureManager } from '../src/main/common/capture/manager.js';
import { CLAUDE_PIN } from '../src/main/common/engine-pin.js';

const root = await mkdtemp(join(tmpdir(), 'claude-capture-native-'));
const received = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) { chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  received.push({ path: req.url, bytes: body.length });
  if (req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":1}'); return; }
  const input = JSON.parse(body);
  const message = { id: 'msg_capture_probe', type: 'message', role: 'assistant', model: input.model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', { message });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'CLAUDE_CAPTURE_LOCAL_OK' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {});
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const record = { id: randomUUID(), windowId: randomUUID(), engineId: 'claude', state: 'idle' };
const manager = new CaptureManager({ root: join(root, 'logs'), conversations: { engines: new Map(), read: () => record },
  destination: async () => ({ upstream: `http://127.0.0.1:${server.address().port}`, paths: /^\/v1\/(messages(?:\/count_tokens)?|models)$/ }) });
try {
  const archive = resolve(process.argv[2] || 'plugin-dev/dist/claude-2.1.310-darwin-arm64.engine.tar.gz');
  await promisify(execFile)('/usr/bin/tar', ['-xzf', archive, '-C', root]);
  const binary = join(root, 'bin/claude');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(binary)) { hash.update(chunk); }
  assert.equal(hash.digest('hex'), CLAUDE_PIN.sha256);
  await chmod(binary, 0o700);
  const home = join(root, 'home');
  const config = join(root, 'config');
  await mkdir(home);
  await mkdir(config);
  await manager.handle({ action: 'configure', instanceId: manager.instanceId, windowId: record.windowId, conversationId: record.id,
    ownerId: randomUUID(), enabled: true });
  const launch = await manager.prepare(record, { args: [], env: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: '/usr/bin:/bin',
    ANTHROPIC_API_KEY: 'claude-capture-synthetic-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } });
  const child = spawn(binary, ['--print', '--max-turns', '1', '--setting-sources', 'user,project,local', 'Reply CLAUDE_CAPTURE_SYNTHETIC_ONLY'], {
    cwd: home, env: launch.env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  const relay = manager.relays.get(record.id);
  await relay.log.flush();
  assert.ok(received.some(request => request.path.startsWith('/v1/messages') && request.bytes > 0), output.slice(-2000));
  assert.equal(code, 0, output.slice(-2000));
  assert.ok(output.includes('CLAUDE_CAPTURE_LOCAL_OK'));
  const logs = (await Promise.all((await readdir(relay.log.root)).map(file => readFile(join(relay.log.root, file), 'utf8')))).join('');
  assert.ok(logs.includes('CLAUDE_CAPTURE_SYNTHETIC_ONLY'));
  assert.ok(!logs.includes('claude-capture-synthetic-key'));
  console.log(JSON.stringify({ result: 'PASS', engine: CLAUDE_PIN.version, upstream: 'local mock only', requests: received, nativeExit: code, authRedacted: true }));
} finally {
  await manager.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
