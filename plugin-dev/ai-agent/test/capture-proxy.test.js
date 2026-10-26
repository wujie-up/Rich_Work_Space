import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CaptureProxy } from '../src/main/common/capture/proxy.js';

async function setup(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'codex-capture-test-'));
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const events = [];
  const proxy = new CaptureProxy({ root, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, onEvent: e => events.push(e) });
  await proxy.start();
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); await rm(root, { recursive: true }); });
  return { root, proxy, upstream, events };
}

test('forwards exact request and response, redacts credentials in disk logs', async t => {
  let received;
  const { proxy, root, events } = await setup(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    received = { body: Buffer.concat(chunks).toString(), path: req.url, auth: req.headers.authorization };
    res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'session=secret-cookie' });
    res.end('{"output":"你好"}');
  });
  const body = JSON.stringify({ input: [{ role: 'user', content: 'actual context' }] });
  const response = await fetch(`${proxy.url}/responses?stream=true`, { method: 'POST', headers: { authorization: 'Bearer secret-auth', cookie: 'secret-cookie' }, body });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), '{"output":"你好"}');
  assert.deepEqual(received, { body, path: '/v1/responses?stream=true', auth: 'Bearer secret-auth' });
  await proxy.log.flush();
  const files = await readdir(root);
  const logs = (await Promise.all(files.map(f => readFile(join(root, f), 'utf8')))).join('');
  assert.ok(logs.includes('actual context'));
  assert.ok(logs.includes('你好'));
  assert.ok(!logs.includes('secret-auth'));
  assert.ok(!logs.includes('secret-cookie'));
  assert.ok(events.some(e => e.type === 'response.end'));
});

test('SSE first chunk arrives before upstream completion and stop recording keeps forwarding', async t => {
  let finish;
  const { proxy } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    finish = () => res.end('data: last\n\n');
  });
  const response = await fetch(`${proxy.url}/responses`, { method: 'POST', body: '{}' });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  proxy.recording = false;
  finish();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n');
  assert.equal((await reader.read()).done, true);
  const count = proxy.log.sequence;
  const next = await fetch(`${proxy.url}/responses`, { method: 'POST', body: '{}' });
  finish();
  await next.text();
  await proxy.log.flush();
  assert.equal(proxy.log.sequence, count);
});

test('rejects unknown paths and browser origins without reaching upstream', async t => {
  let calls = 0;
  const { proxy } = await setup(t, (_req, res) => { calls++; res.end('unexpected'); });
  const base = new URL(proxy.url).origin;
  assert.equal((await fetch(`${base}/responses`)).status, 404);
  assert.equal((await fetch(`${proxy.url}/responses`, { headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(`${proxy.url}/../../outside`)).status, 404);
  assert.equal(calls, 0);
});

test('WebSocket forwards messages both directions and records text', async t => {
  const { WebSocketServer, WebSocket } = await import('ws');
  const { proxy, upstream, root } = await setup(t, (_req, res) => res.end());
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', socket => socket.on('message', data => socket.send(`reply:${data}`)));
  t.after(() => wss.close());
  const client = new WebSocket(`${proxy.url.replace('http:', 'ws:')}/responses`);
  t.after(() => client.terminate());
  await once(client, 'open');
  const response = once(client, 'message');
  client.send('actual websocket context');
  assert.equal((await response)[0].toString(), 'reply:actual websocket context');
  await proxy.log.flush();
  const logs = (await Promise.all((await readdir(root)).map(f => readFile(join(root, f), 'utf8')))).join('');
  assert.ok(logs.includes('actual websocket context'));
});

test('WebSocket rejection preserves status, headers and body in client and capture', async t => {
  const { WebSocket } = await import('ws');
  const { proxy, upstream, root } = await setup(t, (_req, res) => res.end());
  upstream.on('upgrade', (_req, socket) => {
    const body = '{"error":"rate limit"}';
    socket.end(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\nSet-Cookie: secret-cookie\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  const client = new WebSocket(`${proxy.url.replace('http:', 'ws:')}/responses`);
  client.on('error', () => {});
  t.after(() => client.terminate());
  const result = await new Promise((resolve, reject) => {
    client.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, retry: res.headers['retry-after'], body }));
      res.on('error', reject);
    });
  });
  assert.deepEqual(result, { status: 429, retry: '3', body: '{"error":"rate limit"}' });
  await proxy.log.flush();
  const logs = (await Promise.all((await readdir(root)).map(f => readFile(join(root, f), 'utf8')))).join('');
  assert.ok(logs.includes('rate limit'));
  assert.ok(!logs.includes('secret-cookie'));
});

test('gzip body remains byte-exact and decoded context is available', async t => {
  const { gzipSync } = await import('node:zlib');
  const context = '压缩的请求上下文';
  const compressed = gzipSync(context);
  let received;
  const { proxy, root } = await setup(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    received = Buffer.concat(chunks);
    res.end('ok');
  });
  await (await fetch(`${proxy.url}/responses`, { method: 'POST', headers: { 'content-encoding': 'gzip' }, body: compressed })).text();
  assert.deepEqual(received, compressed);
  // Decompression is asynchronous; wait for its recorded text rather than a timing assumption.
  let logs = '';
  for (let attempt = 0; attempt < 50 && !logs.includes(context); attempt++) {
    await new Promise(resolve => setImmediate(resolve));
    await proxy.log.flush();
    logs = (await Promise.all((await readdir(root)).map(f => readFile(join(root, f), 'utf8')))).join('');
  }
  assert.ok(logs.includes(context));
});
