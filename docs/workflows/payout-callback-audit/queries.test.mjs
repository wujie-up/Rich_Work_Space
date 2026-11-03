import test from 'node:test';
import assert from 'node:assert/strict';
import { queryParameters } from '../../../plugin-dev/mcp/examples/metabase/server.mjs';
import { financialPage, countryPage, runContext } from './queries.mjs';

test('all generated queries pass the actual Metabase MCP SQL allowlist', () => {
  const page = financialPage({ asOf: '2026-11-03 10:00:00', highWater: '2106228548209950720' });
  const queries = [runContext(), page, countryPage({ country: 'AR', applicationIds: ['468416', '468420'], channelId: '20' })];
  queries.forEach(query => assert.equal(queryParameters(query).limit, query.limit));
  assert.match(page.sql, /e\.create_time < '2026-11-03 10:00:00' - INTERVAL 6 HOUR/);
  assert.doesNotMatch(page.sql, /\be\.day\b|DATE_SUB|OFFSET/);
});

test('country verification uses application ID to find loan ID, matches channel and preserves large IDs', () => {
  const query = countryPage({ country: 'MX', applicationIds: ['2106228548209950721'], channelId: '19', cursor: '9007199254740993' });
  assert.equal(query.database, '墨西哥');
  assert.match(query.sql, /FROM dbai\.loan_order_info l/);
  assert.match(query.sql, /p\.order_id = l\.id/);
  assert.match(query.sql, /l\.payment_code AS channel_order_no/);
  assert.match(query.sql, /LEFT JOIN dbai\.loan_application_info a ON a\.id = l\.application_id/);
  assert.match(query.sql, /DATE_FORMAT\(a\.application_time, '%Y-%m-%d %H:%i:%s'\) AS application_time/);
  assert.doesNotMatch(query.sql, /merchant_no/);
  assert.match(query.sql, /l\.application_id IN \(2106228548209950721\)/);
  assert.match(query.sql, /p\.proxy_id = 19/);
  assert.match(query.sql, /p\.id > 9007199254740993/);
  assert.throws(() => countryPage({ country: 'UNKNOWN', applicationIds: ['1'], channelId: '2' }));
  assert.throws(() => countryPage({ country: 'AR', applicationIds: [9007199254740992], channelId: '2' }));
  assert.throws(() => countryPage({ country: 'AR', applicationIds: ['1) OR 1=1'], channelId: '2' }));
});


test('callback timeout is configurable and rejects unsafe or invalid SQL intervals', () => {
  const input = { asOf: '2026-11-03 10:00:00', highWater: '2106228548209950720' };
  const query = financialPage({ ...input, timeoutHours: 12 });
  assert.match(query.sql, /INTERVAL 12 HOUR/);
  assert.equal(queryParameters(query).limit, 100);
  for (const timeoutHours of [0, -1, 1.5, 745, '', null, '6 HOUR OR 1=1']) {
    assert.throws(() => financialPage({ ...input, timeoutHours }), /超时/);
  }
});
