import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgents, AGENT_CONTRACT } from '../src/main/common/agents.js';
import { TaskClient } from '../src/main/common/task-client.js';

function fixture({ plugins = ['ai-agent-sessions'], result = { state: 'succeeded', output: '根因' } } = {}) {
  const calls = [];
  const values = new Map();
  const ids = ['agent.task.start.v1', 'agent.task.read.v1', 'agent.task.respond.v1', 'agent.task.cancel.v1'];
  const capabilities = {
    discover: async () => ({ providers: plugins.flatMap(pluginId => ids.map(id => ({ state: 'ready',
      descriptor: { id, title: 'Agent 任务' }, handle: { pluginId, capabilityId: id } }))) }),
    invoke: async (handle, input) => {
      calls.push({ handle, input: structuredClone(input) });
      const invocationId = String(calls.length);
      values.set(invocationId, handle.capabilityId === 'agent.task.read.v1' ? result : { state: 'running' });
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

test('没有提供方、存在多个提供方及指定提供方不可用时明确失败', async () => {
  for (const [plugins, providerId, code] of [[[], '', 'AGENT_PROVIDER_MISSING'],
    [['ai', 'other'], '', 'AGENT_PROVIDER_AMBIGUOUS'], [['ai'], 'missing', 'AGENT_PROVIDER_MISSING']]) {
    const { agents, calls } = fixture({ plugins });
    await assert.rejects(agents.run({ providerId, prompt: 'p' }), { code });
    assert.equal(calls.length, 0);
  }
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
    call: async (contract, input) => {
      calls.push({ contract, input });
      return { state: 'succeeded', output: 'done' };
    }
  } });
  await agents.run({ mode: 'code', cwd: '/tmp/app', files: ['a.js'], prompt: '修改' });
  assert.equal(calls[0].contract, 'agent.menu.code.start.v1');
  assert.deepEqual(calls[0].input.files, ['a.js']);
});

test('节点接收原有 output 契约，由节点自身解析固定输出', async () => {
  const result = { state: 'succeeded', output: '开始评审\n{"passed":true}' };
  const { agents } = fixture({ result });
  assert.equal((await agents.run({ prompt: 'p', outputFields: { passed: 'boolean' } })).output, result.output);
  assert.equal((await agents.run({ prompt: 'p' })).output, result.output);
});
