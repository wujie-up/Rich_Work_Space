import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../desk/src/main/common/storage.js';
import { WebWorkspace } from '../src/server/workspace.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Park a real TLS request at the body boundary, rather than relying on timing sleeps.
async function parked(workspace, path, session, partial) {
  const authenticated = deferred();
  const original = workspace.authenticate.bind(workspace);
  workspace.authenticate = req => {
    const value = original(req);
    authenticated.resolve();
    return value;
  };
  let req;
  const result = new Promise((resolve, reject) => {
    req = request({ hostname: 'localhost', port: workspace.port, path, method: 'POST', rejectUnauthorized: false,
      headers: { origin: `https://localhost:${workspace.port}`, cookie: `__Host-deckpg=${session.token}`,
        'x-deckpg-csrf': session.csrf, 'content-type': 'application/json' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.write(partial);
  });
  await authenticated.promise;
  return { req, result };
}

test('revoking an account rejects parked RPC and upload before side effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckpg-web-revoke-'));
  const storage = new Storage(root);
  let writes = 0;
  const workspace = new WebWorkspace({ storage, root, plugins: {}, handlers: { 'storage.savePreferences': () => ++writes } });
  try {
    await workspace.saveAccount('tester', 'testing-password');
    await workspace.start(0);
    for (const path of ['/api/rpc', '/api/upload?purpose=desktop&name=revoked.txt']) {
      const session = await (await workspace.accounts()).login('tester', 'testing-password');
      const rpc = path === '/api/rpc';
      const pending = await parked(workspace, path, session, rpc ? '{"method":"storage.savePreferences","args":[' : 'partial');
      await workspace.saveAccount('tester', 'testing-password');
      pending.req.end(rpc ? '{}]}' : 'file');
      assert.equal(await pending.result, 401);
    }
    assert.equal(writes, 0);
    assert.deepEqual(await workspace.remote.handlers['plugins.install']([], { token: 'unused' }), []);
  } finally {
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stop invalidates startup before its listener can be published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckpg-web-start-'));
  const storage = new Storage(root);
  const workspace = new WebWorkspace({ storage, root, plugins: {}, handlers: {} });
  try {
    await workspace.saveAccount('tester', 'testing-password');
    const entered = deferred();
    const release = deferred();
    const read = storage.readJson.bind(storage);
    storage.readJson = async (...args) => {
      entered.resolve();
      await release.promise;
      return read(...args);
    };
    const starting = workspace.start(0);
    await entered.promise;
    await workspace.stop();
    release.resolve();
    await starting;
    assert.equal((await workspace.status()).enabled, false);
  } finally {
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});
