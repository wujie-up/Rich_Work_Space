import test from 'node:test';
import assert from 'node:assert/strict';
import { PingCodeClient, validateConfig, expirationTime } from '../src/main/common/client.js';

const config = { apiRoot: 'https://open.pingcode.com', site: 'https://example.pingcode.com',
  authMode: 'token', accessToken: 'test-secret', valueKey: 'renwujiazhifen' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('all task pages, filters, own custom field and duplicate IDs are handled', async () => {
  const calls = [];
  const client = new PingCodeClient(config, { fetch: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const id = Number(new URL(url).searchParams.get('page_index'));
    return response({ total: 3, values: id === 0 ? [
      { id: '1', short_id: 'abc', whole_identifier: 'DKY-1', properties: { renwujiazhifen: 5, story_points: 20 } },
      { id: '2', properties: {} }
    ] : [{ id: '2', properties: {} }, { id: '3', properties: { renwujiazhifen: 0 } }] });
  } });
  const rows = await client.tasks({ assigneeId: 'person', projectId: 'project' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].score, 5);
  assert.equal(rows[2].score, 0);
  assert.equal(rows[1].score, null);
  assert.equal(rows[0].url, 'https://example.pingcode.com/pjm/workitems/abc');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('assignee_id'), 'person');
  assert.equal(calls[0].url.searchParams.get('project_id'), 'project');
  assert.equal(calls[0].url.searchParams.get('include_deleted'), 'false');
  assert.equal(calls[0].url.searchParams.get('page_size'), '100');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(calls[0].options.redirect, 'error');
});

test('member search paginates without collapsing same display names', async () => {
  const client = new PingCodeClient(config, { fetch: async url => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('keywords'), '吴杰');
    return response({ total: 2, values: [{ id: u.searchParams.get('page_index'), display_name: '吴杰', name: 'unique' }] });
  } });
  assert.equal((await client.members('吴杰')).length, 2);
});

test('a failed later page and upstream errors cannot leak secrets or partial totals', async () => {
  let count = 0;
  const client = new PingCodeClient(config, { fetch: async () => ++count === 1
    ? response({ total: 2, values: [{ id: 'one' }] }) : response({ message: 'test-secret' }, 403) });
  await assert.rejects(client.tasks({ assigneeId: 'p' }), error => error.code === 'FORBIDDEN' && !error.message.includes('test-secret'));
  for (const status of [401, 429, 500]) {
    const broken = new PingCodeClient(config, { fetch: async () => response({ message: 'test-secret' }, status) });
    await assert.rejects(broken.projects(), error => !error.message.includes('test-secret'));
  }
});

test('enterprise authorization retries once on 401 and caches the replacement token', async () => {
  let tokens = 0;
  let requests = 0;
  const client = new PingCodeClient({ ...config, authMode: 'client', clientId: 'id', clientSecret: 'secret' }, {
    fetch: async (url, options) => {
      if (new URL(url).pathname.endsWith('/auth/token')) {
        tokens++;
        assert.equal(new URL(url).searchParams.get('grant_type'), 'client_credentials');
        return response({ access_token: `token-${tokens}`, expires_in: 3600 });
      }
      requests++;
      if (requests === 1) { return response({}, 401); }
      assert.equal(options.headers.Authorization, 'Bearer token-2');
      return response({ total: 0, values: [] });
    }
  });
  await client.projects();
  await client.projects();
  assert.equal(tokens, 2);
  assert.equal(requests, 3);
  assert.equal(expirationTime(3600, 1000000000000), 1000003600000);
  assert.equal(expirationTime(1900000000, 1000000000000), 1900000000000);
});

test('request timeout, cancellation and unsafe addresses fail safely', async t => {
  // Unlike a real HTTP socket, this fetch substitute has no event-loop handle of its own.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const client = new PingCodeClient(config, { fetch, timeoutMs: 10 });
  await assert.rejects(client.projects(), /超时/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.projects(controller.signal), /取消/);
  for (const apiRoot of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?token=secret']) {
    assert.throws(() => validateConfig({ ...config, apiRoot }), /HTTPS|地址/);
  }
});

test('empty or repeated pages cannot silently produce an incomplete successful result', async () => {
  const client = new PingCodeClient(config, { fetch: async () => response({ total: 2, values: [] }) });
  await assert.rejects(client.tasks({ assigneeId: 'p' }), /分页/);
  const repeated = new PingCodeClient(config, { fetch: async () => response({ total: 2, values: [{ id: 'one' }] }) });
  await assert.rejects(repeated.tasks({ assigneeId: 'p' }), /分页/);
});

test('custom roles query the project without restricting the built-in assignee', async () => {
  const client = new PingCodeClient(config, { fetch: async url => {
    assert.equal(url.searchParams.has('assignee_id'), false);
    return response({ total: 2, values: [
      { id: 'dev', assignee: { id: 'other' }, properties: { kaifafuzeren: { id: 'person', display_name: '吴杰' } } },
      { id: 'test', assignee: { id: 'person' }, properties: { ceshifuzeren: { id: 'person', display_name: '吴杰' } } }
    ] });
  } });
  for (const [role, expected] of [['developer', 'dev'], ['tester', 'test']]) {
    const rows = await client.tasks({ assigneeId: 'person', role });
    assert.deepEqual(rows.map(row => row.id), [expected]);
    assert.equal(rows[0].assignee, '吴杰');
  }
});
