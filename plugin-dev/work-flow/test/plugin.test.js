import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';

const PLUGIN_ID = 'work-flow';
const METHOD_NAME = /^[a-z][a-zA-Z0-9.]+$/;

function fakeContext(storage, services) {
  const methods = new Map();
  const views = [];
  const events = [];
  const contracts = [];
  let lifecycle = null;
  const invocations = new Map();
  return { context: { pluginId: PLUGIN_ID, storage, emit: (channel, value) => events.push({ channel, value }),
    importModule: name => import(name), ownProcesses: () => {}, resources: { report: () => {} },
    services: { register: entry => contracts.push(entry), discover: async contract => services.discover(contract),
      invoke: async (provider, input, options) => services.invoke(provider, input, options) },
    capabilities: {
      discover: async () => ({ providers: (await services.discover()).flatMap(provider =>
        ['agent.task.start.v1', 'agent.task.read.v1', 'agent.task.cancel.v1'].map(id => ({ state: 'ready',
          descriptor: { id, title: 'Agent 任务' }, handle: { pluginId: provider.pluginId, capabilityId: id } }))) }),
      invoke: async (handle, input) => {
        const invocationId = String(invocations.size + 1);
        const result = handle.capabilityId === 'agent.task.start.v1'
          ? await services.invoke(handle, input) : { state: 'succeeded', output: '根因：连接池耗尽' };
        invocations.set(invocationId, { state: 'succeeded', result });
        return { invocationId };
      },
      getInvocation: async id => invocations.get(id),
      cancel: async () => {}
    },
    methods: { register: (name, handler, options = {}) => methods.set(name, { handler, options }) },
    lifecycle: { register: value => { lifecycle = value; } },
    views: { register: view => views.push(view) } },
  api: { methods, views, events, contracts, lifecycle: () => lifecycle } };
}

// The open view is the caller that resumes a paused service node; this stands in for it.
async function settle(methods, runId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = await methods.get('runs.get').handler(runId);
    if (run.status === 'waiting') {
      await methods.get('runs.resume').handler(runId);
      continue;
    }
    if (run.status !== 'running') {
      return run;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('等待运行结束超时');
}

test('插件入口注册方法、视图与生命周期，并能完整跑通一次排查流程', async t => {
  const storage = await temporaryStore(t);
  const invoked = [];
  const services = { discover: async () => [{ pluginId: 'ai-agent-sessions', contract: 'agent.task.start.v1', method: 'agent.run' }],
    invoke: async (provider, input) => { invoked.push(input); return { state: 'running' }; } };
  const { context, api } = fakeContext(storage, services);
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  for (const name of api.methods.keys()) {
    assert.match(name, METHOD_NAME);
  }
  assert.equal(api.views.length, 1);
  assert.equal(api.views[0].entry, 'dist/renderer/index.html');
  const types = await api.methods.get('nodes.types').handler();
  assert.ok(types.some(type => type.type === 'agent.review'));
  const agentInfo = await api.methods.get('agents.providers').handler();
  assert.equal(agentInfo.contract, 'agent.task.start.v1');
  assert.equal(agentInfo.providers.length, 1);
  const credentialId = await api.methods.get('credentials.save').handler({ name: '邮箱', host: 'imap.example.com', port: 993,
    security: 'tls', username: 'ops', password: 'secret' });
  const workflow = await api.methods.get('workflows.save').handler({ name: '邮件报错排查', nodes: [
    { id: 'source', type: 'text.input', title: '输入', x: 0, y: 0, params: { content: 'ERROR 连接池耗尽' } },
    { id: 'gate', type: 'flow.gate', title: '存在错误', x: 1, y: 0, params: { input: '{{source.text}}' } },
    { id: 'review', type: 'agent.review', title: 'Agent 排查', x: 2, y: 0, params: { input: '{{source.text}}' } },
    { id: 'collect', type: 'result.collect', title: '汇总', x: 3, y: 0, params: {} }],
  edges: [{ from: 'source', to: 'gate' }, { from: 'gate', to: 'review' }, { from: 'review', to: 'collect' }] });
  assert.equal(credentialId.length > 0, true);
  const started = await api.methods.get('runs.start').handler(workflow.id);
  const run = await settle(api.methods, started.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.review.status, 'succeeded');
  assert.match(run.nodes.review.output.output, /连接池耗尽/);
  assert.equal(invoked.length, 1);
  assert.match(invoked[0].taskKey, /^[a-f0-9]{64}$/);
  assert.match(invoked[0].prompt, /ERROR 连接池耗尽/);
  assert.equal(api.events.some(event => event.channel === 'runs.changed'), true);
  const stored = await api.methods.get('runs.list').handler(workflow.id);
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes('secret'));
  await plugin.deactivate();
});

test('插件入口在没有 Agent 提供方时让排查节点明确失败', async t => {
  const storage = await temporaryStore(t);
  const { context, api } = fakeContext(storage, { discover: async () => [], invoke: async () => ({ version: 1, output: '' }) });
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  const workflow = await api.methods.get('workflows.save').handler({ name: '缺提供方', nodes: [
    { id: 'source', type: 'text.input', title: '输入', x: 0, y: 0, params: { content: 'ERROR x' } },
    { id: 'review', type: 'agent.review', title: 'Agent 排查', x: 1, y: 0, params: { input: '{{source.text}}' } }],
  edges: [{ from: 'source', to: 'review' }] });
  const started = await api.methods.get('runs.start').handler(workflow.id);
  const run = await settle(api.methods, started.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'AGENT_PROVIDER_MISSING');
  await plugin.deactivate();
});

test('生命周期快照反映等待中的任务，stop 后不再有活动任务', async t => {
  const storage = await temporaryStore(t);
  const services = { discover: async () => [{ pluginId: 'ai-agent-sessions', contract: 'agent.task.start.v1', method: 'agent.run' }],
    invoke: async () => ({ version: 1, output: 'done' }) };
  const { context, api } = fakeContext(storage, services);
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  const workflow = await api.methods.get('workflows.save').handler({ name: '等待中的任务', nodes: [
    { id: 'source', type: 'text.input', title: '输入', x: 0, y: 0, params: { content: 'ERROR x' } },
    { id: 'review', type: 'agent.review', title: 'Agent 排查', x: 1, y: 0, params: { input: '{{source.text}}' } }],
  edges: [{ from: 'source', to: 'review' }] });
  await api.methods.get('runs.start').handler(workflow.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  const lifecycle = api.lifecycle();
  assert.equal(lifecycle.snapshot().length, 1);
  await lifecycle.stop('disable');
  assert.equal(lifecycle.snapshot().length, 0);
  await plugin.deactivate();
});

test('插件发布 workflow.run.v1 契约，其他插件可由此触发运行', async t => {
  const storage = await temporaryStore(t);
  const services = { discover: async () => [], invoke: async () => ({ version: 1, output: '' }) };
  const { context, api } = fakeContext(storage, services);
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  assert.deepEqual(api.contracts, [{ contract: 'workflow.run.v1', method: 'runs.trigger' }]);
  const workflow = await api.methods.get('workflows.save').handler({ name: '外部触发',
    nodes: [{ id: 'source', type: 'text.input', title: '输入', x: 0, y: 0, params: { content: 'ERROR timeout' } }], edges: [] });
  const result = await api.methods.get('runs.trigger').handler({ version: 1, workflowId: workflow.id });
  assert.equal(result.version, 1);
  const run = await settle(api.methods, result.runId);
  assert.equal(run.status, 'succeeded', '手动模式同样可被外部契约触发');
  await assert.rejects(api.methods.get('runs.trigger').handler({ version: 2, workflowId: workflow.id }),
    { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.methods.get('runs.trigger').handler({ version: 1 }), { code: 'INVALID_ARGUMENT' });
});

test('工作流运行中再次触发会被拒绝，不会产生并发运行', async t => {
  const storage = await temporaryStore(t);
  const services = { discover: async () => [], invoke: async () => ({ version: 1, output: '' }) };
  const { context, api } = fakeContext(storage, services);
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const workflow = await api.methods.get('workflows.save').handler({ name: '外部触发',
    nodes: [{ id: 'source', type: 'text.input', title: '输入', x: 0, y: 0, params: { content: 'ERROR timeout' } }], edges: [] });
  await api.methods.get('runs.trigger').handler({ version: 1, workflowId: workflow.id });
  await assert.rejects(api.methods.get('runs.trigger').handler({ version: 1, workflowId: workflow.id }),
    { code: 'RUN_BUSY' });
  await assert.rejects(api.methods.get('runs.start').handler(workflow.id), { code: 'RUN_BUSY' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const again = await api.methods.get('runs.trigger').handler({ version: 1, workflowId: workflow.id });
  assert.equal(again.version, 1, '上一轮结束后可以继续触发');
  assert.equal((await settle(api.methods, again.runId)).status, 'succeeded');
});

test('启用固定周期后插件会自动触发，停用后停止', async t => {
  const storage = await temporaryStore(t);
  const services = { discover: async () => [], invoke: async () => ({ version: 1, output: '' }) };
  const { context, api } = fakeContext(storage, services);
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const options = await api.methods.get('triggers.options').handler();
  assert.deepEqual(options.modes, ['manual', 'once', 'interval', 'message']);
  assert.deepEqual(options.units, ['second', 'minute', 'hour', 'day', 'month', 'year']);
  const workflow = await api.methods.get('workflows.save').handler({ name: '每 5 分钟巡检',
    nodes: [{ id: 'source', type: 'text.input', title: '输入', x: 0, y: 0, params: { content: 'ERROR timeout' } }], edges: [],
    trigger: { mode: 'interval', every: 1, unit: 'second', enabled: true } });
  const planned = await api.methods.get('triggers.next').handler();
  assert.ok(planned.find(item => item.workflowId === workflow.id).nextAt > Date.now());
  await new Promise(resolve => setTimeout(resolve, 2400));
  assert.ok((await api.methods.get('runs.list').handler(workflow.id)).length >= 1, '应自动跑出历史');
  await api.methods.get('workflows.save').handler({ ...workflow, trigger: { mode: 'manual', enabled: false } });
  assert.equal((await api.methods.get('triggers.next').handler()).find(item => item.workflowId === workflow.id).nextAt, null);
});
