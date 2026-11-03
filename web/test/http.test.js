import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Agent, request } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { certificate } from '../src/server/certificate.js';
import { listener, json } from '../src/server/http.js';

test('remote receiver keeps HTTP connections until transport closure while LAN retains its idle limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wd-http-idle-'));
  const tls = await certificate(directory);
  const handle = (_request, response) => json(response, { ok: true });
  const remote = await listener(tls, handle, null);
  const lan = await listener(tls, handle, 0);
  const ingress = createServer(socket => remote.accept(socket));
  await new Promise(resolve => ingress.listen(0, '127.0.0.1', resolve));
  const agent = new Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
  t.after(async () => {
    agent.destroy();
    await remote.close();
    await lan.close();
    await new Promise(resolve => ingress.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const get = port => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/', agent }, response => {
      response.resume();
      response.on('end', () => resolve({ socket: req.socket, reused: req.reusedSocket, headers: response.headers }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  assert.match((await get(lan.port)).headers['keep-alive'], /timeout=5/);
  const first = await get(ingress.address().port);
  // A delayed relay response can arrive after Node's default five-second idle deadline.
  await setTimeout(6500);
  assert.equal(first.socket.destroyed, false, 'remote idle closure races the delayed response and next POST');
  const next = await get(ingress.address().port);
  assert.equal(next.reused, true);
  assert.equal(next.socket, first.socket);
  const closed = new Promise(resolve => first.socket.once('close', resolve));
  await remote.close();
  await closed;
  assert.equal(first.socket.destroyed, true);
});
