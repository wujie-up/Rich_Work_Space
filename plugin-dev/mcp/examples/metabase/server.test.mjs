import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { configuration, queryParameters, MetabaseClient, serve } from './server.mjs';

const config = () => configuration({ METABASE_URL: 'https://bi.example.com', METABASE_DATABASE_ID: '13371352',
  METABASE_SESSION: 'private-session' });
const datasetFetch = handler => (url, options) => url.pathname.endsWith('/database')
  ? Promise.resolve(Response.json({ data: [{ id: 13371352, name: 'Production', engine: 'mysql' }] }))
  : handler(url, options);
const result = (rows = [[1]], cols = [{ name: 'ok', base_type: 'type/Integer' }]) =>
  Response.json({ status: 'completed', data: { rows, cols }, row_count: rows.length });

test('configuration binds HTTPS target without requiring a database ID', () => {
  assert.equal(config().url.href, 'https://bi.example.com/api/dataset');
  assert.equal(Object.hasOwn(config(), 'database'), false);
  for (const env of [{ METABASE_URL: 'http://bi.example.com' }, { METABASE_URL: 'https://user:pass@bi.example.com' },
    { METABASE_SESSION: '' }]) {
    assert.throws(() => configuration({ METABASE_URL: 'https://bi.example.com', METABASE_DATABASE_ID: '13371352',
      METABASE_SESSION: 'private-session', ...env }));
  }
});

test('single SELECT is bounded and SQL literals do not count as executable keywords', () => {
  assert.equal(queryParameters({ sql: "select id from financial.orders where country_code='BR';" }).sql,
    "select id from financial.orders where country_code='BR' LIMIT 20");
  assert.equal(queryParameters({ sql: "select 'delete; -- x', count(*) from orders limit 5", limit: 10 }).limit, 5);
  assert.equal(queryParameters({ sql: 'select `id` from orders limit 2' }).limit, 2);
  for (const sql of ['delete from orders', 'select 1; delete from orders', 'select 1 -- limit 1',
    'select /* hint */ 1', 'select 1 into outfile "/tmp/x"', 'select * from orders for update',
    'select sleep(30)', 'select custom_mutation()', 'select schema.count(*)', 'select @x := 1',
    'with x as (delete from orders returning *) select * from x', 'select 1 limit 101',
    'select 1 limit 2 offset 1', "select 'unterminated", 'select 1 union select 2 limit 0']) {
    assert.throws(() => queryParameters({ sql }), sql);
  }
  assert.throws(() => queryParameters({ sql: 'select 1', limit: 101 }));
  assert.doesNotThrow(() => queryParameters({ sql: 'select 1', database: 'Production' }));
  assert.throws(() => queryParameters({ sql: 'select 1', database: 0 }));
});

test('dataset request matches supplied API, limits rows and redacts sensitive columns', async () => {
  let request;
  const client = new MetabaseClient(config(), { fetch: datasetFetch(async (url, options) => {
    request = { url, ...options };
    return result([[1, 'secret-value', 'private-session']],
      [{ name: 'id' }, { name: 'api_key' }, { name: 'note' }]);
  }) });
  const data = await client.query({ sql: 'select id, api_key, note from financial.orders', limit: 2 });
  assert.equal(request.headers['X-Metabase-Session'], 'private-session');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), { type: 'native', database: 13371352,
    native: { query: 'select id, api_key, note from financial.orders LIMIT 2', 'template-tags': {} }, parameters: [],
    constraints: { 'max-results': 2, 'max-results-bare-rows': 2 } });
  assert.equal(data.status, 'ok');
  assert.deepEqual(data.rows, [[1, '[REDACTED]', '[REDACTED]']]);
  assert.equal(data.row_count, 1);
  assert.equal(JSON.stringify(data).includes('private-session'), false);
});

test('upstream failure, redirects, malformed data and oversized responses do not leak bodies', async () => {
  for (const [response, code] of [
    [new Response('private-session private database error', { status: 401 }), 'AUTH_EXPIRED'],
    [new Response('private-session', { status: 403 }), 'ACCESS_DENIED'],
    [new Response('private-session', { status: 500 }), 'UPSTREAM_ERROR'],
    [Response.json({ status: 'failed', error: 'private-session SELECT secret' }), 'QUERY_FAILED'],
    [Response.json({ data: { rows: [] } }), 'INVALID_RESPONSE'],
    [new Response(null), 'INVALID_RESPONSE'],
    [new Response('x'.repeat(1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE']
  ]) {
    const client = new MetabaseClient(config(), { fetch: datasetFetch(async () => response) });
    const data = await client.query({ sql: 'select 1' });
    assert.equal(data.error_code, code);
    assert.equal(JSON.stringify(data).includes('private-session'), false);
  }
});

test('configuration JSON and embedded credentials are redacted without losing non-sensitive values', async () => {
  const client = new MetabaseClient(config(), { fetch: datasetFetch(async () => result([
    ['{"channel":"example","clientSecret":"do-not-expose","nested":{"apiKey":"hidden"}}'],
    ['token=hidden'], ['order=100 password=hidden']
  ], [{ name: 'config' }])) });
  const data = await client.query({ sql: 'select config from financial.payment_channel_config' });
  assert.deepEqual(JSON.parse(data.rows[0][0]), { channel: 'example', clientSecret: '[REDACTED]', nested: { apiKey: '[REDACTED]' } });
  assert.equal(data.rows[1][0], 'token=[REDACTED]');
  assert.equal(data.rows[2][0], 'order=100 password=[REDACTED]');
});

test('result cap and upstream truncation are explicit; no partial results on output overflow', async () => {
  const client = new MetabaseClient(config(), { fetch: datasetFetch(async () => result([[1], [2], [3]])) });
  const data = await client.query({ sql: 'select 1', limit: 2 });
  assert.deepEqual(data.rows, [[1], [2]]);
  assert.equal(data.truncated, true);
  const large = new MetabaseClient(config(), { fetch: datasetFetch(async () => result([['x'.repeat(300_000)]])) });
  assert.equal((await large.query({ sql: 'select 1' })).error_code, 'RESULT_TOO_LARGE');
});

test('deadline aborts requests; concurrent calls are rejected instead of piling up', async () => {
  const client = new MetabaseClient(config(), { timeoutMs: 20, fetch: async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const pending = client.query({ sql: 'select 1' });
  assert.equal((await client.query({ sql: 'select 1' })).error_code, 'BUSY');
  assert.equal((await pending).error_code, 'TIMEOUT');
});

test('stdio initialization, discovery, validation and tool invocation use MCP JSON-RPC', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const client = new MetabaseClient(config(), { fetch: datasetFetch(async () => result()) });
  serve(client, input, output);
  const send = (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  send(1, 'initialize', { protocolVersion: '2025-03-26' });
  send(2, 'tools/list');
  send(3, 'tools/call', { name: 'metabase_query', arguments: { sql: 'delete from orders' } });
  send(4, 'tools/call', { name: 'metabase_query', arguments: { sql: 'select 1' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  send(5, 'tools/call', { name: 'metabase_databases', arguments: {} });
  await new Promise(resolve => setTimeout(resolve, 10));
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies.find(value => value.id === 1).result.protocolVersion, '2025-03-26');
  assert.equal(replies.find(value => value.id === 2).result.tools[0].annotations.readOnlyHint, true);
  assert.equal(replies.find(value => value.id === 3).result.isError, true);
  assert.equal(replies.find(value => value.id === 4).result.isError, false);
  assert.deepEqual(replies.find(value => value.id === 2).result.tools.map(tool => tool.name),
    ['metabase_query', 'metabase_databases']);
  const catalog = JSON.parse(replies.find(value => value.id === 5).result.content[0].text);
  assert.equal(catalog.cached, true);
  assert.equal(text.includes('private-session'), false);
  input.end();
});


test('database discovery is cached, expires and supports explicit refresh without leaking details', async () => {
  let now = 0;
  let calls = 0;
  const client = new MetabaseClient(config(), { now: () => now, fetch: async () => {
    calls++;
    return Response.json({ data: [{ id: 1, name: 'Production', engine: 'mysql', details: { password: 'hidden' } }] });
  } });
  const first = await client.databases({});
  assert.equal(first.cached, false);
  assert.deepEqual(first.databases, [{ id: 1, name: 'Production', engine: 'mysql' }]);
  assert.equal((await client.databases({})).cached, true);
  assert.equal(calls, 1);
  now = 300_000;
  assert.equal((await client.databases({})).cached, false);
  await client.databases({ refresh: true });
  assert.equal(calls, 3);
  assert.throws(() => client.databases({ refresh: 'yes' }));
});

test('queries resolve discovered names or IDs and never guess among multiple databases', async () => {
  const sent = [];
  const client = new MetabaseClient(config(), { fetch: async (url, options) => {
    if (url.pathname.endsWith('/database')) {
      return Response.json([{ id: 1, name: 'First' }, { id: 2, name: 'Second' }, { id: 3, name: 'Duplicate' },
        { id: 4, name: 'Duplicate' }]);
    }
    sent.push(JSON.parse(options.body).database);
    return result();
  } });
  assert.equal((await client.query({ sql: 'select 1' })).error_code, 'DATABASE_REQUIRED');
  assert.equal((await client.query({ sql: 'select 1', database: 'Second' })).status, 'ok');
  assert.equal((await client.query({ sql: 'select 1', database: 1 })).status, 'ok');
  assert.equal((await client.query({ sql: 'select 1', database: 999 })).error_code, 'DATABASE_NOT_FOUND');
  assert.equal((await client.query({ sql: 'select 1', database: 'Duplicate' })).error_code, 'DATABASE_AMBIGUOUS');
  assert.deepEqual(sent, [2, 1]);
});

test('empty or malformed catalogs fail; refresh failure and permission loss invalidate cache', async () => {
  for (const [body, code] of [[[], 'NO_DATABASES'], [{ data: [{}] }, 'INVALID_RESPONSE']]) {
    const client = new MetabaseClient(config(), { fetch: async () => Response.json(body) });
    assert.equal((await client.query({ sql: 'select 1' })).error_code, code);
  }
  let requests = 0;
  const client = new MetabaseClient(config(), { fetch: async () => {
    requests++;
    return requests === 1 ? Response.json([{ id: 1, name: 'Only' }]) : new Response(null, { status: 403 });
  } });
  await client.databases({});
  assert.equal((await client.query({ sql: 'select 1' })).error_code, 'ACCESS_DENIED');
  assert.equal((await client.databases({})).error_code, 'ACCESS_DENIED');
  assert.equal(requests, 3);
  let fail = false;
  let reads = 0;
  const refreshed = new MetabaseClient(config(), { fetch: async () => {
    reads++;
    return fail ? new Response(null, { status: 500 }) : Response.json([{ id: 1, name: 'Only' }]);
  } });
  await refreshed.databases({});
  fail = true;
  assert.equal((await refreshed.databases({ refresh: true })).error_code, 'UPSTREAM_ERROR');
  assert.equal((await refreshed.databases({})).error_code, 'UPSTREAM_ERROR');
  assert.equal(reads, 3);
});
