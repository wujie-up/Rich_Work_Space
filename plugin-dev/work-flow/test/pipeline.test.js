import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Engine } from '../src/main/common/engine.js';
import { Runs } from '../src/main/common/runs.js';
import { createRegistry } from '../src/main/common/nodes.js';
import { Workflows } from '../src/main/common/workflows.js';

const node = (id, type, params = {}) => ({ id, type, title: id, params, x: 0, y: 0 });
const edge = (from, to, branch) => ({ from, to, ...(branch ? { branch } : {}) });
const workflow = (nodes, edges) => ({ id: crypto.randomUUID(), name: 'pipeline', nodes, edges });
async function fixture(t, outputs = []) {
  let cleanup;
  const storage = await temporaryStore({ after: handler => { cleanup = handler; } });
  const calls = [];
  const agents = { run: async request => {
    calls.push(structuredClone(request));
    request.taskKey = String(calls.length);
    return { state: 'succeeded', output: outputs.shift() ?? '{"passed":true}', provider: 'ai' };
  }, cancel: async () => {} };
  const registry = createRegistry({ credentials: {} });
  const engine = new Engine({ registry, runs: new Runs({ storage, pluginId: 'work-flow' }), credentials: {}, agents,
    emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
  const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: type => registry.list().find(item => item.type === type) });
  t.after(async () => { await engine.stop('test'); await cleanup(); });
  return { engine, calls, workflows };
}
async function settled(engine, id) {
  await engine.active.get(id).task;
  return engine.get(id);
}
async function finishAgents(engine, run) {
  while (run.status === 'waiting' && run.pending.kind === 'service') {
    run = await engine.resume(run.id);
  }
  return run;
}
function looping(maxIterations = 3) {
  return workflow([node('source', 'text.input', { content: '需求' }),
    node('review', 'agent.review', { inputMapping: '{"requirement":"{{source.text}}","round":"{{loop.iteration}}","previous":"{{loop.previous}}"}',
      rolePrompt: '你是测试 Agent', outputFields: '{"passed":"boolean"}' }),
    node('loop', 'flow.loop', { input: '{{review.output.passed}}', operator: 'equals', expected: 'false', maxIterations }),
    node('done', 'flow.end', { input: '{{review.output}}' })],
  [edge('source', 'review'), edge('review', 'loop'), edge('loop', 'review', 'continue'), edge('loop', 'done', 'exit')]);
}

test('条件分支只执行命中路径，汇合节点忽略未选路径', async t => {
  const { engine } = await fixture(t);
  const target = workflow([node('s', 'text.input', { content: 'false', format: 'json' }),
    node('route', 'flow.route', { input: '{{s.value}}', operator: 'equals', expected: 'true' }),
    node('yes', 'agent.review', { input: '' }), node('no', 'result.collect', { input: '需要修改' }), node('end', 'flow.end')],
  [edge('s', 'route'), edge('route', 'yes', 'true'), edge('route', 'no', 'false'), edge('yes', 'end'), edge('no', 'end')]);
  const run = await settled(engine, (await engine.start(target)).id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.yes.status, 'skipped');
  assert.equal(run.nodes.no.status, 'succeeded');
  assert.match(run.nodes.end.output.final, /需要修改/);
});

test('Agent 路由使用固定枚举选择已配置分支；未知目标明确失败', async t => {
  const { engine } = await fixture(t, ['{"route":"design","reason":"缺少方案"}', '{"route":"design","reason":"缺少方案"}']);
  const target = workflow([node('s', 'text.input', { content: '需求' }), node('agent', 'agent.review', {
    input: '{{s.text}}', outputFields: '{"route":["code","design"],"reason":"string"}' }),
  node('route', 'flow.route', { mode: 'value', input: '{{agent.output.route}}' }),
  node('design', 'flow.end', { input: '{{agent.output.reason}}' }), node('code', 'flow.end')],
  [edge('s', 'agent'), edge('agent', 'route'), edge('route', 'design', 'design'), edge('route', 'code', 'code')]);
  const run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.code.status, 'skipped');
  assert.equal(run.nodes.design.output.final, '缺少方案');
  target.nodes.find(item => item.id === 'route').params.input = 'unknown';
  const failed = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'ROUTE_NOT_FOUND');
});

test('循环每轮使用新 Agent 请求，并将上一轮结果传入，达成条件后退出', async t => {
  const { engine, calls, workflows } = await fixture(t, ['{"passed":false}', '{"passed":true}']);
  const saved = await workflows.save(looping());
  assert.equal(saved.edges[2].branch, 'continue');
  const run = await finishAgents(engine, await settled(engine, (await engine.start(saved)).id));
  assert.equal(run.status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.taskKey));
  assert.match(calls[0].prompt, /"round":1/);
  assert.match(calls[1].prompt, /"round":2/);
  assert.match(calls[1].prompt, /"passed":false/);
  assert.equal(run.iterations.loop, 2);
  assert.equal(run.nodes.done.output.final, '{"passed":true}');
});

test('循环达到上限等待人工决定，继续和退出有效，取消不再执行', async t => {
  const { engine, calls } = await fixture(t, ['{"passed":false}', '{"passed":false}']);
  let run = await finishAgents(engine, await settled(engine, (await engine.start(looping(1))).id));
  assert.equal(run.pending.kind, 'loop');
  assert.equal(calls.length, 1);
  run = await engine.decideLoop(run.id, 'continue');
  run = await finishAgents(engine, run);
  assert.equal(run.pending.kind, 'loop');
  assert.equal(run.iterations.loop, 2);
  run = await engine.decideLoop(run.id, 'exit');
  assert.equal(run.status, 'succeeded');
  await assert.rejects(engine.decideLoop(run.id, 'exit'), { code: 'RUN_NOT_WAITING' });
  let canceled = await finishAgents(engine, await settled(engine, (await engine.start(looping(1))).id));
  // Default output passes; force the condition to continue for this separate run.
  if (canceled.status === 'succeeded') {
    const always = looping(1);
    always.nodes[2].params.expected = 'true';
    canceled = await finishAgents(engine, await settled(engine, (await engine.start(always)).id));
  }
  await engine.cancel(canceled.id);
  assert.equal(engine.get(canceled.id).status, 'canceled');
  await assert.rejects(engine.decideLoop(canceled.id, 'continue'), { code: 'RUN_NOT_WAITING' });
});

test('总轮次硬上限不可追加，通过第五轮仍正常退出', async t => {
  const { engine, calls } = await fixture(t, Array(5).fill('{"passed":false}'));
  const target = looping(2);
  target.nodes[2].params.maxTotalIterations = 5;
  let run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(run.pending.reason, 'budget');
  run = await finishAgents(engine, await engine.decideLoop(run.id, 'continue'));
  run = await finishAgents(engine, await engine.decideLoop(run.id, 'continue'));
  assert.equal(calls.length, 5);
  assert.equal(run.pending.reason, 'total-limit');
  assert.equal(run.pending.canContinue, false);
  await assert.rejects(engine.decideLoop(run.id, 'continue'), { code: 'LOOP_TOTAL_LIMIT' });
  assert.equal(calls.length, 5);
  await engine.decideLoop(run.id, 'exit');

  const passing = await fixture(t, [...Array(4).fill('{"passed":false}'), '{"passed":true}']);
  target.id = crypto.randomUUID();
  target.nodes[2].params.maxIterations = 5;
  const done = await finishAgents(passing.engine, await settled(passing.engine, (await passing.engine.start(target)).id));
  assert.equal(done.status, 'succeeded');
  assert.equal(done.iterations.loop, 5);
});

test('连续两轮无新增关闭问题暂停，重复和重排不算进展，人工调整后可继续', async t => {
  const results = [['I-1'], ['I-1', 'I-2'], ['I-2', 'I-1', 'I-2'], ['I-1'], ['I-1', 'I-2', 'I-3']];
  const { engine, calls } = await fixture(t, results.map(resolved => JSON.stringify({ passed: false, resolved })));
  const target = looping(10);
  target.nodes[1].params.outputFields = '{"passed":"boolean","resolved":"string[]"}';
  Object.assign(target.nodes[2].params, { maxTotalIterations: 5, maxStagnantIterations: 2, progressInput: '{{review.output.resolved}}' });
  let run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(calls.length, 4);
  assert.equal(run.pending.reason, 'no-progress');
  assert.equal(run.pending.canContinue, true);
  assert.equal(run.iterations.loop, 4);
  run = await finishAgents(engine, await engine.decideLoop(run.id, 'continue'));
  assert.equal(run.pending.reason, 'total-limit');
  assert.equal(calls.length, 5);
});

test('新关闭问题重置无进展次数，缺少完整评审不冒充零进展', async t => {
  const { engine } = await fixture(t, [[], [], ['I-1'], [], ['I-1']].map(resolved => JSON.stringify({ passed: false, resolved })));
  const target = looping(10);
  target.nodes[1].params.outputFields = '{"passed":"boolean","resolved":"string[]"}';
  Object.assign(target.nodes[2].params, { maxTotalIterations: 8, maxStagnantIterations: 2, progressInput: '{{review.output.resolved}}' });
  const run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(run.iterations.loop, 5);
  assert.equal(run.pending.reason, 'no-progress');

  const missing = await fixture(t, Array(4).fill('{"passed":false}'));
  const pendingReview = looping(10);
  Object.assign(pendingReview.nodes[2].params, { maxTotalIterations: 4, maxStagnantIterations: 2, progressInput: '{{missing.output.resolved}}' });
  const stopped = await finishAgents(missing.engine, await settled(missing.engine, (await missing.engine.start(pendingReview)).id));
  assert.equal(stopped.iterations.loop, 4);
  assert.equal(stopped.pending.reason, 'total-limit');
});

test('可选循环限制校验范围，启用无进展限制必须提供进展输入', async t => {
  const { engine } = await fixture(t);
  for (const params of [{ maxTotalIterations: -1 }, { maxTotalIterations: 101 }, { maxStagnantIterations: 1.5 },
    { maxStagnantIterations: 2 }]) {
    const target = looping();
    Object.assign(target.nodes[2].params, params);
    await assert.rejects(engine.start(target), { code: 'INVALID_ARGUMENT' });
  }
});

test('嵌套循环不会互相清零硬上限，重新进入内层循环体前即暂停', async t => {
  const { engine, calls } = await fixture(t, Array.from({ length: 12 }, (_, index) => JSON.stringify({ passed: Boolean(index % 2) })));
  const target = workflow([node('source', 'text.input', { content: '需求' }),
    node('review', 'agent.review', { input: '{{source.text}}', outputFields: '{"passed":"boolean"}' }),
    node('inner', 'flow.loop', { input: '{{review.output.passed}}', expected: 'false', maxIterations: 5, maxTotalIterations: 2 }),
    node('outer', 'flow.loop', { input: 'true', operator: 'not-empty', maxIterations: 5, maxTotalIterations: 2 }),
    node('done', 'flow.end')], [edge('source', 'review'), edge('review', 'inner'), edge('inner', 'review', 'continue'),
    edge('inner', 'outer', 'exit'), edge('outer', 'review', 'continue'), edge('outer', 'done', 'exit')]);
  const run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(calls.length, 2, '不能先执行超额 Agent 再检查上限');
  assert.ok(run.pending, JSON.stringify(run));
  assert.equal(run.pending.nodeId, 'inner');
  assert.equal(run.pending.reason, 'total-limit');
  assert.equal(run.iterations.inner, 2);
  assert.equal(engine.active.get(run.id).loops.outer.iteration, 2);
  await assert.rejects(engine.decideLoop(run.id, 'continue'), { code: 'LOOP_TOTAL_LIMIT' });
  assert.equal(calls.length, 2);
});

test('通过分支绕过循环节点，外层返回仍保留内层已完成轮次', async t => {
  const { engine, calls } = await fixture(t, ['{"passed":false}', '{"passed":true}', '{"passed":true}']);
  const target = workflow([node('source', 'text.input', { content: '需求' }),
    node('review', 'agent.review', { input: '{{source.text}}', outputFields: '{"passed":"boolean"}' }),
    node('route', 'flow.route', { input: '{{review.output.passed}}', expected: 'true' }),
    node('inner', 'flow.loop', { input: '{{source.text}}', operator: 'not-empty', maxIterations: 5, maxTotalIterations: 2 }),
    node('outer', 'flow.loop', { input: '{{source.text}}', operator: 'not-empty', maxIterations: 5, maxTotalIterations: 2 }),
    node('done', 'flow.end')], [edge('source', 'review'), edge('review', 'route'), edge('route', 'inner', 'false'),
    edge('route', 'outer', 'true'), edge('inner', 'review', 'continue'), edge('inner', 'outer', 'exit'),
    edge('outer', 'review', 'continue'), edge('outer', 'done', 'exit')]);
  const run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(calls.length, 2);
  assert.equal(run.pending.nodeId, 'inner');
  assert.equal(run.pending.reason, 'total-limit');
  assert.equal(run.iterations.inner, 2);
});

test('固定输出失败停止下游，显式重试不会重跑已经完成的上游', async t => {
  const { engine, calls } = await fixture(t, ['{"passed":"yes"}', '{"passed":true}']);
  const target = looping();
  let run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'AGENT_OUTPUT_INVALID');
  const startedAt = run.nodes.source.startedAt;
  run = await engine.retry(run.id);
  run = await finishAgents(engine, run);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.source.startedAt, startedAt);
  assert.ok(calls.every(call => !call.taskKey));
});

test('硬上限不把同一失败节点的显式重试计为新一轮', async t => {
  const { engine, calls } = await fixture(t, ['{"passed":"yes"}', '{"passed":true}']);
  const target = looping();
  target.nodes[2].params.maxTotalIterations = 1;
  let run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(run.status, 'failed');
  run = await finishAgents(engine, await engine.retry(run.id));
  assert.equal(run.status, 'succeeded');
  assert.equal(run.iterations.loop, 1);
  assert.equal(calls.length, 2);
});

test('拒绝任意环、无返回路径的循环、缺少分支及无效循环次数', async t => {
  const { engine } = await fixture(t);
  const invalid = looping();
  invalid.edges.push(edge('review', 'source'));
  await assert.rejects(engine.start(invalid), { code: 'WORKFLOW_CYCLE' });
  const noReturn = looping();
  noReturn.edges[2].to = 'done';
  await assert.rejects(engine.start(noReturn), { code: 'INVALID_WORKFLOW' });
  const missing = looping();
  delete missing.edges[3].branch;
  await assert.rejects(engine.start(missing), { code: 'INVALID_WORKFLOW' });
  const badLimit = looping(0);
  await assert.rejects(engine.start(badLimit), { code: 'INVALID_ARGUMENT' });
});

test('循环切换分支清除旧结果，且不会重复执行循环体外已完成的节点', async t => {
  const { engine, calls } = await fixture(t, ['{"route":"fix"}', '{"route":"pass"}']);
  const target = workflow([node('source', 'text.input', { content: '需求' }),
    node('review', 'agent.review', { input: '{{source.text}}', outputFields: '{"route":["fix","pass"]}' }),
    node('outside', 'result.collect', { input: '循环体外只执行一次' }),
    node('route', 'flow.route', { mode: 'value', input: '{{review.output.route}}' }),
    node('fix', 'result.collect', { input: '旧轮次的修改结果' }),
    node('pass', 'result.collect', { input: '本轮通过' }),
    node('round', 'flow.loop', { input: '{{review.output.route}}', expected: 'fix' }),
    node('done', 'flow.end')],
  [edge('source', 'review'), edge('source', 'outside'), edge('review', 'route'),
    edge('route', 'fix', 'fix'), edge('route', 'pass', 'pass'), edge('fix', 'round'), edge('pass', 'round'),
    edge('round', 'review', 'continue'), edge('round', 'done', 'exit')]);
  let run = await settled(engine, (await engine.start(target)).id);
  run = await engine.resume(run.id);
  const outside = engine.get(run.id).nodes.outside;
  run = await finishAgents(engine, run);
  assert.equal(run.status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.deepEqual(run.nodes.outside, outside, '循环体外节点的执行记录不能变化');
  assert.equal(run.nodes.fix.status, 'skipped');
  assert.equal(run.nodes.fix.output, undefined);
  assert.equal(run.nodes.pass.status, 'succeeded');
});

test('失败重试会恢复因中断而未执行的独立分支', async t => {
  const { engine } = await fixture(t, ['invalid', '{"passed":true}']);
  const target = workflow([node('source', 'text.input', { content: '需求' }),
    node('agent', 'agent.review', { input: '{{source.text}}', outputFields: '{"passed":"boolean"}' }),
    node('sibling', 'result.collect', { input: '独立结果' }), node('done', 'flow.end')],
  [edge('source', 'agent'), edge('source', 'sibling'), edge('agent', 'done'), edge('sibling', 'done')]);
  let run = await finishAgents(engine, await settled(engine, (await engine.start(target)).id));
  assert.equal(run.status, 'failed');
  assert.equal(run.nodes.sibling.status, 'skipped');
  run = await finishAgents(engine, await engine.retry(run.id));
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.sibling.status, 'succeeded');
  assert.match(run.nodes.done.output.final, /独立结果/);
});

test('代码任务等待状态向界面提供模式，以显示原生批准入口', async t => {
  const { engine } = await fixture(t);
  const target = workflow([node('source', 'text.input', { content: '修改' }),
    node('code', 'agent.review', { input: '{{source.text}}', mode: 'code', cwd: '/tmp/repo', files: 'a.js' })],
  [edge('source', 'code')]);
  const run = await settled(engine, (await engine.start(target)).id);
  assert.equal(run.pending.mode, 'code');
});


test('评审需要业务确认时复用需求介入，确认后重跑分析和评审而非技术返工', async t => {
  const { engine, calls, workflows } = await fixture(t, [
    '{"ready":false}', '{"ready":true}', '{"route":"clarify"}', '{"ready":true}', '{"route":"develop"}'
  ]);
  const target = workflow([node('start', 'flow.start'),
    node('requirements', 'agent.review', { outputFields: '{"ready":"boolean"}', input: '需求：{{loop.previous.human.text}}' }),
    node('ready', 'flow.route', { input: '{{requirements.output.ready}}' }),
    node('review', 'agent.review', { input: '评审需求', outputFields: '{"route":["clarify","develop"]}' }),
    node('needsInput', 'flow.route', { input: '{{review.output.route}}', expected: 'clarify' }),
    node('human', 'flow.user-input', { prompt: '{{review.output.route}}' }),
    node('again', 'flow.loop', { input: '{{human.text}}', operator: 'not-empty', maxIterations: 3 }),
    node('stop', 'flow.end'), node('code', 'flow.end', { input: '{{review.output.route}}' })
  ], [edge('start', 'requirements'), edge('requirements', 'ready'), edge('ready', 'review', 'true'), edge('ready', 'human', 'false'),
    edge('review', 'needsInput'), edge('needsInput', 'human', 'true'), edge('needsInput', 'code', 'false'),
    edge('human', 'again'), edge('again', 'requirements', 'continue'), edge('again', 'stop', 'exit')]);
  const saved = await workflows.save(target);
  let run = await finishAgents(engine, await settled(engine, (await engine.start(saved)).id));
  assert.equal(run.status, 'waiting', JSON.stringify(run));
  assert.equal(run.pending.nodeId, 'human');
  assert.equal(calls.length, 1, '需求不足时不调用评审');
  run = await engine.complete(run.id, 'human', { requestId: run.pending.form.id, text: '项目目录和对战规则' });
  run = await finishAgents(engine, run);
  assert.equal(run.pending.nodeId, 'human');
  assert.equal(run.pending.form.prompt, 'clarify');
  assert.equal(calls.length, 3, '评审疑问应等待用户，不能自行反复设计');
  run = await engine.complete(run.id, 'human', { requestId: run.pending.form.id, text: '替补本回合立即行动' });
  run = await finishAgents(engine, run);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.code.output.final, 'develop');
  assert.equal(run.nodes.stop.status, 'skipped');
  assert.equal(calls.length, 5);
  assert.match(calls[3].prompt, /替补本回合立即行动/);
});
