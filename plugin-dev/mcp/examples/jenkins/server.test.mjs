import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServices } from '../../src/main/common/services.js';
import { temporaryStore } from '../../../../desk/test/helpers.js';
import { configuration, JenkinsClient } from './server.mjs';

const credentials = { JENKINS_USERNAME: 'deploy-user', JENKINS_PASSWORD: ' private-password ' };

async function fixture(t, handler, parameters = []) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const build = req.url.match(/\/job\/release\/(\d+)\/api\/json/);
    if (req.method === 'GET' && build) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ number: Number(build[1]), queueId: 12, building: false, result: 'SUCCESS', duration: 118105 }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/jenkins/job/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ buildable: true, inQueue: false, lastBuild: { building: false }, allBuilds: [{ building: false }],
        property: parameters.length ? [{ parameterDefinitions: parameters }] : [] }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/jenkins/queue/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    await handler(req, res, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/jenkins/`;
  const config = configuration({ ...credentials, JENKINS_URL: url });
  return { url, config, requests, client: new JenkinsClient(config) };
}

function crumb(req, res) {
  if (!req.url.startsWith('/jenkins/crumbIssuer/api/json')) {
    return false;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Set-Cookie', ['JSESSIONID=session-value; Path=/jenkins/; HttpOnly', 'route=node-one; Path=/']);
  res.end(JSON.stringify({ _class: 'hudson.security.csrf.DefaultCrumbIssuer', crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb-value' }));
  return true;
}

test('configuration accepts the supplied view URL and preserves passwords without embedding credentials', () => {
  const config = configuration({ ...credentials, JENKINS_URL: 'http://192.168.3.21:8080/view/co/' });
  assert.equal(config.url.href, 'http://192.168.3.21:8080/');
  assert.equal(config.password, ' private-password ');
  assert.equal(configuration(credentials).url.href, 'http://192.168.3.21:8080/');
  for (const patch of [{ JENKINS_USERNAME: '' }, { JENKINS_PASSWORD: '' }, { JENKINS_USERNAME: 'a:b' },
    { JENKINS_URL: 'file:///tmp/jenkins' }, { JENKINS_URL: 'http://user:pass@host/' },
    { JENKINS_URL: 'https://host/?token=secret' }, { JENKINS_URL: 'https://host/#view' }]) {
    assert.throws(() => configuration({ ...credentials, ...patch }));
  }
});

test('one deployment POST uses nested job paths, Basic authentication, crumb and all session cookies', async t => {
  const { requests, client, url } = await fixture(t, (req, res) => {
    if (crumb(req, res)) {
      return;
    }
    res.writeHead(201, { Location: `${url}queue/item/42/` });
    res.end();
  });
  const result = await client.deploy({ job: 'co/服务 release' });
  assert.equal(result.status, 'submitted');
  assert.equal(result.queue_id, 42);
  assert.equal(result.queue_url, `${url}queue/item/42/`);
  assert.equal(requests.filter(req => req.method === 'POST').length, 1);
  const submission = requests.find(req => req.method === 'POST');
  assert.equal(submission.method, 'POST');
  assert.equal(submission.url, '/jenkins/job/co/job/%E6%9C%8D%E5%8A%A1%20release/build');
  assert.equal(submission.headers.authorization, `Basic ${Buffer.from('deploy-user: private-password ').toString('base64')}`);
  assert.equal(submission.headers['jenkins-crumb'], 'crumb-value');
  assert.equal(submission.headers.cookie, 'JSESSIONID=session-value; route=node-one');
  assert.equal(submission.body, '');
});

test('parameterized deployment encodes scalar values and empty parameter object uses Jenkins defaults', async t => {
  const { requests, client } = await fixture(t, (req, res) => {
    if (!crumb(req, res)) {
      res.writeHead(201, { Location: '/jenkins/queue/item/7/' });
      res.end();
    }
  }, [{ name: 'branch', type: 'StringParameterDefinition', defaultParameterValue: { value: 'main' } },
    { name: 'dryRun', type: 'BooleanParameterDefinition', defaultParameterValue: { value: false } },
    { name: 'replicas', type: 'StringParameterDefinition', defaultParameterValue: { value: '1' } }]);
  const result = await client.deploy({ job: 'release', parameters: { branch: 'feature/a&b', dryRun: false, replicas: 2 } });
  assert.equal(result.status, 'submitted');
  const post = requests.find(req => req.method === 'POST');
  assert.equal(post.url, '/jenkins/job/release/buildWithParameters');
  assert.equal(post.body, 'branch=feature%2Fa%26b&dryRun=false&replicas=2');
  assert.match(post.headers['content-type'], /application\/x-www-form-urlencoded/);
  await client.deploy({ job: 'release', parameters: {} });
  assert.equal(requests.filter(req => req.method === 'POST')[1].url, '/jenkins/job/release/buildWithParameters');
  assert.equal(requests.filter(req => req.method === 'POST').length, 2);
});

test('invalid job paths and non-scalar parameters fail before any Jenkins request', async t => {
  const { client, requests } = await fixture(t, (_req, res) => { res.end(); });
  for (const input of [{}, null, [], { job: '' }, { job: '../release' }, { job: 'a//b' },
    { job: 'http://other/job/x' }, { job: 'a?token=x' }, { job: 'a%2fb' }, { job: 'a\\b' },
    { job: 'a\nb' }, { job: 'ok', parameters: null }, { job: 'ok', parameters: [] },
    { job: 'ok', parameters: { branch: {} } }, { job: 'ok', parameters: { branch: NaN } },
    { job: 'ok', parameters: { '': 'a' } }, { job: 'ok', unsupported: true }]) {
    await assert.rejects(client.deploy(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(requests.length, 0);
});

test('crumb issuer 404 permits one POST for installations without CSRF crumbs', async t => {
  const { client, requests } = await fixture(t, (req, res) => {
    res.writeHead(req.method === 'GET' ? 404 : 201);
    res.end();
  });
  assert.equal((await client.deploy({ job: 'release' })).status, 'submitted');
  assert.equal(requests.filter(req => req.method === 'POST').length, 1);
});

test('authentication failures and malformed crumbs never submit a deployment or leak upstream content', async t => {
  for (const status of [401, 403, 500, 200]) {
    const { client, requests } = await fixture(t, (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ private: credentials.JENKINS_PASSWORD }));
    });
    const result = await client.deploy({ job: 'release' });
    assert.equal(result.status, 'error');
    assert.equal(result.submission, 'not_sent');
    assert.equal(requests.filter(req => req.method === 'POST').length, 0);
    assert.ok(!JSON.stringify(result).includes(credentials.JENKINS_PASSWORD));
  }
});

test('POST rejections are reported once; redirects, server errors and lost connections are uncertain and never retried', async t => {
  for (const status of [400, 401, 403, 404, 405, 302, 500, 200, 'disconnect']) {
    const { client, requests } = await fixture(t, (req, res) => {
      if (crumb(req, res)) {
        return;
      }
      if (status === 'disconnect') {
        req.socket.destroy();
        return;
      }
      res.writeHead(status, { Location: 'https://other.invalid/secret' });
      res.end(credentials.JENKINS_PASSWORD);
    });
    const result = await client.deploy({ job: 'release' });
    assert.equal(result.status, 'error');
    assert.equal(result.submission, [400, 401, 403, 404, 405].includes(status) ? 'rejected' : 'unknown');
    assert.equal(requests.filter(req => req.method === 'POST').length, 1);
    assert.ok(!JSON.stringify(result).includes(credentials.JENKINS_PASSWORD));
  }
});

test('timeout after POST is uncertain; a second simultaneous deployment is rejected before sending', async t => {
  let received;
  const posted = new Promise(resolve => { received = resolve; });
  const { config, requests } = await fixture(t, (req, res) => {
    if (!crumb(req, res)) {
      received();
    }
  });
  const client = new JenkinsClient(config, { timeoutMs: 100 });
  const pending = client.deploy({ job: 'release' });
  await posted;
  const busy = await client.deploy({ job: 'another' });
  assert.equal(busy.error_code, 'BUSY');
  assert.equal(busy.submission, 'not_sent');
  const result = await pending;
  assert.equal(result.error_code, 'SUBMISSION_UNKNOWN');
  assert.equal(result.submission, 'unknown');
  assert.equal(requests.filter(req => req.method === 'POST').length, 1);
});

test('crumb timeouts, oversized bodies and unsafe header names stop before sending POST', async t => {
  for (const kind of ['timeout', 'oversized', 'reserved-header', 'redirect']) {
    const { config, requests } = await fixture(t, (_req, res) => {
      if (kind === 'timeout') {
        return;
      }
      if (kind === 'redirect') {
        res.writeHead(302, { Location: 'http://untrusted.invalid/' });
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(kind === 'oversized' ? JSON.stringify({ crumb: 'x'.repeat(65536) })
        : JSON.stringify({ crumbRequestField: 'Authorization', crumb: 'replace-credentials' }));
    });
    const client = new JenkinsClient(config, { timeoutMs: 100 });
    const result = await client.deploy({ job: 'release' });
    assert.equal(result.submission, 'not_sent');
    assert.equal(result.error_code, kind === 'timeout' ? 'TIMEOUT' : 'CRUMB_FAILED');
    assert.equal(requests.filter(req => req.method === 'POST').length, 0);
  }
});

test('submitted responses never expose untrusted queue links or claim completed deployments', async t => {
  for (const location of ['https://other.invalid/queue/item/8/', '/login?secret=private-password',
    '/jenkins/queue/item/8/?token=private-password', '']) {
    const { client } = await fixture(t, (req, res) => {
      if (!crumb(req, res)) {
        res.writeHead(201, location ? { Location: location } : {});
        res.end();
      }
    });
    const result = await client.deploy({ job: 'release' });
    assert.equal(result.status, 'submitted');
    assert.equal(result.queue_url, undefined);
    assert.equal(result.queue_id, undefined);
    assert.ok(!JSON.stringify(result).includes('private-password'));
  }
});

test('real stdio MCP handshake exposes trigger and status tools and submits once', async t => {
  const { url, requests } = await fixture(t, (req, res) => {
    if (!crumb(req, res)) {
      res.writeHead(201, { Location: '/jenkins/queue/item/9/' });
      res.end();
    }
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [new URL('./server.mjs', import.meta.url).pathname], env: { ...credentials, JENKINS_URL: url }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'jenkins-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['jenkins_deploy', 'jenkins_deployment_status']);
  assert.equal(tools[0].annotations.readOnlyHint, false);
  assert.equal(tools[0].annotations.idempotentHint, false);
  const result = await client.callTool({ name: 'jenkins_deploy', arguments: { job: 'release', parameters: {} } });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content[0].text).status, 'submitted');
  const invalid = await client.callTool({ name: 'jenkins_deploy', arguments: { job: '../bad' } });
  assert.equal(invalid.isError, true);
  const completed = await client.callTool({ name: 'jenkins_deployment_status', arguments: { job: 'release', build_number: 11 } });
  assert.equal(completed.isError, false);
  assert.equal(JSON.parse(completed.content[0].text).result, 'SUCCESS');
  assert.equal(requests.filter(req => req.method === 'POST').length, 1);
  assert.ok(!stderr.includes(credentials.JENKINS_PASSWORD));
  const declaration = JSON.parse(await readFile(new URL('./mcp-service.json', import.meta.url), 'utf8'));
  assert.equal(declaration.fields.find(field => field.name === 'JENKINS_PASSWORD').secret, true);
});

test('imported service runs through the existing MCP manager and retains configuration across restart', async t => {
  const { url, requests } = await fixture(t, (req, res) => {
    if (!crumb(req, res)) {
      res.writeHead(201, { Location: '/jenkins/queue/item/12/' });
      res.end();
    }
  }, [{ name: 'branch', type: 'StringParameterDefinition', defaultParameterValue: { value: 'main' } }]);
  const storage = await temporaryStore(t);
  const services = new McpServices({ storage, pluginId: 'mcp-services',
    importModule: name => import(import.meta.resolve(name)), ownProcesses: () => {} });
  t.after(() => services.close());
  const declaration = JSON.parse(await readFile(new URL('./mcp-service.json', import.meta.url), 'utf8'));
  const files = await Promise.all(['server.mjs', 'mcp-service.json'].map(async path =>
    ({ path, content: await readFile(new URL(path, import.meta.url), 'utf8') })));
  await services.save({ ...declaration, id: 'mcp-jenkins', transport: 'script', interpreter: process.execPath,
    env: { ...credentials, JENKINS_URL: url }, files });
  await services.start('mcp-jenkins');
  assert.deepEqual((await services.tools('mcp-jenkins')).tools.map(tool => tool.name), ['jenkins_deploy', 'jenkins_deployment_status']);
  const result = await services.call('mcp-jenkins', 'jenkins_deploy', { job: 'release', parameters: { branch: 'main' } });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content[0].text).queue_id, 12);
  await services.stop('mcp-jenkins');
  await services.start('mcp-jenkins');
  assert.deepEqual((await services.tools('mcp-jenkins')).tools.map(tool => tool.name), ['jenkins_deploy', 'jenkins_deployment_status']);
  assert.equal(requests.filter(req => req.method === 'POST').length, 1, 'restart and tool discovery must never deploy');
  assert.ok(!(await services.logs('mcp-jenkins')).includes(credentials.JENKINS_PASSWORD));
  const saved = (await services.definitions())[0];
  await services.save({ ...saved, files });
  const updated = (await services.definitions())[0];
  assert.notEqual(updated.deployment, saved.deployment);
  assert.deepEqual(updated.env, saved.env);
  assert.equal(updated.name, saved.name);
  assert.equal(updated.interpreter, saved.interpreter);
});

test('portable MCP entry starts when the configured script path is a symbolic link', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jenkins-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'entry.mjs');
  await symlink(new URL('./server.mjs', import.meta.url), entry);
  const client = new Client({ name: 'linked-entry-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: credentials, stderr: 'pipe' }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['jenkins_deploy', 'jenkins_deployment_status']);
});
