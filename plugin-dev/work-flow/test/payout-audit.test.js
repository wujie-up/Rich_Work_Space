import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPayoutAudit } from '../src/main/common/payout-audit.js';
import { groupPayoutRecords, payoutReport, savePayoutReport } from '../src/main/common/payout-report.js';

const response = rows => ({ status: 'ok', columns: Object.keys(rows[0] || {}).map(name => ({ name })),
  rows: rows.map(row => Object.values(row)), truncated: rows.length === 100 });
const event = (id, country = 'AR') => ({ event_record_id: String(id), application_id: '9007199254740993',
  country_code: country, create_time: '2026-10-20 01:00:00', channel_name: '渠道 A', channel_id: 20, channel_code: 'PAY0028' });
const payment = { application_id: '9007199254740993', loan_order_id: '203958', payment_record_id: '203879',
  channel_id: 20, payment_status: 2, merchant_no: 'merchant-identifier', channel_order_no: 'P038lpandaPayOutl495076l161600|<secret>',
  application_time: '2026-10-19 20:00:00', payment_create_time: '2026-10-20 01:00:00' };

function queryFor({ financial = [event(1)], countryError = false } = {}) {
  const calls = [];
  const query = async payload => {
    calls.push(payload);
    if (payload.sql.includes('MAX(id)')) {
      return response([{ as_of: '2026-11-03 10:00:00', high_water: '10000' }]);
    }
    if (payload.database === 'treasury') {
      const cursor = BigInt(payload.sql.match(/e\.id > (\d+)/)[1]);
      return response(financial.filter(row => BigInt(row.event_record_id) > cursor).slice(0, 100));
    }
    if (countryError) {
      return { status: 'error', error_code: 'TIMEOUT', message: 'query timed out' };
    }
    return response([payment]);
  };
  return { query, calls };
}

test('walks every financial page, deduplicates calls per payment and preserves string IDs', async () => {
  const { query, calls } = queryFor({ financial: Array.from({ length: 101 }, (_, i) => event(i + 1)) });
  const result = await collectPayoutAudit(query);
  assert.equal(result.complete, true);
  assert.equal(result.candidateEvents, 101);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].application_id, '9007199254740993');
  assert.equal(result.records[0].event_record_ids.length, 101);
  assert.equal(calls.filter(call => call.database === 'treasury').length, 3);
  assert.equal(calls.filter(call => call.database === '阿根廷').length, 1);
});

test('query failures, unknown countries and non-advancing pages cannot become empty successful reports', async () => {
  assert.equal((await collectPayoutAudit(queryFor({ countryError: true }).query)).complete, false);
  const unknown = await collectPayoutAudit(queryFor({ financial: [event(1, 'UNKNOWN')] }).query);
  assert.equal(unknown.complete, false);
  assert.match(unknown.failures.join(' '), /UNKNOWN/);
  const { query } = queryFor();
  const stuck = await collectPayoutAudit(async payload => payload.sql.includes('e.id >')
    ? { ...response([event(1)]), truncated: true } : query(payload));
  assert.equal(stuck.complete, false);
});

test('MD report groups one global channel across countries with different proxy IDs', () => {
  const report = payoutReport({ complete: true, asOf: '2026-11-03 10:00:00', candidateEvents: 2,
    records: [{ ...event(1, 'AR'), ...payment }, { ...event(2, 'PE'), ...payment, channel_id: 31 }], queries: [] });
  assert.deepEqual(report.match(/^## 渠道：.*$/gm), ['## 渠道：渠道 A 国家：阿根廷（AR）', '## 渠道：渠道 A 国家：秘鲁（PE）']);
  assert.doesNotMatch(report, /^### |PAY0028/m);
  assert.match(report, /\| 老系统申请单ID \| 申请时间 \| 渠道订单号 \|/);
  assert.match(report, /P038lpandaPayOutl495076l161600/);
  assert.match(report, /2026-10-19 20:00:00/);
  assert.doesNotMatch(report, /merchant-identifier|2026-10-20 01:00:00/);
  assert.doesNotMatch(report, /国家编码|渠道名称|渠道ID|旧系统订单ID|支付记录ID|查询追溯|request_id/);
  assert.match(report, /复核后明细数：2/);
});

test('missing channel order number or application time never falls back to merchant or event time', () => {
  const report = payoutReport({ complete: true, asOf: '2026-11-03 10:00:00', candidateEvents: 1,
    records: [{ ...event(1), ...payment, channel_order_no: null, application_time: null }], queries: [] });
  assert.match(report, /\| 9007199254740993 \| （空） \| （空） \|/);
  assert.doesNotMatch(report, /merchant-identifier|2026-10-20 01:00:00/);
});

test('report grouping sorts by application time rather than payout event time', () => {
  const records = [
    { ...event(1), ...payment, application_id: '1', application_time: '2026-10-19 21:00:00', create_time: '2026-10-20 01:00:00' },
    { ...event(2), ...payment, application_id: '2', application_time: '2026-10-19 20:00:00', create_time: '2026-10-20 02:00:00' }
  ];
  assert.deepEqual(groupPayoutRecords(records)[0].countries[0].records.map(row => row.application_id), ['2', '1']);
});

test('MD report groups channel then country, escapes cells and never overwrites reports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'payout-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await collectPayoutAudit(queryFor().query);
  const now = Date.parse('2026-11-03T02:00:00Z');
  const first = await savePayoutReport(result, { directory, now, runId: 'test-run' });
  const second = await savePayoutReport(result, { directory, now, runId: 'test-run' });
  assert.notEqual(first, second);
  assert.match(first, /20261103-100000/);
  const report = await readFile(first, 'utf8');
  assert.match(report, /## 渠道：渠道 A 国家：阿根廷（AR）/);
  assert.match(report, /9007199254740993/);
  assert.doesNotMatch(report, /<secret>/);
  const partial = await savePayoutReport({ ...result, complete: false, failures: ['failed country'] }, { directory, now, runId: 'partial' });
  assert.match(partial, /未完成/);
  assert.match(await readFile(partial, 'utf8'), /不完整/);
});

test('country batches cover more than 100 applications and full payment pages without omissions', async () => {
  const financial = Array.from({ length: 101 }, (_, i) => ({ ...event(i + 1), application_id: String(9007199254740993n + BigInt(i)) }));
  const base = queryFor({ financial });
  const countryCalls = [];
  const result = await collectPayoutAudit(async payload => {
    if (payload.database === 'treasury') {
      return base.query(payload);
    }
    countryCalls.push(payload);
    const applications = payload.sql.match(/IN \(([^)]+)\)/)[1].split(',');
    assert.ok(applications.length <= 100);
    const cursor = BigInt(payload.sql.match(/p\.id > (\d+)/)[1]);
    return response(applications.map(application_id => ({ ...payment, application_id, payment_record_id: application_id }))
      .filter(row => BigInt(row.payment_record_id) > cursor));
  });
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 101);
  assert.equal(countryCalls.length, 3);
  assert.equal(result.countryResults[0].batchCount, 2);
});


test('configured timeout reaches every financial page and the report description', async () => {
  const {query,calls} = queryFor({ financial: Array.from({ length: 101 }, (_, i) => event(i + 1)) });
  const result = await collectPayoutAudit(query, { timeoutHours: 12 });
  assert.equal(result.timeoutHours, 12);
  assert.ok(calls.filter(call => call.sql.includes('e.id >')).every(call => call.sql.includes('INTERVAL 12 HOUR')));
  const report = payoutReport(result);
  assert.match(report, /超过 12 小时/);
  assert.match(report, /渠道订单号/);
  assert.doesNotMatch(report, /merchant_no/);
});
