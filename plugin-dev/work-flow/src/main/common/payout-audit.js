import { countryPage, financialPage, runContext, callbackTimeoutHours } from './payout-queries.js';

export function rowsOf(result) {
  if (result.status !== 'ok' || !Array.isArray(result.rows) || !Array.isArray(result.columns)
    || typeof result.truncated !== 'boolean') {
    throw Error(`Metabase 查询失败：${result.error_code || 'INVALID_RESULT'} ${result.message || ''}`);
  }
  if (result.rows.some(row => !Array.isArray(row) || row.length !== result.columns.length)) {
    throw Error('Metabase 结果列与数据不一致');
  }
  return result.rows.map(row => Object.fromEntries(result.columns.map((column, i) => [column.name, row[i]])));
}

// A full page is never a complete result; IDs remain strings throughout keyset pagination.
async function pages(query, makeQuery, idField, visit, signal) {
  let cursor = '0';
  while (true) {
    signal?.throwIfAborted();
    const result = await query(makeQuery(cursor));
    signal?.throwIfAborted();
    const rows = rowsOf(result);
    if (!rows.length) {
      if (result.truncated) {
        throw Error('查询截断且没有可用分页游标');
      }
      return;
    }
    for (const row of rows) {
      const next = row[idField];
      if (typeof next !== 'string' || !/^\d{1,20}$/.test(next) || BigInt(next) <= BigInt(cursor)) {
        throw Error('分页 ID 缺失、精度丢失或没有递增');
      }
      cursor = next;
      visit(row);
    }
    if (rows.length < 100 && !result.truncated) {
      return;
    }
  }
}

function groupsOf(events) {
  const groups = new Map();
  for (const event of events) {
    if (typeof event.application_id !== 'string' || !/^\d{1,20}$/.test(event.application_id)
      || typeof event.country_code !== 'string' || !Number.isSafeInteger(event.channel_id)
      || typeof event.create_time !== 'string' || typeof event.channel_code !== 'string') {
      throw Error('财务候选缺少申请单、国家、时间或有效渠道ID');
    }
    const key = `${event.country_code}:${event.channel_id}`;
    if (!groups.has(key)) {
      groups.set(key, { country: event.country_code, channelId: String(event.channel_id), applications: new Map() });
    }
    const applications = groups.get(key).applications;
    if (!applications.has(event.application_id)) {
      applications.set(event.application_id, []);
    }
    applications.get(event.application_id).push(event);
  }
  return [...groups.values()];
}

function mergePayment(records, group, payment) {
  const events = group.applications.get(payment.application_id);
  if (!events || String(payment.channel_id) !== group.channelId || payment.payment_status !== 2
    || typeof payment.loan_order_id !== 'string' || !Object.hasOwn(payment, 'channel_order_no') || !Object.hasOwn(payment, 'application_time')) {
    throw Error('旧系统复核结果与申请单、渠道或 status=2 不符');
  }
  for (const event of events) {
    const key = `${group.country}:${payment.application_id}:${event.channel_code}:${group.channelId}:${payment.payment_record_id}`;
    if (!records.has(key)) {
      records.set(key, { ...event, ...payment, event_record_ids: [] });
    }
    const record = records.get(key);
    record.create_time = record.create_time < event.create_time ? record.create_time : event.create_time;
    record.event_record_ids.push(event.event_record_id);
  }
}

function tracedReader(query, audit, { signal, onPage = () => {} }) {
  return async payload => {
    signal?.throwIfAborted();
    const result = await query(payload);
    audit.queries.push({ database: payload.database, requestId: result.request_id || '', rowCount: result.rows?.length || 0 });
    onPage({ database: payload.database, queryCount: audit.queries.length, rowCount: result.rows?.length || 0 });
    return result;
  };
}

// The batch node exposes routing without duplicating all financial events in the run history.
export function payoutBatches(events) {
  return groupsOf(events).map(group => ({ country: group.country, channelId: group.channelId,
    applicationIds: [...group.applications.keys()] }));
}

export async function collectFinancialCandidates(query, { signal, onPage, context, timeoutHours = 6 } = {}) {
  const audit = { complete: true, asOf: '', timeoutHours: callbackTimeoutHours(timeoutHours), candidateEvents: 0, records: [], failures: [], queries: [], events: [] };
  const read = tracedReader(query, audit, { signal, onPage });
  try {
    if (!context) {
      const result = await read(runContext());
      [context] = rowsOf(result);
      if (!context || result.truncated) {
        throw Error('财务时间及最大ID查询结果不完整');
      }
    }
    audit.asOf = context.as_of;
    await pages(read, cursor => financialPage({ asOf: audit.asOf, highWater: context.high_water, cursor, timeoutHours: audit.timeoutHours }),
      'event_record_id', row => audit.events.push(row), signal);
    groupsOf(audit.events);
  } catch (error) {
    signal?.throwIfAborted();
    audit.complete = false;
    audit.failures.push(`财务查询：${error.message}`);
  }
  audit.candidateEvents = audit.events.length;
  return audit;
}

// Query failures retain an explicitly incomplete report; they never mean zero pending orders.
export async function reviewPayoutCandidates(query, financial, { signal, onPage, groups = payoutBatches(financial.events) } = {}) {
  const { events, ...source } = financial;
  const audit = { ...source, failures: [...source.failures], queries: [...source.queries], records: [], countryResults: [] };
  if (!audit.complete) {
    return audit;
  }
  if (JSON.stringify(groups) !== JSON.stringify(payoutBatches(events))) {
    throw Error('国家渠道批次与财务候选不一致，不能漏查或混入其他申请单');
  }
  const read = tracedReader(query, audit, { signal, onPage });
  const records = new Map();
  for (const group of groupsOf(events)) {
    const ids = [...group.applications.keys()];
    const before = records.size;
    const queriesBefore = audit.queries.length;
    const result = { country: group.country, channelId: group.channelId, applicationCount: ids.length,
      batchCount: Math.ceil(ids.length / 100), complete: true };
    try {
      for (let start = 0; start < ids.length; start += 100) {
        await pages(read, cursor => countryPage({ country: group.country, channelId: group.channelId,
          applicationIds: ids.slice(start, start + 100), cursor }), 'payment_record_id',
        payment => mergePayment(records, group, payment), signal);
      }
    } catch (error) {
      signal?.throwIfAborted();
      audit.complete = false;
      result.complete = false;
      result.error = error.message;
      audit.failures.push(`${group.country} / proxy_id=${group.channelId}：${error.message}`);
    }
    audit.countryResults.push({ ...result, matchedRecords: records.size - before, queryCount: audit.queries.length - queriesBefore });
  }
  audit.records = [...records.values()];
  return audit;
}

// Retain the original combined node for workflows already using payout.audit.
export async function collectPayoutAudit(query, options = {}) {
  const financial = await collectFinancialCandidates(query, options);
  if (!financial.complete) {
    const { events, ...audit } = financial;
    return audit;
  }
  return reviewPayoutCandidates(query, financial, options);
}
