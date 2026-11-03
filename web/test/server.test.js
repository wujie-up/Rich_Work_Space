import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Storage } from '../../desk/src/main/common/storage.js';
import { WebWorkspace } from '../src/server/workspace.js';

export function call(port, path, { method = 'GET', body, cookie, origin = `https://localhost:${port}`, csrf, host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: 'localhost', port, path, method, rejectUnauthorized: false,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin,
        ...(csrf ? { 'x-deckpg-csrf': csrf } : {}), ...(host ? { host } : {}), ...headers } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const bytes = Buffer.concat(parts);
        const text = bytes.toString();
        resolve({ status: res.statusCode, headers: res.headers, text, bytes, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body && JSON.stringify(body));
  });
}

test('HTTPS workspace gates RPC, rejects cross-origin/administration, separates plugin origin and revokes on stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckpg-web-'));
  const storage = new Storage(join(root, 'data'));
  const plugin = join(root, 'data/plugins/example');
  await mkdir(plugin, { recursive: true });
  await mkdir(join(root, 'web/dist'), { recursive: true });
  await writeFile(join(root, 'web/dist/index.html'), '<h1>DeskPG</h1>');
  const inputFiles = { 'plugin-input.js': '0'.repeat(64), 'plugin-input.css': '1'.repeat(64) };
  const inputVersion = createHash('sha256').update(JSON.stringify(inputFiles)).digest('hex');
  await writeFile(join(root, 'web/dist/plugin-input-manifest.json'), JSON.stringify({ version: inputVersion, files: inputFiles }));
  await writeFile(join(root, 'web/dist/plugin-input.js'), 'window.webInputFixture = true;');
  await writeFile(join(root, 'web/dist/plugin-input.css'), '.fixture{}');
  const stylesheet = '.workspace { color: black; background: white; }\n'.repeat(100);
  await writeFile(join(root, 'web/dist/app.css'), stylesheet);
  await writeFile(join(plugin, 'index.html'), '<h1>Plugin</h1>');
  await writeFile(join(plugin, 'app.css'), stylesheet);
  const plugins = { list: async () => [{ id: 'example', state: 'enabled' }], assertEnabled: id => assert.equal(id, 'example') };
  const workspace = new WebWorkspace({ root, storage, plugins, handlers: { 'plugins.list': plugins.list, 'storage.getPreferences': () => ({ theme: 'dark' }) } });
  try {
    assert.equal((await workspace.status()).enabled, false);
    await workspace.saveAccount('tester', 'testing-password');
    await workspace.configure({ enabled: true, port: 0 });
    const port = workspace.port;
    const gzipHeaders = { 'accept-encoding': 'gzip, deflate, br' };
    const compressed = await call(port, '/app.css', { headers: gzipHeaders });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(compressed.bytes).toString(), stylesheet);
    assert.ok(compressed.bytes.length < Buffer.byteLength(stylesheet) / 2);
    assert.equal(compressed.headers['cache-control'], 'no-store');
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    assert.equal(Number(compressed.headers['content-length']), compressed.bytes.length);
    for (const accepted of ['', 'br', 'gzip;q=0', '*;q=1, gzip;q=0', 'gzip;q=invalid']) {
      const plain = await call(port, '/app.css', { headers: { 'accept-encoding': accepted } });
      assert.equal(plain.headers['content-encoding'], undefined, accepted);
      assert.equal(plain.text, stylesheet);
    }
    assert.equal((await call(port, '/', { headers: gzipHeaders })).headers['content-encoding'], undefined);
    assert.equal((await call(port, '/api/rpc', { method: 'POST', body: { method: 'plugins.list', args: [] } })).status, 401);
    assert.equal((await call(port, '/api/session', { host: `evil.example:${port}` })).status, 403);
    const login = await call(port, '/api/login', { method: 'POST', headers: gzipHeaders,
      body: { username: 'tester', password: 'testing-password' } });
    assert.equal(login.status, 200);
    assert.equal(login.headers['content-encoding'], undefined);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.match(login.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);
    const csrf = login.json().csrf;
    assert.equal((await call(port, '/api/rpc', { method: 'POST', cookie,
      body: { method: 'plugins.list', args: [] } })).status, 403);
    assert.equal((await call(port, '/api/login', { method: 'POST',
      body: { username: 'tester', password: 'incorrect' } })).status, 401);
    const rpc = body => call(port, '/api/rpc', { method: 'POST', body, cookie, csrf });
    assert.equal((await call(port, '/api/rpc', { method: 'POST', cookie, csrf, origin: 'https://evil.example', body: {} })).status, 403);
    assert.equal((await rpc({ method: 'web.accounts', args: [] })).status, 403);
    assert.equal((await rpc({ method: 'host.quit', args: [] })).status, 403);
    const records = (await rpc({ method: 'plugins.list', args: [] })).json().value;
    assert.ok(records[0].webPort !== port);
    const pluginPort = records[0].webPort;
    assert.equal((await call(pluginPort, '/app.css', { headers: gzipHeaders })).status, 401);
    const pluginStyle = await call(pluginPort, '/app.css', { cookie, headers: gzipHeaders });
    assert.equal(pluginStyle.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(pluginStyle.bytes).toString(), stylesheet);
    const pluginPage = await call(pluginPort, '/index.html', { cookie });
    assert.equal(pluginPage.status, 200);
    assert.match(pluginPage.text, new RegExp(`/_web_input/${inputVersion}/plugin-input.js`));
    assert.equal((await call(pluginPort, `/_web_input/${inputVersion}/plugin-input.js`)).status, 401);
    assert.equal((await call(pluginPort, `/_web_input/${inputVersion}/plugin-input.js`, { cookie })).status, 200);
    assert.equal((await call(pluginPort, `/_web_input/${'0'.repeat(64)}/plugin-input.js`, { cookie })).status, 404);
    assert.equal((await call(pluginPort, '/api/rpc', { cookie })).status, 404);
    assert.equal((await call(pluginPort, '/%2e%2e%2faccounts.sqlite', { cookie })).status, 404);
    await workspace.saveAccount('tester', 'replacement-password');
    assert.equal((await call(port, '/api/session', { cookie })).status, 401);
    assert.equal((await call(pluginPort, '/index.html', { cookie })).status, 401);
    const fresh = await call(port, '/api/login', { method: 'POST',
      body: { username: 'tester', password: 'replacement-password' } });
    const freshCookie = fresh.headers['set-cookie'][0].split(';')[0];
    await workspace.stop();
    await workspace.start();
    assert.equal((await call(workspace.port, '/api/session', { cookie: freshCookie })).status, 401);
    assert.equal((await call(workspace.port, '/api/session', { cookie })).status, 401);
  } finally {
    await workspace.stop();
    await workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});
