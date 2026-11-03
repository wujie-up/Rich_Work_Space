import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Providers } from '../src/main/common/providers.js';

test('provider updates retain private keys without returning them and deletion does not silently fall back', async t => {
  const storage = await temporaryStore(t);
  const providers = new Providers({ root: storage.root });
  const saved = await providers.save({ name: 'Example', engineId: 'codex', protocol: 'responses', baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'private-value' });
  assert.equal(saved.hasSecret, true);
  assert.equal(JSON.stringify(saved).includes('private-value'), false);
  await providers.save({ ...saved, name: 'Renamed' });
  const launch = await providers.resolve('codex', saved.id);
  assert.equal(launch.env.WORK_DESK_PROVIDER_KEY, 'private-value');
  assert.ok(launch.args.includes('model="test"'));
  assert.equal((await stat(join(storage.root, 'providers.json'))).mode & 0o777, 0o600);
  assert.equal((await providers.list())[0].name, 'Renamed');
  assert.equal((await readFile(join(storage.root, 'providers.json'), 'utf8')).includes('private-value'), true);
  await providers.remove(saved.id);
  await assert.rejects(providers.resolve('codex', saved.id), /供应商/);
});

test('provider secrets are engine scoped and explicit clearing is preserved', async t => {
  const storage = await temporaryStore(t);
  const providers = new Providers({ root: storage.root });
  const saved = await providers.save({ name: 'Claude', engineId: 'claude', protocol: 'anthropic', baseUrl: 'https://example.com', model: 'model', apiKey: 'secret' });
  await assert.rejects(providers.resolve('codex', saved.id), /引擎/);
  await providers.save({ ...saved, clearSecret: true });
  assert.equal((await providers.list())[0].hasSecret, false);
  await assert.rejects(providers.resolve('claude', saved.id), /密钥/);
});

test('provider probes send engine protocols, suppress errors and retain non-secret history snapshots', async t => {
  const { createServer } = await import('node:http');
  const received = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) { text += chunk; }
    received.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.endsWith('/messages') ? { content: [] } : { output: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const storage = await temporaryStore(t);
  const providers = new Providers({ root: storage.root });
  for (const engineId of ['codex', 'claude']) {
    const profile = await providers.save({ name: engineId, engineId, protocol: engineId === 'codex' ? 'responses' : 'anthropic',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'original', apiKey: 'synthetic-test-key' });
    assert.deepEqual(await providers.test(engineId, profile.id), { connected: true, protocol: profile.protocol, engineVerified: false });
    const request = received.at(-1);
    assert.equal(request.url, engineId === 'codex' ? '/v1/responses' : '/v1/messages');
    assert.equal(request.headers[engineId === 'codex' ? 'authorization' : 'x-api-key'],
      engineId === 'codex' ? 'Bearer synthetic-test-key' : 'synthetic-test-key');
    const original = (await providers.resolve(engineId, profile.id)).provider;
    await providers.save({ ...profile, model: 'changed', apiKey: 'rotated-key' });
    const resumed = await providers.resolve(engineId, profile.id, original);
    assert.equal(resumed.provider.model, 'original');
    assert.equal(JSON.stringify(resumed.provider).includes('key'), false);
    assert.ok(Object.values(resumed.env).includes('rotated-key'));
  }
});
