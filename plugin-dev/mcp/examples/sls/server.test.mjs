import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, queryParameters, queryTool, signedHeaders, redact, SlsClient } from './server.mjs';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = { endpoint: 'us-west-1.log.aliyuncs.com', project: 'test', logstore: 'app',
  accessKeyId: 'test-id', accessKeySecret: 'test-secret', securityToken: '' };
test('caller targets are advertised and defaults are optional', async t => {
  assert.equal(queryTool.inputSchema.properties.project.type, 'string');
  assert.equal(queryTool.inputSchema.properties.logstore.type, 'string');
  const configured = configuration({ SLS_ENDPOINT: config.endpoint,
    ALIBABA_CLOUD_ACCESS_KEY_ID: config.accessKeyId, ALIBABA_CLOUD_ACCESS_KEY_SECRET: config.accessKeySecret });
  const client = new SlsClient(configured);
  t.after(() => client.close());
  await assert.rejects(client.query({ term: 'x' }), /Project/);
  await assert.rejects(client.query({ term: 'x', project: 'ai-ve' }), /Logstore/);
  for (const project of ['', 'ai-ve/other', 'ai-ve.evil.example', null, 123]) {
    await assert.rejects(client.query({ term: 'x', project, logstore: 'app' }), /Project/);
  }
  for (const logstore of ['', '../app', 'app?x=1', null, 123]) {
    await assert.rejects(client.query({ term: 'x', project: 'ai-ve', logstore }), /Logstore/);
  }
});
test('query bounds, timezone, literal search, fixed pagination and SQL limits', () => {
  assert.equal(queryParameters({ term: 'a"b', from: 100, to: 200 }).query, '"a\\"b"');
  assert.equal(queryParameters({ query: '* | select count(*) as n limit 1', from: '2026-10-20T00:00:00-03:00', to: '2026-10-21T00:00:00-03:00' }).from, '1792465200');
  for (const input of [{ term: 'a', query: 'b' }, { query: '* | select count(*)' }, { term: 'x', offset: 1 },
    { term: 'x', lines: 101 }, { term: 'x', from: '2026-10-20T00:00:00' }, { term: 'x', to: 1792465200000 },
    { term: 'x', minutes: -1 }, { term: 'x', lines: 1.5 },
    { query: '* | select * limit 100000' }, { query: '* | select * limit 0' },
    { query: '* | select * limit 100000 -- limit 1' }, { query: '* | select * limit 100000 /* limit 1' },
    { query: '* | select * limit 100000; select 1 limit 1' },
    { query: '* | select * limit 10', offset: 1, from: 100, to: 200 }]) {
    assert.throws(() => queryParameters(input));
  }
});
test('signature matches the existing Python skill canonical form', () => {
  const params = queryParameters({ query: '* | select count(*) as n limit 1', from: 100, to: 200, lines: 1 });
  const headers = signedHeaders(config, '/logstores/app', params, 'Wed, 21 Oct 2026 00:00:00 GMT');
  const script = `import sys,json,importlib.util\ns=importlib.util.spec_from_file_location('sls',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.formatdate=lambda **kw:'Wed, 21 Oct 2026 00:00:00 GMT'\nx=json.load(sys.stdin);print(m.signed_headers(x['config'], '/logstores/app', x['params'])['Authorization'])`;
  assert.equal(headers.Authorization, execFileSync('python3', ['-c', script,
    '/Users/wujie/.codex/skills/sls-prod-triage/scripts/sls_session.py'], {
    input: JSON.stringify({ config, params }), encoding: 'utf8'
  }).trim());
});
test('redaction removes configured credentials and nested/inline private fields', () => {
  const result = redact({ phone: '123', payload: [{ message: 'token=abc test-secret', text: 'okay' }] }, ['test-secret']);
  assert.equal(redact('Authorization: Bearer synthetic-sensitive-value'), 'Authorization: [REDACTED]');
  assert.equal(result.phone, '[REDACTED]');
  assert.equal(result.payload[0].message, 'token=[REDACTED] [REDACTED]');
});
test('HTTPS query retries Incomplete, reuses connections, and suppresses upstream error content', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'sls-tls-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(folder, 'key'),
    '-out', join(folder, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  let count = 0;
  const targets = [];
  const sockets = new Set();
  const server = https.createServer({ key: await readFile(join(folder, 'key')), cert: await readFile(join(folder, 'cert')) }, (req, res) => {
    count++;
    targets.push({ host: req.headers.host, path: req.url.split('?')[0] });
    sockets.add(req.socket);
    assert.match(req.headers.authorization, /^LOG test-id:/);
    res.setHeader('x-log-requestid', `request-${count}`);
    res.setHeader('x-log-progress', count === 1 ? 'Incomplete' : 'Complete');
    if (count === 4) { res.writeHead(403); res.end('{"errorCode":"Unauthorized","secret":"test-secret"}'); return; }
    res.end('[{"token":"test-secret","message":"okay"}]');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new SlsClient(config, { port: server.address().port, ca: await readFile(join(folder, 'cert')), servername: 'localhost',
    lookup: (_hostname, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) });
  t.after(() => client.close());
  const first = await client.query({ term: 'x', from: 100, to: 200 });
  assert.equal(first.attempts, 2);
  assert.equal(first.progress, 'Complete');
  assert.equal(first.logs[0].token, '[REDACTED]');
  await client.query({ term: 'x', from: 100, to: 200 });
  assert.equal(sockets.size, 1);
  const error = await client.query({ term: 'x', from: 100, to: 200 });
  assert.equal(error.error_code, 'Unauthorized');
  assert.ok(!JSON.stringify(error).includes('test-secret'));
  const results = await Promise.all([
    client.query({ term: 've-order', project: 'ai-ve', logstore: 'app', from: 100, to: 200 }),
    client.query({ term: 'br-order', project: 'ai-br', logstore: 'appserver', from: 100, to: 200 })
  ]);
  assert.deepEqual(results.map(({ project, logstore }) => ({ project, logstore })), [
    { project: 'ai-ve', logstore: 'app' }, { project: 'ai-br', logstore: 'appserver' }
  ]);
  assert.deepEqual(targets.slice(4).sort((a, b) => a.host.localeCompare(b.host)), [
    { host: `ai-br.${config.endpoint}:${server.address().port}`, path: '/logstores/appserver' },
    { host: `ai-ve.${config.endpoint}:${server.address().port}`, path: '/logstores/app' }
  ]);
  const fallback = await client.query({ term: 'default', from: 100, to: 200 });
  assert.equal(fallback.project, config.project);
  assert.equal(fallback.logstore, config.logstore);
  assert.equal(targets.at(-1).host, `test.${config.endpoint}:${server.address().port}`);
});
