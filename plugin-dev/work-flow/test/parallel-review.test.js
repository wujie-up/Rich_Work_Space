import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Engine } from '../src/main/common/engine.js';
import { Runs } from '../src/main/common/runs.js';
import { createRegistry } from '../src/main/common/nodes.js';
import { Workflows } from '../src/main/common/workflows.js';
import { workflowActivity } from '../src/renderer/workflow-activity.js';

async function fixture(t, runAgent) {
  const storage = await temporaryStore(t);
  const canceled = [];
  const registry = createRegistry({ credentials: {} });
  const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: type => registry.list().find(item => item.type === type) });
  const engine = new Engine({ registry, runs: new Runs({ storage, pluginId: 'work-flow' }), credentials: {},
    agents: { run: runAgent, cancel: async request => canceled.push(request.prompt) }, emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
  t.after(() => engine.stop('test'));
  const nodes = [
    { id: 'start', type: 'flow.start', params: {} },
    { id: 'parallel', type: 'flow.parallel', params: { joinNodeId: 'join' } },
    ...['a', 'b', 'c', 'd'].map(id => ({ id, type: 'agent.review', params: { input: id } })),
    { id: 'join', type: 'flow.join', params: {} },
    { id: 'summary', type: 'result.collect', params: { input: '{{join}}' } }
  ];
  const edges = [{ from: 'start', to: 'parallel' }, ...['a', 'b', 'c', 'd'].flatMap(id => [
    { from: 'parallel', to: id }, { from: id, to: 'join' }
  ]), { from: 'join', to: 'summary' }];
  const workflow = await workflows.save({ id: 'parallel-review', name: '并行审核', nodes, edges });
  const started = await engine.start(workflow);
  await engine.active.get(started.id).task;
  return { engine, run: engine.get(started.id), workflows, workflow, canceled };
}

test('四个 Agent 在任何一个完成前同时启动，慢分支结束前不进入汇合', async t => {
  const waiting = new Map();
  const { engine, run } = await fixture(t, (request, { nodeId }) => new Promise(resolve => waiting.set(nodeId, resolve)));
  const poll = engine.resume(run.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...waiting.keys()], ['a', 'b', 'c', 'd']);
  for (const id of ['a', 'b', 'c']) { waiting.get(id)({ state: 'succeeded', output: `${id}-done` }); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.get(run.id).nodes.join, undefined);
  waiting.get('d')({ state: 'succeeded', output: 'd-done' });
  const result = await poll;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.nodes.join.output.results.d.output, 'd-done');
});

test('并行轮询保留已完成分支；失败会取消其余 Agent 并阻止汇合', async t => {
  let second = false;
  const seen = [];
  const { engine, run, canceled } = await fixture(t, async (request, { nodeId }) => {
    seen.push(nodeId);
    if (nodeId === 'a') { return { state: 'succeeded', output: 'done' }; }
    if (second && nodeId === 'c') { throw new Error('review failed'); }
    return { state: 'running', requests: [] };
  });
  await engine.resume(run.id);
  second = true;
  const result = await engine.resume(run.id);
  assert.equal(seen.filter(id => id === 'a').length, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.nodes.c.status, 'failed');
  assert.match(result.nodes.c.error.message, /review failed/);
  assert.equal(result.nodes.join.status, 'skipped');
  assert.equal(canceled.length, 3);
});

test('停止并行等待取消全部分支且不再进入汇合', async t => {
  const { engine, run, canceled } = await fixture(t, async () => ({ state: 'running', requests: [] }));
  await engine.resume(run.id);
  await engine.cancel(run.id);
  assert.equal(canceled.length, 4);
  assert.equal(engine.get(run.id).status, 'canceled');
  assert.equal(engine.get(run.id).nodes.join.status, 'skipped');
});

test('保存时拒绝没有正确汇合的并行分支', async t => {
  const { workflows, workflow } = await fixture(t, async () => ({ state: 'running' }));
  await assert.rejects(workflows.save({ ...workflow, edges: workflow.edges.filter(edge => edge.from !== 'd') }), /汇合/);
});

test('并行 Agent 的同名原生问题按角色逐个确认，不串用回答', async t => {
  const answers = new Map();
  const { engine, run } = await fixture(t, async (request, { nodeId }) => {
    if (['c', 'd'].includes(nodeId) || answers.has(nodeId)) { return { state: 'succeeded', output: nodeId }; }
    return { state: 'waiting', requests: [{ id: 'same-request', method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'q', question: `${nodeId} 的问题`, options: ['确认'] }] } }] };
  });
  engine.agents.respond = async (request, input) => answers.set(request.prompt.split('\n\n').at(-1), input.answers.q);
  let result = await engine.resume(run.id);
  const firstBatch = result.pending.interaction.id;
  assert.match(result.pending.interaction.questions[0].question, /a 的问题/);
  result = await engine.resume(run.id);
  assert.equal(result.pending.interaction.id, firstBatch);
  await engine.answer(run.id, { batchId: firstBatch, questionId: 'q', text: 'a 确认' });
  result = await engine.resume(run.id);
  assert.match(result.pending.interaction.questions[0].question, /b 的问题/);
  assert.notEqual(result.pending.interaction.id, firstBatch);
  await assert.rejects(engine.answer(run.id, { batchId: firstBatch, questionId: 'q', text: '过期回答' }), /失效/);
  await engine.answer(run.id, { batchId: result.pending.interaction.id, questionId: 'q', text: 'b 确认' });
  result = await engine.resume(run.id);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual([...answers], [['a', 'a 确认'], ['b', 'b 确认']]);
});


test('并行调用中停止，迟到结果不能重新进入汇合或覆盖取消状态', async t => {
  const waiting = [];
  const { engine, run, canceled } = await fixture(t, () => new Promise(resolve => waiting.push(resolve)));
  const poll = engine.resume(run.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting.length, 4);
  await engine.cancel(run.id);
  waiting.forEach(resolve => resolve({ state: 'succeeded', output: 'late result' }));
  await poll;
  assert.equal(canceled.length, 4);
  assert.equal(engine.get(run.id).status, 'canceled');
  assert.equal(engine.get(run.id).nodes.join.status, 'skipped');
});

test('等待一个角色回答期间刷新其他运行分支，保留当前问题并清理蓝灯', async t => {
  let finished = false;
  const reads = [];
  const { engine, run } = await fixture(t, async (_request, { nodeId }) => {
    reads.push(nodeId);
    if (nodeId === 'a') {
      return { state: 'waiting', requests: [{ id: 'native', method: 'item/tool/requestUserInput',
        params: { questions: [{ id: 'q', question: '等待用户明确决定' }] } }] };
    }
    return { state: finished ? 'succeeded' : 'running', output: nodeId, requests: [] };
  });
  const first = await engine.resume(run.id);
  assert.equal(workflowActivity(first), 'agent');
  finished = true;
  const refreshed = await engine.resume(run.id);
  assert.equal(refreshed.pending.interaction.id, first.pending.interaction.id);
  assert.equal(refreshed.pending.focusNodeId, undefined);
  assert.equal(refreshed.pending.task.requests[0].id, 'native');
  assert.equal(refreshed.nodes.b.status, 'succeeded');
  assert.equal(refreshed.nodes.join, undefined);
  assert.equal(workflowActivity(refreshed), 'waiting');
  assert.equal(reads.filter(id => id === 'a').length, 1);
});

test('并行中断重启仅恢复未完成角色，原生问题答案归属正确', async t => {
  const seen = [];
  const { engine, run, workflow } = await fixture(t, async (request, { nodeId }) => {
    if (['a', 'c', 'd'].includes(nodeId)) { return { state: 'succeeded', output: nodeId }; }
    request.taskKey = 'b-task';
    return { state: 'waiting', requests: [{ id: 'native', method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'q', question: 'b 需要补充', options: ['确认'] }] } }] };
  });
  await engine.resume(run.id);
  await engine.interrupt(run.id);
  const restarted = new Engine({ registry: engine.registry, runs: engine.runs, credentials: {},
    agents: { run: async (request, { nodeId }) => { seen.push({ nodeId, prompt: request.prompt });
      return { state: 'succeeded', output: `${nodeId}-restarted` }; }, respond: async () => assert.fail('不能提交失效请求') },
    emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
  t.after(() => restarted.stop('test'));
  await restarted.restore(workflow.id);
  let continued = await restarted.continue(run.id);
  await restarted.answer(run.id, { batchId: continued.pending.interaction.id, questionId: 'q', text: 'b 确认' });
  continued = await restarted.resume(run.id);
  assert.equal(continued.status, 'succeeded');
  assert.deepEqual(seen.map(item => item.nodeId), ['b']);
  assert.match(seen[0].prompt, /b 确认/);
  assert.equal(continued.nodes.join.output.results.a.output, 'a');
  assert.equal(continued.nodes.join.output.results.b.output, 'b-restarted');
});
