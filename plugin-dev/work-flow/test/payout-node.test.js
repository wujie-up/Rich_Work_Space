import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payoutAuditType } from '../src/main/common/payout-node.js';
import { createRegistry } from '../src/main/common/nodes.js';
import { Workflows } from '../src/main/common/workflows.js';
import { WorkflowTransfer } from '../src/main/common/workflow-transfer.js';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { Runs } from '../src/main/common/runs.js';
import { Engine } from '../src/main/common/engine.js';
import { Capabilities } from '../../../desk/src/main/common/capabilities.js';
import { TaskClient } from '../src/main/common/task-client.js';

function fakeTasks(state = 'granted', queryOverride) {
  const calls = [];
  const revoked = [];
  const authorizations = [];
  const providers = [['call', ['mcp.tool']], ['describe', ['network.read']]].map(([id, effects]) => ({
    state: 'ready', handle: { pluginId: 'mcp-services', capabilityId: id },
    descriptor: { id, title: 'matabase-mcp', effects, source: { serviceId: 'matabase-mcp' } }
  }));
  return { calls, revoked, authorizations, capabilities: {
    discover: async () => ({ providers }), authorize: async input => {
      authorizations.push(input);
      return { id: 'lease' };
    },
    authorization: async () => ({ state }), revoke: async id => revoked.push(id)
  }, call: async (id, input, options) => {
    calls.push({ id, input, options });
    if (id === 'describe') {
      return { tools: [{ name: 'metabase_query' }, { name: 'metabase_databases' }] };
    }
    const data = queryOverride && input.name === 'metabase_query' ? await queryOverride(input.arguments)
      : input.name === 'metabase_databases' ? { status: 'ok', databases: [{ name: 'treasury' }, { name: '阿根廷' }, { name: '哥伦比亚' }] }
      : input.arguments.sql.includes('MAX(id)') ? { status: 'ok', columns: [{ name: 'as_of' }, { name: 'high_water' }],
        rows: [['2026-11-03 10:00:00', '123']], truncated: false }
        : { status: 'ok', columns: [], rows: [], truncated: false };
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } };
}

test('native node uses the existing MCP lease and writes only a timestamped MD summary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'payout-node-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = fakeTasks();
  const node = payoutAuditType({ tasks, logger: () => {} });
  const output = await node.resolve({ params: { reportDirectory: directory, serviceId: '' },
    runId: 'run-test', nodeId: 'payout', shouldStop: () => false });
  assert.equal(output.complete, true);
  assert.match(output.path, /\.md$/);
  assert.match(await readFile(output.path, 'utf8'), /本轮未发现/);
  assert.ok(tasks.calls.every(call => call.options.authorizationId === 'lease'));
  assert.equal(tasks.authorizations[0].approval, 'automatic');
  assert.deepEqual(tasks.revoked, ['lease']);
  assert.equal(tasks.calls.some(call => call.input.name?.includes('agent')), false);
});

test('first payout run completes through host authorization and invocation without any user message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'payout-authorization-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = fakeTasks();
  const consumer = { id: 'work-flow', instanceId: 'workflow-one', services: [], notifyCapability() {} };
  const provider = { id: 'mcp-services', instanceId: 'mcp-one', services: [], notifyCapability() {},
    executeCapability: (input, context) => fixture.call(context.capabilityId, input, {}) };
  const storage = new Storage(join(directory, 'host'));
  const host = new Capabilities({ storage, loaded: new Map([[consumer.id, consumer], [provider.id, provider]]), usable: () => true });
  await host.load();
  for (const entry of (await fixture.capabilities.discover()).providers) {
    await host.register(provider, { ...entry.descriptor, version: 1, description: 'Isolated Metabase fixture',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, confirmation: 'always',
      execution: { timeoutMs: 2000, cancellable: true, retry: 'never' } });
  }
  const tasks = new TaskClient({
    discover: () => host.discover(), authorize: input => host.authorizations.request(consumer, input),
    authorization: id => host.authorizations.get(consumer, id), revoke: id => host.authorizations.revoke(consumer, id),
    invoke: (handle, input, options) => host.invoke(consumer, handle, input, options),
    getInvocation: id => host.get(consumer, id), cancel: id => host.cancel(consumer, id)
  });
  const node = payoutAuditType({ tasks, logger: () => {} });
  const output = await node.resolve({ params: { reportDirectory: join(directory, 'reports') },
    runId: 'run-first', nodeId: 'payout', shouldStop: () => false });
  await host.flush();
  assert.equal(output.complete, true);
  assert.match(await readFile(output.path, 'utf8'), /本轮未发现/);
  assert.equal(host.messages.list().length, 0);
  assert.ok([...host.invocations.values()].every(task => task.record.state === 'succeeded' && !task.record.approvalRequired));
  assert.ok([...host.authorizations.leases.values()].every(lease => lease.state === 'revoked'));
  assert.deepEqual(await storage.readJson('capability-consents.json', {}), {});
});

test('denied authorization or cancellation cannot become a successful empty report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'payout-denied-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = fakeTasks('denied');
  const node = payoutAuditType({ tasks, logger: () => {} });
  await assert.rejects(node.resolve({ params: { reportDirectory: directory }, runId: 'r', nodeId: 'n', shouldStop: () => false }));
  assert.deepEqual(await readdir(directory), []);
  assert.equal(tasks.calls.length, 0);
  assert.deepEqual(tasks.revoked, ['lease']);
  await assert.rejects(node.resolve({ params: { reportDirectory: directory }, runId: 'r', nodeId: 'n', shouldStop: () => true }));
  assert.deepEqual(await readdir(directory), []);
});

test('shipped workflow imports safely and executes through the real workflow engine', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'payout-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = fakeTasks();
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ code: 0 }) };
  });
  const robots = { snapshot: async () => ({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture', key: 'fixture-key' }) };
  const registry = createRegistry({ credentials: {}, tasks, robots, logger: () => {} });
  const storage = new Storage(directory);
  const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: id => registry.get(id) });
  const transfer = new WorkflowTransfer({ workflows, types: () => registry.list(), activeRun: () => false, logger: () => {} });
  const document = JSON.parse(await readFile(new URL('../../../docs/workflows/payout-callback-audit/payout-callback-audit.workflow.json', import.meta.url), 'utf8'));
  const configured = transfer.definition(document.workflow).workflow;
  assert.deepEqual(configured.trigger, { mode: 'daily', at: '10:00', timezone: 'Asia/Shanghai', enabled: true });
  const { workflow } = await transfer.import({ document });
  assert.equal(workflow.trigger.mode, 'manual', 'portable imports must not silently enable schedules');
  assert.deepEqual(workflow.nodes.map(node => node.type), ['flow.start', 'payout.snapshot', 'payout.financial', 'payout.batch',
    'payout.verify', 'payout.group', 'payout.markdown', 'output.feishu']);
  workflow.nodes.find(node => node.id === 'snapshot').params.reportDirectory = directory;
  const runs = new Runs({ storage, pluginId: 'work-flow' });
  const engine = new Engine({ registry, runs, credentials: {}, agents: { release: async () => [] },
    logger: () => {}, emit: () => {}, pluginId: 'work-flow' });
  t.after(() => engine.stop('test'));
  const started = await engine.start(workflow);
  let run;
  for (let attempt = 0; attempt < 100; attempt++) {
    run = await engine.get(started.id);
    if (run.status !== 'running') {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(run.status, 'succeeded');
  assert.match(run.nodes.markdown.output.path, /\.md$/);
  assert.match(await readFile(run.nodes.markdown.output.path, 'utf8'), /本轮未发现/);
  assert.equal(run.nodes.notify.output.delivered, true);
  assert.match(JSON.stringify(sent[0].card), /本轮未发现/);
});

const response = rows => ({ status: 'ok', columns: Object.keys(rows[0] || {}).map(name => ({ name })),
  rows: rows.map(row => Object.values(row)), truncated: rows.length === 100 });

async function executeStages(t, query, timeoutHours = 6) {
  const directory = await mkdtemp(join(tmpdir(), 'payout-stages-'));
  const tasks = fakeTasks('granted', query);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ code: 0 }) };
  });
  const robots = { snapshot: async () => ({ webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture', key: 'fixture-key' }) };
  const registry = createRegistry({ credentials: {}, tasks, robots, logger: () => {} });
  const storage = new Storage(directory);
  const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: id => registry.get(id) });
  const transfer = new WorkflowTransfer({ workflows, types: () => registry.list(), activeRun: () => false, logger: () => {} });
  const document = JSON.parse(await readFile(new URL('../../../docs/workflows/payout-callback-audit/payout-callback-audit.workflow.json', import.meta.url), 'utf8'));
  const { workflow } = await transfer.import({ document });
  workflow.nodes.find(node => node.id === 'snapshot').params.reportDirectory = directory;
  workflow.nodes.find(node => node.id === 'financial').params.timeoutHours = timeoutHours;
  const runs = new Runs({ storage, pluginId: 'work-flow' });
  const engine = new Engine({ registry, runs, credentials: {}, agents: { release: async () => [] },
    logger: () => {}, emit: () => {}, pluginId: 'work-flow' });
  t.after(async () => {
    await engine.stop('test');
    await runs.list(workflow.id);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  const started = await engine.start(workflow);
  let run;
  for (let attempt = 0; attempt < 200; attempt++) {
    run = await engine.get(started.id);
    if (run.status !== 'running') {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { run, sent, tasks, directory };
}

const candidate = (id, country = 'AR', channelId = 20) => ({ event_record_id: String(id), application_id: '9007199254740993',
  country_code: country, create_time: '2026-10-20 01:00:00', channel_name: '渠道 A', channel_id: channelId, channel_code: 'PAY0028' });

function stageQuery(events, failedCountry = '') {
  return async payload => {
    if (payload.sql.includes('MAX(id)')) {
      return response([{ as_of: '2026-11-03 10:00:00', high_water: '1000' }]);
    }
    if (payload.database === 'treasury') {
      const cursor = BigInt(payload.sql.match(/e\.id > (\d+)/)[1]);
      return response(events.filter(row => BigInt(row.event_record_id) > cursor).slice(0, 100));
    }
    if (payload.database === failedCountry) {
      return { status: 'error', error_code: 'TIMEOUT', message: 'fixture timeout' };
    }
    const channelId = payload.database === '阿根廷' ? 20 : 31;
    return response([{ application_id: '9007199254740993', loan_order_id: '203958', payment_record_id: String(channelId),
      channel_id: channelId, payment_status: 2, merchant_no: 'fixture-merchant-' + channelId,
      channel_order_no: 'fixture-channel-order-' + channelId, application_time: '2026-10-19 20:00:00' }]);
  };
}

test('visible business stages retain paged candidates, country batches, verified channel orders and grouped report', async t => {
  const events = [...Array.from({ length: 100 }, (_, i) => candidate(i + 1)), candidate(101, 'CO', 31)];
  const { run, sent, tasks } = await executeStages(t, stageQuery(events));
  assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
  assert.equal(run.nodes.financial.output.candidateEvents, 101);
  assert.equal(run.nodes.financial.output.events.length, 101);
  assert.equal(run.nodes.batch.output.groups.length, 2);
  assert.equal(run.nodes.batch.output.batchCount, 2);
  assert.equal(run.nodes.verify.output.records.length, 2);
  assert.deepEqual(run.nodes.verify.output.countryResults.map(row => row.matchedRecords), [1, 1]);
  assert.equal(run.nodes.verify.output.records[0].event_record_ids.length, 100);
  assert.equal(run.nodes.group.output.channels.length, 1);
  assert.equal(run.nodes.group.output.channels[0].countries.length, 2);
  assert.equal(run.nodes.markdown.output.matchedRecords, 2);
  assert.equal(run.nodes.notify.output.delivered, true);
  assert.match(JSON.stringify(sent[0].card), /fixture-channel-order-20/);
  assert.match(JSON.stringify(sent[0].card), /2026-10-19 20:00:00/);
  assert.doesNotMatch(JSON.stringify(sent[0].card), /fixture-merchant-|2026-10-20 01:00:00/);
  assert.match(JSON.stringify(sent[0].card), /渠道：渠道 A 国家：哥伦比亚（CO）/);
  assert.equal(tasks.calls.some(call => call.input.name?.includes('agent')), false);
  assert.equal(tasks.calls.filter(call => call.input.arguments?.sql?.includes('e.id >')).length, 2);
  assert.equal(tasks.revoked.length, 3);
});

test('country query failure stops at verification, retains incomplete MD and never sends a misleading report', async t => {
  const { run, sent, directory } = await executeStages(t, stageQuery([candidate(1), candidate(2, 'CO', 31)], '哥伦比亚'));
  assert.equal(run.status, 'failed');
  assert.equal(run.nodes.financial.status, 'succeeded');
  assert.equal(run.nodes.verify.status, 'failed');
  assert.match(run.nodes.verify.error.message, /CO/);
  assert.equal(sent.length, 0);
  const report = (await readdir(directory)).find(name => name.endsWith('.md'));
  assert.match(report, /未完成/);
  assert.match(await readFile(join(directory, report), 'utf8'), /不完整/);
});


test('financial node parameter controls SQL, persisted results and final Feishu table headings', async t => {
  const { run, tasks, sent } = await executeStages(t, stageQuery([candidate(1)]), 12);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.financial.output.timeoutHours, 12);
  assert.equal(run.nodes.verify.output.timeoutHours, 12);
  assert.ok(tasks.calls.filter(call => call.input.arguments?.sql?.includes('e.id >'))
    .every(call => call.input.arguments.sql.includes('INTERVAL 12 HOUR')));
  const report = await readFile(run.nodes.markdown.output.path, 'utf8');
  assert.match(report, /超过 12 小时/);
  const table = sent[0].card.body.elements.find(element => element.tag === 'table');
  assert.deepEqual(table.columns.map(column => column.display_name), ['老系统申请单ID', '申请时间', '渠道订单号']);
});
