import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ExtensionSession } from '../src/main/common/extension-session.js';

const site = 'https://example.pingcode.com';
const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32);
function connect(url, token, origin = extensionOrigin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ['pingcode-v1', token], { origin });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('loopback bridge pairs extensions only, bounds reads and cancels pending work on disconnect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-bridge-'));
  const session = new ExtensionSession({ root, timeoutMs: 70 });
  t.after(async () => { await session.stop(); await rm(root, { recursive: true, force: true }); });
  const initial = await session.open(site);
  const pair = new URL(initial.pairingUrl);
  const endpoint = 'ws://' + pair.host + '/bridge';
  const token = pair.hash.slice(1);
  assert.equal(token.length, 43);
  assert.equal(initial.state, 'closed');
  assert.equal(session.status().pairingUrl, undefined);
  const response = await fetch(pair.origin + '/pair');
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(token), false);
  assert.equal((await stat(join(root, 'browser-bridge.json'))).mode & 0o777, 0o600);
  await assert.rejects(connect(endpoint, token, 'https://evil.example'));
  await assert.rejects(connect(endpoint, 'x'.repeat(43)));
  const socket = await connect(endpoint, token);
  let commands = [];
  let accountId = 'one';
  socket.on('message', bytes => {
    const command = JSON.parse(bytes);
    commands.push(command);
    if (command.action === 'read' && command.path.includes('account')) {
      socket.send(JSON.stringify({ id: command.id, result: { status: 200, body: { code: 200, data: { me: { uid: accountId } } } } }));
    }
    if (command.action === 'query') {
      socket.send(JSON.stringify({ id: command.id, result: { status: 200, body: { code: 200,
        data: { value: [], count: 0, page_index: command.params.pi, page_size: command.params.ps } } } }));
    }
  });
  await session.check();
  assert.equal(session.status().state, 'connected');
  const body = { pi: 0, ps: 100, criteria: { condition_logic: 1, conditions: [
    { property_key: 'completed_at', operation: 2, value: 0, logic: 1 },
    { property_key: 'completed_at', operation: 5, value: 1, logic: 1 }
  ] } };
  await assert.rejects(session.query(site, body), error => error.code === 'EXTENSION_UPDATE_REQUIRED');
  socket.send(JSON.stringify({ action: 'hello', protocol: 2 }));
  for (let index = 0; index < 20 && !session.status().supportsQuery; index++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await session.query(site, body)).count, 0);
  const authenticatedEpoch = session.status().epoch;
  await session.check();
  assert.equal(session.status().epoch, authenticatedEpoch, 'checking the same identity must preserve current task results');
  accountId = 'another-person';
  await session.check();
  assert.notEqual(session.status().epoch, authenticatedEpoch, 'switching the browser account must invalidate previous results');
  await assert.rejects(session.read('https://evil.example', '/api/agile/work-items'), /站点/);
  await assert.rejects(session.read(site, '/api/agile/../auth/token'), /请求/);
  await assert.rejects(session.read(site, '/api/agile/work-items'), error => error.code === 'TIMEOUT');
  const controller = new AbortController();
  const pending = session.read(site, '/api/agile/work-items', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  const before = session.status().epoch;
  const interrupted = session.read(site, '/api/agile/work-items');
  socket.terminate();
  await assert.rejects(interrupted, error => error.code === 'CANCELLED');
  assert.notEqual(session.status().epoch, before);
  await session.stop();
  const saved = JSON.parse(await readFile(join(root, 'browser-bridge.json'), 'utf8'));
  const restarted = new ExtensionSession({ root });
  t.after(() => restarted.stop());
  assert.equal(new URL((await restarted.open(site)).pairingUrl).port, String(saved.port));
  assert.equal(new URL((await restarted.open(site)).pairingUrl).hash.slice(1), token);
  const reconnected = await connect(endpoint, token);
  reconnected.on('message', () => {});
  await restarted.disconnect();
  await assert.rejects(connect(endpoint, token));
});
