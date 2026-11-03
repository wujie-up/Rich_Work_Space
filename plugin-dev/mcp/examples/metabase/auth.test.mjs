import assert from 'node:assert/strict';
import test from 'node:test';
import { configuration, MetabaseClient } from './server.mjs';

const credentials = { METABASE_URL: 'https://bi.example.com/metabase',
  METABASE_USERNAME: 'analyst@example.com', METABASE_PASSWORD: ' password-with-spaces ' };
const configured = session => configuration({ ...credentials, METABASE_SESSION: session });
const catalog = () => Response.json([{ id: 1, name: 'Production' }]);
const dataset = value => Response.json({ status: 'completed', data: { rows: [[value]], cols: [{ name: 'note' }] } });

test('account configuration permits login without a token and preserves password whitespace', () => {
  const config = configured();
  assert.equal(config.username, credentials.METABASE_USERNAME);
  assert.equal(config.password, credentials.METABASE_PASSWORD);
  assert.equal(config.session, '');
  for (const env of [{ METABASE_PASSWORD: '' }, { METABASE_USERNAME: '' }]) {
    assert.throws(() => configuration({ ...credentials, ...env }));
  }
});

test('first request logs in once and subsequent calls reuse the in-memory session', async () => {
  const calls = [];
  const client = new MetabaseClient(configured(), { fetch: async (url, options) => {
    calls.push(url.pathname);
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('/session')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { username: credentials.METABASE_USERNAME, password: credentials.METABASE_PASSWORD });
      assert.equal(options.headers['X-Metabase-Session'], undefined);
      return Response.json({ id: 'new-session' });
    }
    assert.equal(options.headers['X-Metabase-Session'], 'new-session');
    return url.pathname.endsWith('/database') ? catalog() : dataset('readable text');
  } });
  assert.equal((await client.query({ sql: 'select 1' })).rows[0][0], 'readable text');
  assert.equal((await client.query({ sql: 'select 1' })).status, 'ok');
  assert.deepEqual(calls, ['/metabase/api/session', '/metabase/api/database', '/metabase/api/dataset', '/metabase/api/dataset']);
});

for (const expired of ['database', 'dataset']) {
  test(`${expired} 401 logs in and replays only the rejected request with the same deadline`, async () => {
    const calls = [];
    let signal;
    let rejectedBody;
    const client = new MetabaseClient(configured('expired-session'), { fetch: async (url, options) => {
      signal ??= options.signal;
      assert.equal(options.signal, signal);
      calls.push(url.pathname.split('/').at(-1));
      if (url.pathname.endsWith('/session')) { return Response.json({ id: 'renewed-session' }); }
      if (url.pathname.endsWith(`/${expired}`) && options.headers['X-Metabase-Session'] === 'expired-session') {
        rejectedBody = options.body;
        return new Response('upstream private error', { status: 401 });
      }
      if (expired === 'dataset' && url.pathname.endsWith('/dataset')) { assert.equal(options.body, rejectedBody); }
      return url.pathname.endsWith('/database') ? catalog() : dataset('renewed-session expired-session  password-with-spaces ');
    } });
    const data = await client.query({ sql: 'select 1' });
    assert.equal(data.status, 'ok');
    assert.deepEqual(calls, expired === 'database' ? ['database', 'session', 'database', 'dataset']
      : ['database', 'dataset', 'session', 'dataset']);
    for (const secret of ['renewed-session', 'expired-session', credentials.METABASE_PASSWORD]) {
      assert.equal(JSON.stringify(data).includes(secret), false);
    }
  });
}

test('retry 401 stops without a login loop and invalidates the catalog', async () => {
  let logins = 0;
  let reads = 0;
  const client = new MetabaseClient(configured('expired-session'), { fetch: async url => {
    if (url.pathname.endsWith('/session')) { logins++; return Response.json({ id: 'also-expired' }); }
    reads++;
    return new Response(null, { status: 401 });
  } });
  assert.equal((await client.databases()).error_code, 'AUTH_EXPIRED');
  assert.equal(logins, 1);
  assert.equal(reads, 2);
  assert.equal(client.databaseCache, null);
});

test('403 and transient failures never trigger login or retry the query', async () => {
  for (const [status, code] of [[403, 'ACCESS_DENIED'], [500, 'UPSTREAM_ERROR']]) {
    const paths = [];
    const client = new MetabaseClient(configured('valid-session'), { fetch: async url => {
      paths.push(url.pathname);
      return new Response(null, { status });
    } });
    assert.equal((await client.databases()).error_code, code);
    assert.equal(paths.length, 1);
  }
});

test('login failures are sanitized and never proceed to a database request', async () => {
  for (const [status, body, code] of [[401, {}, 'LOGIN_FAILED'], [400, {}, 'LOGIN_FAILED'],
    [429, {}, 'LOGIN_FAILED'], [500, {}, 'UPSTREAM_ERROR'], [200, {}, 'INVALID_RESPONSE'],
    [200, { id: '', password: credentials.METABASE_PASSWORD }, 'INVALID_RESPONSE']]) {
    let calls = 0;
    const client = new MetabaseClient(configured(), { fetch: async () => { calls++; return Response.json(body, { status }); } });
    const data = await client.databases();
    assert.equal(data.error_code, code);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(data).includes(credentials.METABASE_PASSWORD), false);
  }
});

test('login shares request timeout and single-flight guard', async () => {
  const client = new MetabaseClient(configured(), { timeoutMs: 20, fetch: async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const pending = client.databases();
  assert.equal((await client.databases()).error_code, 'BUSY');
  assert.equal((await pending).error_code, 'TIMEOUT');
});
