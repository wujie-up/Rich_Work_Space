import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { configuration, JenkinsClient } from './server.mjs';

const parameters = [
  { name: 'BRANCH', type: 'StringParameterDefinition', defaultParameterValue: { value: 'main' } },
  { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['dev', 'fat'], defaultParameterValue: { value: 'dev' } },
  { name: 'DRY_RUN', type: 'BooleanParameterDefinition', defaultParameterValue: { value: false } }
];

async function fixture(t, options = {}) {
  const requests = [];
  const job = { name: 'release', fullName: 'folder/release', buildable: true, inQueue: false,
    lastBuild: { number: 10, building: false }, allBuilds: [{ building: false }],
    property: options.parameters ? [{ parameterDefinitions: options.parameters }] : [], ...options.job };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/job/') && /\/\d+\/api\/json/.test(req.url) && req.method === 'GET') {
        res.writeHead(options.buildStatus || 200);
        res.end(JSON.stringify(options.build || { number: 11, queueId: 123, building: false, result: 'SUCCESS', duration: 120000 }));
      } else if (req.url.includes('/job/') && req.method === 'GET') {
        res.writeHead(options.metadataStatus || 200);
        res.end(options.rawMetadata ?? JSON.stringify(job));
      } else if (req.url.startsWith('/jenkins/crumbIssuer/')) {
        res.end(JSON.stringify({ crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb' }));
      } else if (req.method === 'POST') {
        res.writeHead(201, { Location: '/jenkins/queue/item/123/' });
        res.end();
      } else if (req.url.startsWith('/jenkins/queue/')) {
        if (options.hangReceipt) {
          return;
        }
        res.writeHead(options.queueStatus || 200);
        res.end(JSON.stringify(options.queue || { id: 123, task: { fullName: 'folder/release' }, executable: { number: 11 } }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/jenkins/`;
  const config = configuration({ JENKINS_URL: url, JENKINS_USERNAME: 'user', JENKINS_PASSWORD: 'private-password' });
  return { url, requests, client: new JenkinsClient(config, { receiptTimeoutMs: 30 }) };
}

test('preflight infers parameterized endpoint with omitted input and returns a known build receipt', async t => {
  const { client, requests, url } = await fixture(t, { parameters });
  const result = await client.deploy({ job: 'folder/release' });
  assert.equal(result.status, 'submitted');
  assert.equal(result.job, 'folder/release');
  assert.equal(result.job_url, `${url}job/folder/job/release/`);
  assert.equal(result.build_number, 11);
  assert.equal(result.build_url, `${url}job/folder/job/release/11/`);
  assert.equal(result.queue_id, 123);
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, /^\/jenkins\/job\/folder\/job\/release\/api\/json\?/);
  assert.equal(requests.find(req => req.method === 'POST').url, '/jenkins/job/folder/job/release/buildWithParameters');
  assert.equal(requests.filter(req => req.method === 'POST').length, 1);
  assert.equal(requests.filter(req => req.url.startsWith('/jenkins/queue/')).length, 1);
});

test('empty parameters on a nonparameterized Job still use the ordinary build endpoint', async t => {
  const { client, requests } = await fixture(t);
  assert.equal((await client.deploy({ job: 'release', parameters: {} })).status, 'submitted');
  assert.equal(requests.find(req => req.method === 'POST').url, '/jenkins/job/release/build');
});

test('queued, running, disabled and unsupported jobs never receive deployment POST', async t => {
  for (const [job, code] of [[{ inQueue: true }, 'JOB_BUSY'],
    [{ lastBuild: { number: 10, building: true } }, 'JOB_BUSY'], [{ buildable: false }, 'JOB_NOT_BUILDABLE'],
    [{ buildable: undefined, _class: 'com.cloudbees.hudson.plugins.folder.Folder' }, 'JOB_NOT_BUILDABLE']]) {
    const { client, requests } = await fixture(t, { job });
    const result = await client.deploy({ job: 'release' });
    assert.equal(result.error_code, code);
    assert.equal(result.submission, 'not_sent');
    assert.equal(requests.length, 1);
  }
});

test('an older concurrent build still blocks deployment after a newer build completes', async t => {
  const { client, requests } = await fixture(t, { job: {
    lastBuild: { number: 11, building: false }, allBuilds: [{ building: false }, { building: true }]
  } });
  const result = await client.deploy({ job: 'folder/release' });
  assert.equal(result.error_code, 'JOB_BUSY');
  assert.equal(requests.length, 1);
});

test('unknown parameter names, invalid choices and malformed booleans cannot silently deploy defaults', async t => {
  for (const input of [{ BRNACH: 'secret-value' }, { ENV: 'prod' }, { DRY_RUN: 'maybe' }, { DRY_RUN: 0 }]) {
    const { client, requests } = await fixture(t, { parameters });
    const result = await client.deploy({ job: 'release', parameters: input });
    assert.equal(result.error_code, 'INVALID_PARAMETERS');
    assert.equal(result.submission, 'not_sent');
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(result).includes('secret-value'));
  }
});

test('parameters without defaults must be provided; a missing secret never leaks its default', async t => {
  const { client, requests } = await fixture(t, { parameters: [
    { name: 'RELEASE', type: 'StringParameterDefinition', defaultParameterValue: null },
    { name: 'PASSWORD', type: 'PasswordParameterDefinition', defaultParameterValue: { value: 'private-password' } }
  ] });
  const result = await client.deploy({ job: 'release' });
  assert.equal(result.error_code, 'PARAMETERS_REQUIRED');
  assert.deepEqual(result.missing_parameters, ['RELEASE']);
  assert.ok(!JSON.stringify(result).includes('private-password'));
  assert.equal(requests.length, 1);
});

test('target metadata errors and oversized or malformed responses stop before CSRF and deployment', async t => {
  for (const options of [{ metadataStatus: 401 }, { metadataStatus: 403 }, { metadataStatus: 404 },
    { metadataStatus: 302 }, { rawMetadata: 'not-json private-password' }, { rawMetadata: 'x'.repeat(600000) }]) {
    const { client, requests } = await fixture(t, options);
    const result = await client.deploy({ job: 'release' });
    assert.equal(result.status, 'error');
    assert.equal(result.submission, 'not_sent');
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(result).includes('private-password'));
  }
});

test('an accepted deployment stays submitted when the optional receipt is queued, malformed, denied or times out', async t => {
  for (const options of [{ queue: { id: 123, executable: null } }, { queue: { id: 999, executable: { number: 100 } } },
    { queue: { id: 123, task: { fullName: 'other-job' }, executable: { number: 100 } } },
    { queueStatus: 403 }, { hangReceipt: true }]) {
    const { client, requests } = await fixture(t, options);
    const result = await client.deploy({ job: 'release' });
    assert.equal(result.status, 'submitted');
    assert.equal(result.build_number, undefined);
    assert.equal(result.queue_id, 123);
    assert.equal(requests.filter(req => req.method === 'POST').length, 1);
    assert.equal(requests.filter(req => req.url.startsWith('/jenkins/queue/')).length, 1);
  }
});

test('completion status follows the exact queue to its build and reports a terminal success', async t => {
  const { client, requests, url } = await fixture(t);
  const result = await client.deploymentStatus({ job: 'folder/release', queue_id: 123 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.completed, true);
  assert.equal(result.result, 'SUCCESS');
  assert.equal(result.build_number, 11);
  assert.equal(result.duration_ms, 120000);
  assert.equal(result.build_url, `${url}job/folder/job/release/11/`);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(req => req.method === 'GET'));
});

test('status distinguishes queued, running, failed, unstable, aborted and not-built states', async t => {
  const queued = await fixture(t, { queue: { id: 123, task: { fullName: 'folder/release' }, executable: null } });
  const pending = await queued.client.deploymentStatus({ job: 'folder/release', queue_id: 123 });
  assert.equal(pending.status, 'queued');
  assert.equal(pending.completed, false);
  for (const [build, status, completed] of [
    [{ number: 11, queueId: 123, building: true, result: null, duration: 0 }, 'running', false],
    ...['FAILURE', 'UNSTABLE', 'ABORTED', 'NOT_BUILT'].map(result =>
      [{ number: 11, queueId: 123, building: false, result, duration: 1000 },
        { FAILURE: 'failed', UNSTABLE: 'unstable', ABORTED: 'aborted', NOT_BUILT: 'not_built' }[result], true])
  ]) {
    const { client, requests } = await fixture(t, { build });
    const result = await client.deploymentStatus({ job: 'folder/release', build_number: 11 });
    assert.equal(result.status, status);
    assert.equal(result.completed, completed);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
  }
});

test('status rejects wrong queue ownership and never substitutes a newer build for missing history', async t => {
  for (const options of [{ queue: { id: 123, task: { fullName: 'other-job' }, executable: { number: 11 } } },
    { queue: { id: 999, task: { fullName: 'folder/release' }, executable: { number: 11 } } },
    { queueStatus: 404 }, { build: { number: 99, queueId: 123, building: false, result: 'SUCCESS' } },
    { build: { number: 11, queueId: 999, building: false, result: 'SUCCESS' } }]) {
    const { client, requests } = await fixture(t, options);
    const result = await client.deploymentStatus({ job: 'folder/release', queue_id: 123 });
    assert.equal(result.status, 'error');
    assert.equal(result.completed, false);
    assert.ok(requests.every(req => req.method === 'GET'));
    assert.ok(requests.every(req => !req.url.includes('lastBuild')));
  }
});

test('cancelled queues are terminal; missing builds and query failures remain explicit unknown results', async t => {
  const { client } = await fixture(t, { queue: { id: 123, task: { fullName: 'folder/release' }, cancelled: true } });
  const canceled = await client.deploymentStatus({ job: 'folder/release', queue_id: 123 });
  assert.equal(canceled.status, 'cancelled');
  assert.equal(canceled.completed, true);
  for (const options of [{ buildStatus: 404 }, { buildStatus: 403 },
    { build: { number: 11, building: false, result: null } }]) {
    const { client, requests } = await fixture(t, options);
    const result = await client.deploymentStatus({ job: 'folder/release', build_number: 11 });
    assert.equal(result.status, 'error');
    assert.equal(result.completed, false);
    assert.equal(requests.filter(req => req.method === 'POST').length, 0);
  }
});

test('status requires exactly one valid receipt identifier and validates before network access', async t => {
  const { client, requests } = await fixture(t);
  for (const input of [{ job: 'release' }, { job: 'release', queue_id: 0 }, { job: 'release', build_number: -1 },
    { job: 'release', queue_id: 123, build_number: 11 }, { job: '../release', build_number: 11 },
    { job: 'release', queue_id: '123' }, { job: 'release', build_number: 11, parameters: {} }]) {
    await assert.rejects(client.deploymentStatus(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(requests.length, 0);
});
