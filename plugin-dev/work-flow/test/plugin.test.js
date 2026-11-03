import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { temporaryStore } from '../../../desk/test/helpers.js';

const PLUGIN_ID = 'work-flow';
const METHOD_NAME = /^[a-z][a-zA-Z0-9.]+$/;

test('关闭定时只清除后续排期，不停止当前运行；再次开启不重复执行', async t => {
  const storage = await temporaryStore(t);
  const plugin = await import('../src/main/common/index.js');
  const { context, api } = fakeContext(storage, { discover: async () => [] });
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const invoke = (method, ...args) => api.methods.get(method).handler(...args);
  const workflow = await invoke('workflows.save', { name: '定时开关', nodes: [
    { id: 'start', type: 'flow.start', params: {} }, { id: 'human', type: 'flow.user-input', params: { prompt: '确认后继续' } },
    { id: 'end', type: 'flow.end', params: {} }], edges: [{ from: 'start', to: 'human' }, { from: 'human', to: 'end' }],
  trigger: { mode: 'interval', every: 1, unit: 'hour', enabled: true } });
  const run = await invoke('triggers.fire', workflow.id);
  const disabled = await invoke('triggers.setEnabled', { workflowId: workflow.id, enabled: false });
  assert.equal(disabled.trigger.enabled, false);
  const row = (await invoke('triggers.next')).find(row => row.workflowId === workflow.id);
  assert.equal(row.enabled, false);
  assert.equal(row.nextAt, null);
  assert.ok(['running', 'waiting'].includes((await invoke('runs.get', run.id)).status));
  await invoke('triggers.setEnabled', { workflowId: workflow.id, enabled: true });
  assert.ok((await invoke('triggers.next')).find(row => row.workflowId === workflow.id).nextAt > Date.now());
  assert.equal((await invoke('runs.list', workflow.id)).length, 1);
  assert.equal(api.methods.get('triggers.setEnabled').options.exclusive, true);
  await assert.rejects(invoke('triggers.setEnabled', { workflowId: workflow.id, enabled: 'false' }), { code: 'INVALID_ARGUMENT' });
  await plugin.deactivate();
});

test('开启定时读取最新定义，保留其他窗口修改，重复开启不重置排期也不执行', async t => {
  const storage = await temporaryStore(t);
  const plugin = await import('../src/main/common/index.js');
  const { context, api } = fakeContext(storage, { discover: async () => [] });
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const invoke = (method, ...args) => api.methods.get(method).handler(...args);
  const workflow = await invoke('workflows.save', { name: '原定义', nodes: [{ id: 'a', type: 'text.input', params: { content: '旧内容' } }],
    trigger: { mode: 'interval', every: 1, unit: 'hour', enabled: false } });
  await invoke('workflows.save', { ...workflow, name: '其他窗口修改', nodes: [{ ...workflow.nodes[0], params: { content: '新内容' } }] });
  const enabled = await invoke('triggers.enable', workflow.id);
  assert.equal(enabled.name, '其他窗口修改');
  assert.equal(enabled.nodes[0].params.content, '新内容');
  assert.equal(enabled.trigger.enabled, true);
  const due = (await invoke('triggers.next')).find(row => row.workflowId === workflow.id).nextAt;
  const repeated = await invoke('triggers.enable', workflow.id);
  assert.equal(repeated.updatedAt, enabled.updatedAt);
  assert.equal((await invoke('triggers.next')).find(row => row.workflowId === workflow.id).nextAt, due);
  assert.deepEqual(await invoke('runs.list', workflow.id), []);
  assert.equal(api.methods.get('triggers.enable').options.exclusive, true);
  await plugin.deactivate();
});

test('定时任务立即触发入口记录执行结果，重启保留未来排期', async t => {
  const storage = await temporaryStore(t);
  const services = { discover: async () => [] };
  const plugin = await import('../src/main/common/index.js');
  const first = fakeContext(storage, services);
  await plugin.activate(first.context);
  t.after(() => plugin.deactivate());
  const invoke = (method, ...args) => first.api.methods.get(method).handler(...args);
  const saved = await invoke('workflows.save', { name: '定时测试', nodes: [{ id: 'a', type: 'text.input', params: { content: 'x' } }],
    trigger: { mode: 'interval', every: 1, unit: 'hour', enabled: true } });
  const due = (await invoke('triggers.next')).find(item => item.workflowId === saved.id).nextAt;
  const started = await invoke('triggers.fire', saved.id);
  assert.equal((await settle(first.api.methods, started.id)).status, 'succeeded');
  await plugin.deactivate();
  const second = fakeContext(storage, services);
  await plugin.activate(second.context);
  const row = (await second.api.methods.get('triggers.next').handler()).find(item => item.workflowId === saved.id);
  assert.equal(row.nextAt, due);
  assert.equal(row.lastRunId, started.id);
  assert.equal(row.lastStatus, 'succeeded');
  assert.equal(row.lastSource, 'manual');
  assert.ok(row.lastStartedAt);
  assert.ok(row.lastEndedAt);
});

test('插件激活自动检测执行表，到期未执行立即补跑，结果入表且再次重启不重复', async t => {
  const storage = await temporaryStore(t);
  const plugin = await import('../src/main/common/index.js');
  const services = { discover: async () => [] };
  const first = fakeContext(storage, services);
  await plugin.activate(first.context);
  t.after(() => plugin.deactivate());
  const workflow = await first.api.methods.get('workflows.save').handler({ name: '恢复补跑',
    nodes: [{ id: 'a', type: 'text.input', params: { content: 'x' } }],
    trigger: { mode: 'interval', every: 1, unit: 'hour', enabled: true } });
  await plugin.deactivate();
  const key = 'plugin-data/work-flow/scheduled-tasks.json';
  const table = await storage.readJson(key);
  table.items.find(row => row.workflowId === workflow.id).nextAt = Date.now() - 10000;
  await storage.writeJson(key, table);
  const second = fakeContext(storage, services);
  await plugin.activate(second.context);
  const deadline = Date.now() + 3000;
  let row;
  do {
    row = (await second.api.methods.get('triggers.next').handler()).find(row => row.workflowId === workflow.id);
    if (row.lastStatus === 'succeeded') { break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(row.lastStatus, 'succeeded');
  assert.equal(row.lastSource, 'schedule');
  assert.ok(row.nextAt > Date.now());
  await plugin.deactivate();
  const third = fakeContext(storage, services);
  await plugin.activate(third.context);
  assert.equal((await third.api.methods.get('runs.list').handler(workflow.id)).length, 1);
  await plugin.deactivate();
});

test('删除工作流使正在领取的立即触发失效，不执行已删除定义', async t => {
  const storage = await temporaryStore(t);
  const plugin = await import('../src/main/common/index.js');
  const { context, api } = fakeContext(storage, { discover: async () => [] });
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const invoke = (method, ...args) => api.methods.get(method).handler(...args);
  const workflow = await invoke('workflows.save', { name: '删除竞态',
    nodes: [{ id: 'a', type: 'text.input', params: { content: 'x' } }],
    trigger: { mode: 'interval', every: 1, unit: 'hour', enabled: true } });
  let entered;
  let release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  t.after(release);
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async (key, value) => {
    await write(key, value);
    if (key.endsWith('/scheduled-tasks.json') && value.items.some(row => row.lastStatus === 'starting')) {
      entered();
      await hold;
    }
  };
  const start = invoke('triggers.fire', workflow.id);
  const outcome = start.then(result => ({ result }), error => ({ error }));
  await waiting;
  const remove = invoke('workflows.remove', workflow.id);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await remove;
  assert.equal((await outcome).error?.code, 'TRIGGER_CHANGED');
  assert.equal((await invoke('workflows.list')).some(item => item.id === workflow.id), false);
  assert.deepEqual(await invoke('runs.list', workflow.id), []);
  await plugin.deactivate();
});

test('分组重命名入口排他保存整组，兼容后续单流程保存', async t => {
  const storage = await temporaryStore(t);
  const { context, api } = fakeContext(storage, { discover: async () => [] });
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const invoke = (method, input) => api.methods.get(method).handler(input);
  const workflow = await invoke('workflows.save', { name: '阶段一', group: '七阶段', nodes: [{ id: 'a', type: 'text.input' }] });
  assert.equal(api.methods.get('workflows.renameGroup').options.exclusive, true);
  const [renamed] = await invoke('workflows.renameGroup', { group: '七阶段', name: '研发流程' });
  assert.equal(renamed.id, workflow.id);
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).group, '研发流程');
  const saved = await invoke('workflows.save', { ...renamed, name: '更新阶段一' });
  assert.equal(saved.group, '研发流程');
  const group = await invoke('workflows.createGroup', { name: '新组' });
  for (const method of ['createGroup', 'moveGroup', 'removeGroup', 'setGroupCollapsed']) {
    assert.equal(api.methods.get(`workflows.${method}`).options.exclusive, true);
  }
  await invoke('workflows.setGroupCollapsed', { id: group.id, collapsed: true });
  const moved = await invoke('workflows.moveGroup', { workflowId: saved.id, groupId: group.id });
  assert.equal(moved.groupId, group.id);
  assert.equal((await invoke('workflows.groups')).find(item => item.id === group.id).collapsed, true);
  const second = await invoke('workflows.save', { name: '阶段二', groupId: group.id, nodes: [{ id: 'b', type: 'text.input' }] });
  assert.equal(api.methods.get('workflows.reorder').options.exclusive, true);
  assert.deepEqual(await invoke('workflows.reorder', { workflowId: second.id, targetId: saved.id, position: 'after' }),
    [saved.id, second.id, 'requirements-design-review-template-v1']);
  await invoke('workflows.remove', second.id);
  await invoke('workflows.removeGroup', { id: group.id });
  const [retained] = await invoke('workflows.list');
  assert.equal(retained.id, saved.id);
  assert.equal(retained.groupId, undefined);
  assert.deepEqual(retained.nodes, saved.nodes);
  assert.deepEqual(await invoke('workflows.renameGroup', { group: '不存在的分组', name: '无成员' }), []);
});

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
      await new Promise(resolve => setTimeout(resolve, 5));
      continue;
    }
    if (run.status !== 'running') {
      return run;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('等待运行结束超时');
}

test('继续运行先结束视图调用，再在后台等待 Agent 审批', async t => {
  const storage = await temporaryStore(t);
  const calls = new AsyncLocalStorage();
  let release;
  let approvalContext;
  const approval = new Promise(resolve => { release = resolve; });
  const services = { discover: async () => [{ pluginId: 'ai-agent-sessions' }], invoke: async () => {
    approvalContext = calls.getStore()?.completed;
    await approval;
    return { state: 'running' };
  } };
  const { context, api } = fakeContext(storage, services);
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(async () => { release(); await plugin.deactivate(); });
  const workflow = await api.methods.get('workflows.save').handler({ name: '长审批', nodes: [
    { id: 'source', type: 'text.input', title: '输入', x: 0, y: 0, params: { content: '检查测试项目' } },
    { id: 'review', type: 'agent.review', title: '审批', x: 200, y: 0, params: { input: '{{source.text}}' } }
  ], edges: [{ from: 'source', to: 'review' }] });
  const started = await api.methods.get('runs.start').handler(workflow.id);
  while (api.methods.get('runs.get').handler(started.id).status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await api.methods.get('runs.activity').handler())[0].id, started.id);
  const rpc = { completed: false };
  const response = calls.run(rpc, async () => {
    const run = await api.methods.get('runs.resume').handler(started.id);
    rpc.completed = true;
    return run;
  });
  const result = await Promise.race([response, new Promise(resolve => setTimeout(() => resolve(null), 100))]);
  assert.equal(result?.status, 'waiting', '审批未完成时，视图调用也应立即返回');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(approvalContext, true, '能力调用应在视图 RPC 已结束后启动，不继承它的截止时间');
  assert.ok(['running', 'waiting'].includes((await api.methods.get('runs.resume').handler(started.id)).status),
    '后台已推进到审批等待时，重复轮询继续接口不能误报运行状态错误');
  release();
  assert.equal((await settle(api.methods, started.id)).status, 'succeeded');
  assert.deepEqual(await api.methods.get('runs.activity').handler(), []);
  assert.equal((await api.methods.get('runs.resume').handler(started.id)).status, 'succeeded',
    '后台先完成时，迟到的继续请求只返回当前结果');
  await plugin.deactivate();
});

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
  await plugin.deactivate();
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
  const first = await api.methods.get('runs.trigger').handler({ version: 1, workflowId: workflow.id });
  await assert.rejects(api.methods.get('runs.trigger').handler({ version: 1, workflowId: workflow.id }),
    { code: 'RUN_BUSY' });
  await assert.rejects(api.methods.get('runs.start').handler(workflow.id), { code: 'RUN_BUSY' });
  await settle(api.methods, first.runId);
  const again = await api.methods.get('runs.trigger').handler({ version: 1, workflowId: workflow.id });
  assert.equal(again.version, 1, '上一轮结束后可以继续触发');
  assert.equal((await settle(api.methods, again.runId)).status, 'succeeded');
  await plugin.deactivate();
});

test('启用固定周期后插件会自动触发，停用后停止', async t => {
  const storage = await temporaryStore(t);
  const services = { discover: async () => [], invoke: async () => ({ version: 1, output: '' }) };
  const { context, api } = fakeContext(storage, services);
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const options = await api.methods.get('triggers.options').handler();
  assert.deepEqual(options.modes, ['manual', 'once', 'daily', 'interval', 'message']);
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

test('用户介入通过公开 runs.confirm 继续，禁止用通用入口确认其他人工步骤', async t => {
  const storage = await temporaryStore(t);
  const { context, api } = fakeContext(storage, { discover: async () => [] });
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  try {
    assert.ok(api.methods.has('runs.confirm'));
    const workflow = await api.methods.get('workflows.save').handler({ name: '需求补充', nodes: [
      { id: 'start', type: 'flow.start', title: '开始', x: 0, y: 0, params: {} },
      { id: 'human', type: 'flow.user-input', title: '补充', x: 200, y: 0, params: { prompt: '请填写项目目录' } },
      { id: 'done', type: 'flow.end', title: '完成', x: 400, y: 0, params: { input: '{{human.text}}' } }
    ], edges: [{ from: 'start', to: 'human' }, { from: 'human', to: 'done' }] });
    let run = await api.methods.get('runs.start').handler(workflow.id);
    while (run.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 5));
      run = api.methods.get('runs.get').handler(run.id);
    }
    await assert.rejects(api.methods.get('runs.confirm').handler({ runId: run.id, nodeId: 'wrong', text: 'bad' }), { code: 'RUN_NOT_WAITING' });
    const done = await api.methods.get('runs.confirm').handler({ runId: run.id, nodeId: 'human', requestId: run.pending.form.id, text: '/tmp/project' });
    assert.equal(done.status, 'succeeded');
    assert.equal(done.nodes.done.output.final, '/tmp/project');
  } finally {
    await plugin.deactivate();
  }
});

test('archived Agent sessions remain readable from persisted runs after plugin restart', async t => {
  const storage = await temporaryStore(t);
  const session = { sessionId: 'archive-one', nodeId: 'product', providerId: 'ai', name: '产品', archivedAt: 1 };
  await storage.writeJson('plugin-data/work-flow/runs/flow-one.json', [{ id: 'run-old', workflowId: 'flow-one', sessions: [session] }]);
  const { context, api } = fakeContext(storage, { discover: async () => [] });
  context.capabilities.authorize = async () => {};
  context.capabilities.discover = async () => ({ providers: [{ state: 'ready', descriptor: { id: 'agent.session.history.v1' },
    handle: { pluginId: 'ai', capabilityId: 'agent.session.history.v1' } }] });
  context.capabilities.invoke = async (_handle, input) => {
    assert.equal(input.sessionId, 'archive-one');
    return { invocationId: 'history' };
  };
  context.capabilities.getInvocation = async () => ({ state: 'succeeded', result: { events: [{ sequence: 1, method: 'user/message' }] } });
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  assert.deepEqual(await api.methods.get('runs.sessions').handler({ runId: 'run-old', workflowId: 'flow-one' }), [session]);
  const result = await api.methods.get('runs.sessionHistory').handler({ runId: 'run-old', workflowId: 'flow-one', sessionId: session.sessionId });
  assert.equal(result.events.length, 1);
});

test('导入更新暂停流程后，继续使用旧检查点，新运行使用新定义', async t => {
  const storage = await temporaryStore(t);
  const { context, api } = fakeContext(storage, { discover: async () => [], invoke: async () => ({}) });
  const plugin = await import('../src/main/common/index.js');
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  const invoke = (method, input) => api.methods.get(method).handler(input);
  const workflow = await invoke('workflows.save', { name: '旧流程', nodes: [
    { id: 'start', type: 'flow.start', params: {} },
    { id: 'human', type: 'flow.user-input', params: { interaction: 'choice', options: '继续\n退出' } },
    { id: 'end', type: 'flow.end', params: { input: '旧定义结果' } }
  ], edges: [{ from: 'start', to: 'human' }, { from: 'human', to: 'end' }] });
  const wait = async id => {
    while (invoke('runs.get', id).status === 'running') { await new Promise(resolve => setTimeout(resolve, 5)); }
    return invoke('runs.get', id);
  };
  let run = await wait((await invoke('runs.start', workflow.id)).id);
  const document = { format: 'deckpg.workflow', version: 1, workflow: { ...workflow, name: '新定义',
    nodes: workflow.nodes.map(node => node.id === 'end' ? { ...node, params: { input: '新定义结果' } } : node) } };
  await assert.rejects(invoke('workflows.import', { document, targetId: workflow.id, confirmed: true }), { code: 'RUN_BUSY' });
  await invoke('runs.interrupt', run.id);
  const before = await storage.readJson(`plugin-data/work-flow/runs/${workflow.id}.json`);
  const imported = await invoke('workflows.import', { document, targetId: workflow.id, confirmed: true });
  assert.equal(imported.workflow.id, workflow.id);
  assert.deepEqual(await storage.readJson(`plugin-data/work-flow/runs/${workflow.id}.json`), before);
  run = await invoke('runs.continue', run.id);
  const finish = async current => {
    await invoke('runs.answer', { runId: current.id, batchId: current.pending.interaction.id,
      questionId: current.pending.interaction.questions[0].id, text: '继续' });
    return wait(current.id);
  };
  run = await finish(run);
  assert.equal(run.nodes.end.output.final, '旧定义结果');
  const next = await finish(await wait((await invoke('runs.start', workflow.id)).id));
  assert.equal(next.nodes.end.output.final, '新定义结果');
  assert.equal((await invoke('runs.list', workflow.id)).length, 2);
  assert.equal(api.methods.get('workflows.import').options.exclusive, true);
});
