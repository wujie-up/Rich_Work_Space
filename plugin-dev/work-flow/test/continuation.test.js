import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Runs } from '../src/main/common/runs.js';
import { Engine } from '../src/main/common/engine.js';
import { createRegistry } from '../src/main/common/nodes.js';
import { createAgents } from '../src/main/common/agents.js';

const node = (id, type, params = {}) => ({ id, type, title: id, params });
const flow = nodes => ({ id: crypto.randomUUID(), name: '续跑测试', nodes,
  edges: nodes.slice(1).map((item, index) => ({ from: nodes[index].id, to: item.id })) });

async function fixture(t) {
  const storage = await temporaryStore(t);
  const runs = new Runs({ storage, pluginId: 'work-flow' });
  const registry = createRegistry({ credentials: {} });
  const engines = [];
  const create = () => {
    const engine = new Engine({ runs, registry, credentials: {}, agents: {}, emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
    engines.push(engine);
    return engine;
  };
  t.after(async () => { for (const engine of engines) { await engine.stop('test'); } });
  return { runs, registry, create, engine: create() };
}

async function settle(engine, id) {
  await engine.active.get(id).task;
  return engine.get(id);
}

for (const action of ['retry', 'restore']) {
  test(`旧提供方快照在 ${action} 后适配当前插件，保留上游结果及原流程配置`, async t => {
    const { engine, create } = await fixture(t);
    const providers = [];
    const calls = [];
    const agents = createAgents({ tasks: {
      providers: async () => providers,
      call: async (contract, input, options) => {
        calls.push({ contract, input, options });
        return { state: 'succeeded', output: '巡检报告' };
      }
    } });
    engine.agents = agents;
    const workflow = flow([node('source', 'text.input', { content: '已查询日志' }),
      node('review', 'agent.review', { providerId: 'ai-agent', input: '{{source.text}}' }),
      node('end', 'flow.end', { input: '{{review.output}}' })]);
    let run = await settle(engine, (await engine.start(workflow)).id);
    run = await engine.resume(run.id);
    assert.equal(run.error.code, 'AGENT_PROVIDER_MISSING');
    const upstream = structuredClone(run.nodes.source);
    providers.push({ pluginId: 'ai-agent-sessions' });
    let current = engine;
    if (action === 'retry') {
      await current.retry(run.id);
    } else {
      current = create();
      current.agents = agents;
      await current.restore(workflow.id);
      await current.continue(run.id);
      await settle(current, run.id);
    }
    run = await current.resume(run.id);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.nodes.end.output.final, '巡检报告');
    assert.deepEqual(run.nodes.source, upstream);
    assert.equal(calls[0].options.providerId, 'ai-agent-sessions');
    assert.match(calls[0].input.prompt, /已查询日志/);
    assert.equal(current.active.get(run.id).workflow.nodes[1].params.providerId, 'ai-agent');
  });
}

test('评审无进展与总轮数检查点重启后保留，不能通过继续绕过上限', async t => {
  const { engine, create } = await fixture(t);
  const response = async () => ({ state: 'succeeded', output: '{"resolved":[]}' });
  engine.agents.run = response;
  const workflow = { id: crypto.randomUUID(), name: '评审上限续跑', nodes: [node('start', 'flow.start'),
    node('review', 'agent.review', { input: '独立评审', outputFields: '{"resolved":"string[]"}' }),
    node('loop', 'flow.loop', { input: '{{start.started}}', expected: 'true', maxIterations: 10,
      maxTotalIterations: 4, maxStagnantIterations: 2, progressInput: '{{review.output.resolved}}' }), node('end', 'flow.end')],
  edges: [{ from: 'start', to: 'review' }, { from: 'review', to: 'loop' },
    { from: 'loop', to: 'review', branch: 'continue' }, { from: 'loop', to: 'end', branch: 'exit' }] };
  const run = await settle(engine, (await engine.start(workflow)).id);
  await engine.resume(run.id);
  await engine.resume(run.id);
  await engine.interrupt(run.id);
  const restarted = create();
  restarted.agents.run = response;
  await restarted.restore(workflow.id);
  await restarted.continue(run.id);
  let waiting = await restarted.resume(run.id);
  assert.equal(waiting.pending.reason, 'no-progress');
  assert.equal(waiting.iterations.loop, 3);
  assert.deepEqual(restarted.active.get(run.id).loops.loop.resolvedIssueIds, []);
  await restarted.interrupt(run.id);
  const again = create();
  again.agents.run = response;
  await again.restore(workflow.id);
  waiting = await again.continue(run.id);
  assert.equal(waiting.pending.reason, 'no-progress');
  await again.decideLoop(run.id, 'continue');
  waiting = await again.resume(run.id);
  assert.equal(waiting.pending.reason, 'total-limit');
  assert.equal(waiting.pending.canContinue, false);
  await again.interrupt(run.id);
  const capped = create();
  await capped.restore(workflow.id);
  waiting = await capped.continue(run.id);
  assert.equal(waiting.pending.canContinue, false);
  await assert.rejects(capped.decideLoop(run.id, 'continue'), { code: 'LOOP_TOTAL_LIMIT' });
  assert.equal(capped.active.get(run.id).loops.loop.iteration, 4);
  assert.equal(capped.get(run.id).nodes.end, undefined);
});

test('暂缓后不执行下游；重启后继续原题并保留已确认答案及完整长输出', async t => {
  const { engine, create, runs, registry } = await fixture(t);
  let calls = 0;
  const original = registry.get('text.input').resolve;
  registry.get('text.input').resolve = context => { calls++; return original(context); };
  const source = '完整文档'.repeat(2000);
  const workflow = flow([node('source', 'text.input', { content: source }),
    node('human', 'flow.user-input', { prompt: '["第一题","第二题"]' }),
    node('done', 'flow.end', { input: '{{source.text}}\n{{human.text}}' })]);
  const started = await engine.start(workflow);
  let run = await settle(engine, started.id);
  await engine.answer(run.id, { batchId: run.pending.interaction.id,
    questionId: run.pending.interaction.questions[0].id, text: '第一题答案' });
  run = await engine.interrupt(run.id);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.nodes.done, undefined);
  assert.equal(run.resumable, true);
  assert.equal((await runs.list(workflow.id))[0].checkpoint, undefined, '界面历史不能包含完整检查点');
  const restarted = create();
  await restarted.restore(workflow.id);
  assert.equal(restarted.get(run.id).status, 'interrupted');
  run = await restarted.continue(run.id);
  assert.equal(run.status, 'waiting');
  assert.equal(run.pending.interaction.currentIndex, 1);
  assert.equal(calls, 1, '上游节点不得重跑');
  await restarted.answer(run.id, { batchId: run.pending.interaction.id,
    questionId: run.pending.interaction.questions[1].id, text: '第二题答案' });
  run = await settle(restarted, run.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(restarted.active.get(run.id).outputs.done.final, `${source}\n第一题\n第一题答案\n\n第二题\n第二题答案`);
});

test('异常退出留下的人工等待不自动执行；继续互斥且其他运行不能抢占', async t => {
  const { engine, create } = await fixture(t);
  const workflow = flow([node('human', 'flow.user-input', { interaction: 'file' }), node('end', 'flow.end')]);
  const run = await settle(engine, (await engine.start(workflow)).id);
  const restarted = create();
  await restarted.restore(workflow.id);
  assert.equal(restarted.get(run.id).status, 'interrupted');
  assert.equal(restarted.activeRun(workflow.id), false);
  await restarted.continue(run.id);
  await assert.rejects(restarted.continue(run.id), { code: 'RUN_NOT_CONTINUABLE' });
  await restarted.interrupt(run.id);
  const other = await settle(restarted, (await restarted.start(workflow)).id);
  await assert.rejects(restarted.continue(run.id), { code: 'RUN_BUSY' });
  assert.equal(other.status, 'waiting');
});

test('普通失败节点可继续，保留上游输出并清除失败引起的跳过标记', async t => {
  const { engine, registry, create } = await fixture(t);
  let calls = 0;
  const original = registry.get('result.collect').resolve;
  registry.get('result.collect').resolve = context => {
    calls++;
    if (calls === 1) { throw Error('临时故障'); }
    return original(context);
  };
  const workflow = flow([node('source', 'text.input', { content: '原始输入' }),
    node('collect', 'result.collect', { input: '{{source.text}}' }), node('end', 'flow.end', { input: '{{collect.report}}' })]);
  const failed = await settle(engine, (await engine.start(workflow)).id);
  assert.equal(failed.status, 'failed');
  const restarted = create();
  await restarted.restore(workflow.id);
  await restarted.continue(failed.id);
  const completed = await settle(restarted, failed.id);
  assert.equal(completed.status, 'succeeded');
  assert.match(completed.nodes.end.output.final, /原始输入/);
  assert.equal(calls, 2);
});

test('并发保存不丢运行，历史上限不淘汰可继续的运行', async t => {
  const { runs } = await fixture(t);
  await runs.append({ id: 'paused', workflowId: 'flow', status: 'interrupted', resumable: true });
  await Promise.all(Array.from({ length: 25 }, (_, index) => runs.append({ id: `run-${index}`, workflowId: 'flow', status: 'succeeded' })));
  const stored = await runs.list('flow');
  assert.equal(stored.filter(run => run.status === 'succeeded').length, 20);
  assert.ok(stored.some(run => run.id === 'paused'));
});

test('旧版本活跃历史恢复为已中断，不阻塞新运行也不伪造续跑数据', async t => {
  const { runs, engine } = await fixture(t);
  await runs.append({ id: 'legacy', workflowId: 'legacy-flow', status: 'waiting', nodes: {} });
  await engine.restore('legacy-flow');
  assert.equal(engine.get('legacy').status, 'interrupted');
  assert.equal(engine.get('legacy').resumable, false);
  assert.equal(engine.activeRun('legacy-flow'), false);
  await assert.rejects(engine.continue('legacy'), { code: 'RUN_NOT_CONTINUABLE' });
  assert.equal((await runs.list('legacy-flow'))[0].status, 'interrupted');
});

test('执行快照不会随着画布后续编辑改变，停止后仍可继续', async t => {
  const { engine, create } = await fixture(t);
  const workflow = flow([node('human', 'flow.user-input'), node('end', 'flow.end', { input: '原始定义' })]);
  const run = await settle(engine, (await engine.start(workflow)).id);
  workflow.nodes[1].params.input = '后来修改';
  await engine.stop('disable');
  const restarted = create();
  await restarted.restore(workflow.id);
  const continued = await restarted.continue(run.id);
  await restarted.answer(run.id, { batchId: continued.pending.interaction.id,
    questionId: continued.pending.interaction.questions[0].id, text: '确认' });
  assert.equal(restarted.get(run.id).nodes.end.output.final, '原始定义');
});

test('循环上限检查点保存轮次和上一轮上下文，重启后继续下一轮', async t => {
  const { engine, create } = await fixture(t);
  const calls = [];
  engine.agents.run = async request => { calls.push(request.prompt); return { state: 'succeeded', output: '{"passed":false}' }; };
  const workflow = { id: crypto.randomUUID(), name: '循环续跑', nodes: [node('start', 'flow.start'), node('review', 'agent.review', {
    input: '{{loop.iteration}}', outputFields: '{"passed":"boolean"}' }),
  node('loop', 'flow.loop', { input: '{{review.output.passed}}', expected: 'false', maxIterations: 1 }), node('end', 'flow.end')],
  edges: [{ from: 'start', to: 'review' }, { from: 'review', to: 'loop' }, { from: 'loop', to: 'review', branch: 'continue' },
    { from: 'loop', to: 'end', branch: 'exit' }] };
  const run = await settle(engine, (await engine.start(workflow)).id);
  assert.equal((await engine.resume(run.id)).pending.kind, 'loop');
  await engine.interrupt(run.id);
  const restarted = create();
  restarted.agents.run = async request => { calls.push(request.prompt); return { state: 'succeeded', output: '{"passed":true}' }; };
  await restarted.restore(workflow.id);
  await restarted.continue(run.id);
  await restarted.decideLoop(run.id, 'continue');
  const done = await restarted.resume(run.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.iterations.loop, 2);
  assert.match(calls[1], /\n\n2\n\n/);
  assert.equal(restarted.active.get(run.id).loopContext.previous.review.output.passed, false);
});

test('继续等待旧调用收尾，迟到结果不覆盖中断状态或跳过节点', async t => {
  const { engine } = await fixture(t);
  let finish;
  engine.agents.run = () => new Promise(resolve => { finish = resolve; });
  const workflow = flow([node('agent', 'agent.review', { input: '验证续跑' }), node('end', 'flow.end')]);
  const run = await settle(engine, (await engine.start(workflow)).id);
  const polling = engine.resume(run.id);
  await new Promise(resolve => setImmediate(resolve));
  await engine.interrupt(run.id);
  const continuation = engine.continue(run.id);
  await assert.rejects(engine.continue(run.id), { code: 'RUN_NOT_CONTINUABLE' });
  finish({ state: 'succeeded', output: '迟到结果' });
  await polling;
  assert.equal((await continuation).status, 'waiting');
  assert.equal(engine.get(run.id).nodes.end, undefined);
  engine.agents.run = async () => ({ state: 'succeeded', output: '重新完成' });
  assert.equal((await engine.resume(run.id)).status, 'succeeded');
});

test('重启后旧原生问题先确认，新会话再产生问题时仍使用原生响应', async t => {
  const { engine, create } = await fixture(t);
  const question = { id: 'same-id', method: 'item/tool/requestUserInput', params: {
    questions: [{ id: 'q', question: '请确认', options: ['确认'] }] } };
  engine.agents.run = async request => { request.taskKey = 'old-task'; return { state: 'waiting', requests: [question] }; };
  const workflow = flow([node('agent', 'agent.review', { input: '验证续跑' }), node('end', 'flow.end')]);
  const run = await settle(engine, (await engine.start(workflow)).id);
  await engine.resume(run.id);
  await engine.stop('restart');
  const restarted = create();
  let calls = 0;
  const responses = [];
  restarted.agents.run = async request => { calls++; request.taskKey = 'new-task'; return { state: 'waiting', requests: [question] }; };
  restarted.agents.respond = async (request, answer) => responses.push(answer);
  await restarted.restore(workflow.id);
  let continued = await restarted.continue(run.id);
  await restarted.resume(run.id);
  assert.equal(calls, 0, '保存的问题未确认前不能重启 Agent');
  await restarted.answer(run.id, { batchId: continued.pending.interaction.id, questionId: 'q', text: '旧问题回答' });
  assert.equal(responses.length, 0);
  continued = await restarted.resume(run.id);
  await restarted.answer(run.id, { batchId: continued.pending.interaction.id, questionId: 'q', text: '新问题回答' });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].answers.q, '新问题回答');
});

test('新建运行读取期间继续旧运行，最终启动检查仍拒绝重复占用', async t => {
  const { engine } = await fixture(t);
  const workflow = flow([node('human', 'flow.user-input')]);
  const run = await settle(engine, (await engine.start(workflow)).id);
  await engine.interrupt(run.id);
  let finishRead;
  const reading = new Promise(resolve => { finishRead = resolve; });
  const start = async () => {
    assert.equal(engine.activeRun(workflow.id), false);
    return engine.start(await reading);
  };
  const starting = start();
  await engine.continue(run.id);
  finishRead(workflow);
  await assert.rejects(starting, { code: 'RUN_BUSY' });
  assert.equal(engine.snapshot().length, 1);
});

test('暂停后重选已确认文件，仅作废依赖结果并保留独立分支和历史', async t => {
  const { engine, registry, create } = await fixture(t);
  const calls = [];
  const original = registry.get('text.input').resolve;
  registry.get('text.input').resolve = context => { calls.push(context.nodeId); return original(context); };
  const workflow = { id: crypto.randomUUID(), name: '重新选择文件', nodes: [node('start', 'flow.start'),
    node('file', 'flow.user-input', { interaction: 'file' }), node('independent', 'text.input', { content: '独立结果' }),
    node('derived', 'text.input', { content: '{{file.text}}' }), node('human', 'flow.user-input'),
    node('end', 'flow.end', { input: '{{derived.text}} / {{independent.text}}' })], edges: [
    { from: 'start', to: 'file' }, { from: 'start', to: 'independent' }, { from: 'file', to: 'derived' },
    { from: 'derived', to: 'human' }, { from: 'human', to: 'end' }, { from: 'independent', to: 'end' }
  ] };
  let run = await settle(engine, (await engine.start(workflow)).id);
  const oldFile = { requestId: run.pending.form.id, text: '错误文档', file: { name: '错误.md', size: 12 } };
  run = await engine.complete(run.id, 'file', oldFile);
  const oldQuestion = { batchId: run.pending.interaction.id, questionId: run.pending.interaction.questions[0].id, text: '旧确认' };
  const independent = structuredClone(run.nodes.independent);
  run = await engine.reselectFile(run.id, 'file');
  assert.equal(run.status, 'waiting');
  assert.equal(run.pending.nodeId, 'file');
  assert.notEqual(run.pending.form.id, oldFile.requestId);
  assert.equal(run.nodes.derived, undefined);
  assert.equal(run.nodes.human, undefined);
  assert.deepEqual(run.nodes.independent, independent);
  assert.equal(run.history.find(entry => entry.nodeId === 'file').output.file.name, '错误.md');
  assert.equal(run.history.find(entry => entry.nodeId === 'derived').output.text, '错误文档');
  await assert.rejects(engine.complete(run.id, 'file', oldFile), { code: 'RUN_INPUT_STALE' });
  await assert.rejects(engine.answer(run.id, oldQuestion), { code: 'QUESTION_EXPIRED' });
  await engine.interrupt(run.id);
  const restarted = create();
  await restarted.restore(workflow.id);
  run = await restarted.continue(run.id);
  assert.equal(run.pending.nodeId, 'file');
  run = await restarted.complete(run.id, 'file', { requestId: run.pending.form.id, text: '正确文档',
    file: { name: '正确.md', size: 12 } });
  await restarted.answer(run.id, { batchId: run.pending.interaction.id,
    questionId: run.pending.interaction.questions[0].id, text: '新确认' });
  const done = restarted.get(run.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.nodes.end.output.final, '正确文档 / 独立结果');
  assert.deepEqual(calls, ['independent', 'derived', 'derived']);
});

test('已中断运行重启后可重选文件，其他运行占用、执行中和非文件目标拒绝回退', async t => {
  const { engine, create } = await fixture(t);
  const workflow = flow([node('file', 'flow.user-input', { interaction: 'file' }),
    node('agent', 'agent.review', { input: '{{file.text}}' }), node('end', 'flow.end')]);
  let run = await settle(engine, (await engine.start(workflow)).id);
  await assert.rejects(engine.reselectFile(run.id, 'file'), { code: 'RUN_FILE_NOT_EDITABLE' });
  run = await engine.complete(run.id, 'file', { requestId: run.pending.form.id, text: '旧需求', file: { name: '旧.md', size: 9 } });
  await assert.rejects(engine.reselectFile(run.id, 'file'), { code: 'RUN_NOT_PAUSED' });
  await engine.interrupt(run.id);
  const restarted = create();
  await restarted.restore(workflow.id);
  const other = await settle(restarted, (await restarted.start(workflow)).id);
  await assert.rejects(restarted.reselectFile(run.id, 'file'), { code: 'RUN_BUSY' });
  await restarted.interrupt(other.id);
  await assert.rejects(restarted.reselectFile(run.id, 'agent'), { code: 'RUN_FILE_NOT_EDITABLE' });
  const editing = restarted.reselectFile(run.id, 'file');
  await assert.rejects(restarted.reselectFile(run.id, 'file'), { code: 'RUN_NOT_PAUSED' });
  await assert.rejects(restarted.continue(run.id), { code: 'RUN_NOT_CONTINUABLE' });
  run = await editing;
  assert.equal(run.pending.nodeId, 'file');
  assert.equal(run.pending.form.interaction, 'file');
  assert.equal(run.nodes.agent, undefined);
  assert.equal(restarted.active.get(run.id).outputs.file, undefined);
});

test('文件回退重置受影响循环，旧轮次上下文不污染新文档', async t => {
  const { engine } = await fixture(t);
  const workflow = { id: crypto.randomUUID(), name: '文件循环', nodes: [
    node('file', 'flow.user-input', { interaction: 'file' }), node('review', 'agent.review', { input: '{{file.text}}' }),
    node('loop', 'flow.loop', { input: '{{file.text}}', operator: 'not-empty', maxIterations: 1 }), node('end', 'flow.end')],
  edges: [{ from: 'file', to: 'review' }, { from: 'review', to: 'loop' },
    { from: 'loop', to: 'review', branch: 'continue' }, { from: 'loop', to: 'end', branch: 'exit' }] };
  engine.agents.run = async () => ({ state: 'succeeded', output: '评审结果' });
  let run = await settle(engine, (await engine.start(workflow)).id);
  await engine.complete(run.id, 'file', { requestId: run.pending.form.id, text: '旧文档', file: { name: '旧.md', size: 9 } });
  await engine.resume(run.id);
  await engine.decideLoop(run.id, 'continue');
  run = await engine.resume(run.id);
  assert.equal(run.pending.kind, 'loop');
  assert.equal(run.iterations.loop, 2);
  assert.equal(engine.active.get(run.id).loopContext.previous.file.text, '旧文档');
  run = await engine.reselectFile(run.id, 'file');
  assert.equal(run.pending.nodeId, 'file');
  assert.equal(run.iterations.loop, undefined);
  assert.deepEqual(engine.active.get(run.id).loops, {});
  assert.deepEqual(engine.active.get(run.id).loopContext, { iteration: 1, previous: {} });
  await engine.complete(run.id, 'file', { requestId: run.pending.form.id, text: '新文档', file: { name: '新.md', size: 9 } });
  run = await engine.resume(run.id);
  assert.equal(run.iterations.loop, 1);
  assert.equal(run.pending.kind, 'loop');
});

test('文件重选保留总轮数额度，到限后同一运行不能重选清零', async t => {
  const { engine, create } = await fixture(t);
  const workflow = { id: crypto.randomUUID(), name: '文件评审总上限', nodes: [
    node('file', 'flow.user-input', { interaction: 'file' }), node('review', 'agent.review', { input: '{{file.text}}' }),
    node('loop', 'flow.loop', { input: '{{file.text}}', operator: 'not-empty', maxIterations: 2, maxTotalIterations: 3 }),
    node('end', 'flow.end')], edges: [{ from: 'file', to: 'review' }, { from: 'review', to: 'loop' },
    { from: 'loop', to: 'review', branch: 'continue' }, { from: 'loop', to: 'end', branch: 'exit' }] };
  let calls = 0;
  const respond = async () => { calls++; return { state: 'succeeded', output: '需要修订' }; };
  engine.agents.run = respond;
  let run = await settle(engine, (await engine.start(workflow)).id);
  await engine.complete(run.id, 'file', { requestId: run.pending.form.id, text: '旧文档', file: { name: '旧.md', size: 9 } });
  await engine.resume(run.id);
  run = await engine.resume(run.id);
  assert.equal(run.iterations.loop, 2);
  run = await engine.reselectFile(run.id, 'file');
  await engine.complete(run.id, 'file', { requestId: run.pending.form.id, text: '新文档', file: { name: '新.md', size: 9 } });
  run = await engine.resume(run.id);
  assert.equal(run.pending.reason, 'total-limit');
  assert.equal(run.iterations.loop, 3);
  assert.equal(calls, 3);
  await assert.rejects(engine.reselectFile(run.id, 'file'), { code: 'LOOP_TOTAL_LIMIT' });
  assert.equal(engine.get(run.id).pending.reason, 'total-limit');
  await engine.interrupt(run.id);
  const restarted = create();
  await restarted.restore(workflow.id);
  await assert.rejects(restarted.reselectFile(run.id, 'file'), { code: 'LOOP_TOTAL_LIMIT' });
});

test('已通过并绕过循环判断的阶段，重选文件仍消耗原总轮数', async t => {
  const { engine } = await fixture(t);
  engine.agents.run = async () => ({ state: 'succeeded', output: '{"passed":true}' });
  const workflow = { id: crypto.randomUUID(), name: '通过阶段重选', nodes: [
    node('file', 'flow.user-input', { interaction: 'file' }),
    node('review', 'agent.review', { input: '{{file.text}}', outputFields: '{"passed":"boolean"}' }),
    node('route', 'flow.route', { input: '{{review.output.passed}}', expected: 'true' }),
    node('loop', 'flow.loop', { input: '{{file.text}}', operator: 'not-empty', maxIterations: 5, maxTotalIterations: 2 }),
    node('pause', 'flow.user-input', { prompt: '继续？' })], edges: [{ from: 'file', to: 'review' },
    { from: 'review', to: 'route' }, { from: 'route', to: 'pause', branch: 'true' },
    { from: 'route', to: 'loop', branch: 'false' }, { from: 'loop', to: 'review', branch: 'continue' },
    { from: 'loop', to: 'pause', branch: 'exit' }] };
  let run = await settle(engine, (await engine.start(workflow)).id);
  for (let round = 1; round <= 2; round++) {
    await engine.complete(run.id, 'file', { requestId: run.pending.form.id, text: `文档${round}`, file: { name: '需求.md', size: 9 } });
    run = await engine.resume(run.id);
    assert.equal(run.pending.nodeId, 'pause');
    assert.equal(run.iterations.loop, round);
    if (round === 1) { run = await engine.reselectFile(run.id, 'file'); }
  }
  await assert.rejects(engine.reselectFile(run.id, 'file'), { code: 'LOOP_TOTAL_LIMIT' });
});

test('重新选择等待旧任务收尾时，再次中断仍然生效', async t => {
  const { engine } = await fixture(t);
  const workflow = flow([node('file', 'flow.user-input', { interaction: 'file' }), node('agent', 'agent.review', { input: '{{file.text}}' })]);
  let run = await settle(engine, (await engine.start(workflow)).id);
  run = await engine.complete(run.id, 'file', { requestId: run.pending.form.id, text: '旧文档', file: { name: '旧.md', size: 9 } });
  await engine.interrupt(run.id);
  let finishCancel;
  let cancelStarted;
  const started = new Promise(resolve => { cancelStarted = resolve; });
  engine.agents.cancel = async () => {
    cancelStarted();
    await new Promise(resolve => { finishCancel = resolve; });
  };
  const editing = engine.reselectFile(run.id, 'file');
  await started;
  await engine.interrupt(run.id);
  finishCancel();
  await editing;
  assert.equal(engine.get(run.id).status, 'interrupted');
  assert.equal(engine.get(run.id).nodes.file.status, 'succeeded');
  engine.agents.cancel = async () => {};
});
