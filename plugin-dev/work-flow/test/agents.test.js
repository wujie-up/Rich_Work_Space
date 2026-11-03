import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgents, AGENT_CONTRACT } from '../src/main/common/agents.js';
import { TaskClient } from '../src/main/common/task-client.js';

function fixture({ plugins = ['ai-agent-sessions'], sessionPlugins = [],
  result = { state: 'succeeded', output: '根因' }, consent = { state: 'granted' } } = {}) {
  const calls = [];
  const values = new Map();
  const ids = ['agent.task.start.v1', 'agent.task.read.v1', 'agent.task.respond.v1', 'agent.task.cancel.v1'];
  const capabilities = {
    discover: async () => ({ providers: plugins.flatMap(pluginId => ids.map(id => ({ state: 'ready',
      descriptor: { id, title: 'Agent 任务' }, handle: { pluginId, capabilityId: id } }))).concat(
      sessionPlugins.flatMap(pluginId => ['start', 'read', 'history', 'respond', 'cancel', 'close'].map(method => ({ state: 'ready',
        descriptor: { id: `agent.session.${method}.v1`, title: '后台会话' },
        handle: { pluginId, capabilityId: `agent.session.${method}.v1` } })))) }),
    ...(sessionPlugins.length ? {
      authorize: async input => { calls.push({ authorization: input }); return { id: 'lease' }; },
      authorization: async () => ({ id: 'lease', ...consent }),
      revoke: async () => {}
    } : {}),
    invoke: async (handle, input) => {
      calls.push({ handle, input: structuredClone(input) });
      const invocationId = String(calls.length);
      values.set(invocationId, handle.capabilityId.endsWith('.read.v1') ? result
        : handle.capabilityId === 'agent.session.start.v1' ? { sessionId: 'session-new' } : { state: 'running' });
      return { invocationId };
    },
    getInvocation: async id => ({ state: 'succeeded', result: values.get(id) }),
    cancel: async () => {}
  };
  return { agents: createAgents({ tasks: new TaskClient(capabilities) }), calls };
}

test('通过工作台目录发现 AI 插件通用任务能力', async () => {
  const { agents } = fixture();
  assert.equal(AGENT_CONTRACT, 'agent.task.start.v1');
  assert.deepEqual(await agents.providers(), [{ pluginId: 'ai-agent-sessions', title: 'Agent 任务' }]);
});

test('提供方列表包含后台会话能力，并按插件去重兼容旧任务能力', async () => {
  const agents = createAgents({ tasks: {
    providers: async contract => contract === 'agent.session.start.v1'
      ? [{ pluginId: 'modern', title: '后台会话' }, { pluginId: 'both', title: '后台会话' }]
      : [{ pluginId: 'both', title: '通用任务' }, { pluginId: 'legacy', title: '旧任务' }]
  } });
  assert.deepEqual((await agents.providers()).map(provider => provider.pluginId), ['modern', 'both', 'legacy']);
});

test('没有兼容提供方或无法唯一替换旧提供方时不创建任务', async () => {
  for (const [plugins, providerId, code] of [[[], '', 'AGENT_PROVIDER_MISSING'],
    [['ai', 'other'], '', 'AGENT_PROVIDER_AMBIGUOUS'], [['ai', 'other'], 'missing', 'AGENT_PROVIDER_AMBIGUOUS']]) {
    const { agents, calls } = fixture({ plugins });
    await assert.rejects(agents.run({ providerId, prompt: 'p' }), { code });
    assert.equal(calls.length, 0);
  }
});

test('旧运行提供方 ID 自动适配唯一的当前兼容插件，精确选择仍优先', async () => {
  for (const [plugins, providerId, expected] of [
    [['ai-agent-sessions'], 'ai-agent', 'ai-agent-sessions'],
    [['other', 'ai-agent-sessions'], 'ai-agent-sessions', 'ai-agent-sessions']
  ]) {
    const { agents, calls } = fixture({ plugins });
    const request = { providerId, prompt: '巡检' };
    assert.equal((await agents.run(request)).output, '根因');
    assert.equal(request.providerId, expected);
    assert.ok(calls.every(call => call.handle.pluginId === expected));
  }
});

test('插件目录变化后创建任务重新发现，不缓存旧提供方', async () => {
  const plugins = ['old'];
  const { agents, calls } = fixture({ plugins });
  await agents.run({ providerId: 'old', prompt: '第一轮' });
  plugins.splice(0, 1, 'new');
  await agents.run({ providerId: 'old', prompt: '下一轮' });
  assert.equal(calls.at(-1).handle.pluginId, 'new');
});

test('旧 ID 适配后台会话后仍等待工作台授权，不退回旧任务入口', async () => {
  const consent = { state: 'pending' };
  const { agents, calls } = fixture({ plugins: [], sessionPlugins: ['ai-agent-sessions'], consent });
  const request = { providerId: 'ai-agent', prompt: '巡检' };
  const options = { runId: 'run', workflowId: 'flow', nodeId: 'review', name: '巡检 Agent' };
  assert.equal((await agents.run(request, options)).state, 'starting');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization.scopeKey, 'workflow:flow:ai-agent-sessions');
  consent.state = 'granted';
  assert.equal((await agents.run(request, options)).output, '根因');
  assert.equal(request.sessionId, 'session-new');
  assert.deepEqual(calls.slice(1).map(call => call.handle.capabilityId), ['agent.session.start.v1', 'agent.session.read.v1']);
  assert.equal(calls.filter(call => call.authorization).length, 1);
});

test('同一插件的新旧能力合并为一个候选，拒绝授权后不创建后台会话', async () => {
  const { agents, calls } = fixture({ plugins: ['current'], sessionPlugins: ['current'], consent: { state: 'denied' } });
  await assert.rejects(agents.run({ providerId: 'old', prompt: '巡检' },
    { runId: 'run', workflowId: 'flow', nodeId: 'review' }), { code: 'AGENT_AUTHORIZATION_DENIED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization.scopeKey, 'workflow:flow:current');
});

test('新旧能力来自不同提供方时保留明确选择，没有明确候选则不擅自切换', async () => {
  const { agents, calls } = fixture({ plugins: ['legacy'], sessionPlugins: ['modern'] });
  await assert.rejects(agents.run({ providerId: 'missing', prompt: '巡检' }, { runId: 'run' }),
    { code: 'AGENT_PROVIDER_AMBIGUOUS' });
  assert.equal(calls.length, 0);
  await agents.run({ providerId: 'legacy', prompt: '巡检' }, { runId: 'run' });
  assert.deepEqual(calls.map(call => call.handle.capabilityId), ['agent.task.start.v1', 'agent.task.read.v1']);
});

test('已启动的旧任务保持原入口；提供方消失时不能把任务句柄发给新插件', async () => {
  const plugins = ['legacy'];
  const sessionPlugins = ['modern'];
  const { agents, calls } = fixture({ plugins, sessionPlugins });
  const request = { providerId: 'legacy', taskKey: 'owned-task', prompt: '巡检' };
  sessionPlugins.push('legacy');
  await agents.run(request, { runId: 'run' });
  assert.deepEqual(calls.map(call => call.handle.capabilityId), ['agent.task.read.v1']);
  plugins.splice(0, 1, 'replacement');
  sessionPlugins.splice(0);
  await assert.rejects(agents.run(request, { runId: 'run' }));
  assert.equal(calls.length, 1);
  assert.equal(request.providerId, 'legacy');
});

test('已有会话所属插件消失时，不将旧会话 ID 发给替代插件', async () => {
  const { agents, calls } = fixture({ plugins: [], sessionPlugins: ['replacement'] });
  const request = { providerId: 'old', taskKey: 'owned-task', sessionId: 'owned-session', prompt: '巡检' };
  await assert.rejects(agents.run(request, { runId: 'run', nodeId: 'review' }), { code: 'AGENT_PROVIDER_MISSING' });
  assert.equal(calls.length, 0);
  assert.equal(request.providerId, 'old');
});

test('短请求启动并轮询同一任务，固定提供方，完成结果可供下游使用', async () => {
  const result = { state: 'running', requests: [] };
  const { agents, calls } = fixture({ result });
  const request = { providerId: '', prompt: '日志', cwd: '/tmp/app' };
  assert.equal((await agents.run(request)).state, 'running');
  assert.match(request.taskKey, /^[a-f0-9]{64}$/);
  assert.equal(request.providerId, 'ai-agent-sessions');
  Object.assign(result, { state: 'succeeded', output: '连接池耗尽' });
  assert.deepEqual(await agents.run(request), { state: 'succeeded', output: '连接池耗尽', provider: 'ai-agent-sessions' });
  assert.deepEqual(calls.map(item => item.handle.capabilityId), ['agent.task.start.v1', 'agent.task.read.v1', 'agent.task.read.v1']);
  assert.deepEqual(calls[0].input, { taskKey: request.taskKey, prompt: '日志', cwd: '/tmp/app' });
});

test('运行中可响应问题和停止，只操作当前任务；不暴露任务句柄', async () => {
  const result = { state: 'running', requests: [{ id: 'q1', method: 'item/tool/requestUserInput', params: {} }] };
  const { agents, calls } = fixture({ result });
  const request = { prompt: '分析' };
  const current = await agents.run(request);
  assert.equal(current.requests[0].id, 'q1');
  assert.equal(current.taskKey, undefined);
  assert.equal('cwd' in calls[0].input, false);
  await agents.respond(request, { requestId: 'q1', answers: { country: 'CN' }, taskKey: 'spoofed' });
  await agents.cancel(request);
  assert.deepEqual(calls.at(-2).input, { taskKey: request.taskKey, requestId: 'q1', answers: { country: 'CN' } });
  assert.equal(calls.at(-1).handle.capabilityId, 'agent.task.cancel.v1');
  assert.deepEqual(calls.at(-1).input, { taskKey: request.taskKey });
});

test('失败和不兼容的任务结果不能作为成功结果继续执行', async () => {
  for (const [result, code] of [[{ state: 'failed', error: '未安装引擎' }, 'AGENT_TASK_FAILED'],
    [{ state: 'succeeded', output: 42 }, 'AGENT_PROVIDER_INCOMPATIBLE']]) {
    const { agents } = fixture({ result });
    await assert.rejects(agents.run({ prompt: 'p' }), { code });
  }
});

test('代码节点适配已有代码任务能力，并只传已配置的文件范围', async () => {
  const calls = [];
  const agents = createAgents({ tasks: {
    providers: async contract => contract === 'agent.menu.code.start.v1' ? [{ pluginId: 'ai' }] : [],
    call: async (contract, input, options) => {
      calls.push({ contract, input, options });
      return { state: 'succeeded', output: 'done' };
    }
  } });
  await agents.run({ providerId: 'old', mode: 'code', cwd: '/tmp/app', files: ['a.js'], prompt: '修改' });
  assert.equal(calls[0].contract, 'agent.menu.code.start.v1');
  assert.deepEqual(calls[0].input.files, ['a.js']);
  assert.equal(calls[0].options.providerId, 'ai');
});

test('节点接收原有 output 契约，由节点自身解析固定输出', async () => {
  const result = { state: 'succeeded', output: '开始评审\n{"passed":true}' };
  const { agents } = fixture({ result });
  assert.equal((await agents.run({ prompt: 'p', outputFields: { passed: 'boolean' } })).output, result.output);
  assert.equal((await agents.run({ prompt: 'p' })).output, result.output);
});
