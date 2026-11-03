import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listener, staticFile, httpError } from '../src/server/http.js';
import { certificate } from '../src/server/certificate.js';
import { request } from 'node:https';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wd-static-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('shell negotiation strips only build assets and requires an exact content version', async t => {
  const { shellDocument } = await import('../src/server/static-resources.js');
  const directory = await fixture(t);
  const files = { 'app.js': hash('javascript'), 'app.css': hash('stylesheet') };
  const version = hash(JSON.stringify(files));
  await writeFile(join(directory, 'shell-manifest.json'), JSON.stringify({ version, files }));
  await writeFile(join(directory, 'index.html'), '<html><head><link rel="stylesheet" href="app.css"></head><body><main id="content"></main><script type="module" src="app.js"></script></body></html>');
  const html = await shellDocument(directory, version);
  assert.match(html, new RegExp(`data-work-desk-shell="${version}"`));
  assert.match(html, /id="content"/);
  assert.doesNotMatch(html, /src="app.js"|href="app.css"/);
  assert.equal(await shellDocument(directory, 'a'.repeat(64)), null);
  assert.equal(await shellDocument(directory, undefined), null);
  await rm(join(directory, 'shell-manifest.json'));
  assert.equal(await shellDocument(directory, version), null);
});

test('package content versions cache only inventoried static files and reject forged prefixes', async t => {
  const { pluginResources } = await import('../src/server/static-resources.js');
  const directory = await fixture(t);
  await mkdir(join(directory, 'dist'), { recursive: true });
  const files = { 'dist/index.html': hash('page'), 'dist/app.js': hash('code'), 'data.json': hash('private') };
  await writeFile(join(directory, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files }));
  const resources = await pluginResources(directory);
  const entry = resources.entry('dist/index.html');
  assert.match(entry, /^__assets\/[a-f0-9]{64}\/dist\/index.html$/);
  assert.deepEqual(resources.resolve('/' + entry), { pathname: '/dist/index.html', cache: true });
  assert.equal(resources.resolve('/__assets/' + resources.version + '/data.json').cache, false);
  assert.equal(resources.resolve('/dist/app.js').cache, false);
  const browserOne = await pluginResources(directory, 'browser-input-one');
  const browserTwo = await pluginResources(directory, 'browser-input-two');
  assert.notEqual(browserOne.entry('dist/index.html'), browserTwo.entry('dist/index.html'));
  assert.throws(() => browserTwo.resolve('/' + browserOne.entry('dist/index.html')), { status: 404 });
  for (const path of ['/__assets/' + '0'.repeat(64) + '/dist/app.js', '/__assets/' + resources.version + '/not-listed.js',
    '/__assets/' + resources.version + '/%2e%2e/secret.js', '/__assets/' + resources.version + '/dist/%5capp.js']) {
    assert.throws(() => resources.resolve(path), { status: 404 });
  }
  files['dist/app.js'] = hash('different code, unchanged package version');
  await writeFile(join(directory, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files }));
  assert.notEqual((await pluginResources(directory)).version, resources.version);
  await rm(join(directory, 'integrity.json'));
  const legacy = await pluginResources(directory);
  assert.equal(legacy.entry('dist/index.html'), 'dist/index.html');
  assert.deepEqual(legacy.resolve('/dist/app.js'), { pathname: '/dist/app.js', cache: false });
  assert.throws(() => legacy.resolve('/__assets/' + resources.version + '/dist/app.js'), { status: 404 });
});

test('static cache never covers JSON, symlinks, errors or authorization revoked after file reads', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'app.js'), 'export const example = true;'.repeat(100));
  await writeFile(join(directory, 'data.json'), '{"private":true}');
  await symlink(join(directory, 'app.js'), join(directory, 'link.js'));
  const tls = await certificate(join(directory, 'tls'));
  let revoked = false;
  let revokeAfterRead = false;
  const server = await listener(tls, (req, res) => {
    if (revokeAfterRead) {
      Object.defineProperty(req.headers, 'accept-encoding', { get: () => { revoked = true; return 'gzip'; } });
    }
    return staticFile(res, directory, new URL(req.url, 'https://localhost').pathname,
      { cache: true, validate: () => { if (revoked) { throw httpError(401, 'revoked'); } } });
  }, 0);
  t.after(() => server.close());
  const get = path => new Promise((resolve, reject) => {
    request({ hostname: 'localhost', port: server.port, path, rejectUnauthorized: false }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['cache-control'] }));
    }).on('error', reject).end();
  });
  assert.match((await get('/app.js')).cache, /^private, max-age=/);
  assert.equal((await get('/data.json')).cache, 'no-store');
  assert.deepEqual(await get('/missing.js'), { status: 404, cache: 'no-store' });
  assert.deepEqual(await get('/link.js'), { status: 404, cache: 'no-store' });
  revokeAfterRead = true;
  assert.deepEqual(await get('/app.js'), { status: 401, cache: 'no-store' });
});
