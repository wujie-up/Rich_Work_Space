import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Engine } from '../src/main/common/engine.js';
import { Runs } from '../src/main/common/runs.js';
import { Credentials } from '../src/main/common/credentials.js';
import { createAgents } from '../src/main/common/agents.js';
import { createRegistry } from '../src/main/common/nodes.js';

const PLUGIN_ID = 'work-flow';

async function harness(t, { agents = createAgents({ tasks: { providers: async () => [] } }) } = {}) {
  let cleanup;
  const storage = await temporaryStore({ after: handler => { cleanup = handler; } });
  const credentials = new Credentials({ storage, pluginId: PLUGIN_ID });
  const runs = new Runs({ storage, pluginId: PLUGIN_ID });
  const events = [];
  const engine = new Engine({ runs, credentials, agents, pluginId: PLUGIN_ID, logger: () => {}, now: () => Date.now(),
    emit: (channel, value) => events.push({ channel, value }), registry: createRegistry({ credentials }) });
  t.after(async () => { await engine.stop('test'); await cleanup(); });
  return { engine, runs, credentials, events };
}

const node = (id, type, params = {}) => ({ id, type, title: id, x: 0, y: 0, params });
const workflow = (nodes, edges = []) => ({ id: crypto.randomUUID(), name: 'demo', nodes, edges });

async function settled(engine, runId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (engine.get(runId).status !== 'running') {
      // State changes precede the final disk write; assertions against history must await that write too.
      await engine.active.get(runId).task;
      return engine.get(runId);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('等待运行结束超时');
}

test('节点按拓扑顺序执行，输出通过模板变量向后传递', async t => {
  const { engine, runs, events } = await harness(t);
  const edges = [{ from: 'source', to: 'collect' }];
  const target = workflow([node('source', 'text.input', { content: '服务响应超时' }),
    node('collect', 'result.collect', { input: '{{source.text}}', title: '汇总' })], edges);
  const started = await engine.start(target);
  const run = await settled(engine, started.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.collect.status, 'succeeded');
  assert.match(run.nodes.collect.output.report, /服务响应超时/);
  assert.equal((await runs.list(target.id)).length, 1);
  assert.ok(events.length >= 3);
  assert.equal(events[0].channel, 'runs.changed');
});

test('数组与对象变量保持原始类型传入下游，而不是被转成 JSON 字符串', async t => {
  const { engine } = await harness(t);
  const content = JSON.stringify([{ text: 'INFO 心跳正常' }, { text: 'ERROR 数据库连接池耗尽' }]);
  const target = workflow([node('source', 'text.input', { content, format: 'json' }),
    node('extract', 'log.extract', { input: '{{source.value}}', keywords: 'ERROR' }),
    node('collect', 'result.collect', { title: '汇总', input: '{{extract.report}}' })],
  [{ from: 'source', to: 'extract' }, { from: 'extract', to: 'collect' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.nodes.extract.output.matches, ['ERROR 数据库连接池耗尽']);
  assert.match(run.nodes.collect.output.report, /ERROR 数据库连接池耗尽/);
});

test('条件节点不通过时跳过下游节点', async t => {
  const { engine } = await harness(t);
  const target = workflow([node('source', 'text.input', { content: '' }),
    node('gate', 'flow.gate', { input: '{{source.text}}' }), node('collect', 'result.collect', {})],
  [{ from: 'source', to: 'gate' }, { from: 'gate', to: 'collect' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.nodes.gate.output.passed, false);
  assert.equal(run.nodes.collect.status, 'skipped');
});

test('条件节点通过时继续执行下游', async t => {
  const { engine } = await harness(t);
  const target = workflow([node('source', 'text.input', { content: 'ERROR 连接失败' }),
    node('gate', 'flow.gate', { input: '{{source.text}}', mode: 'contains', value: 'ERROR' }),
    node('collect', 'result.collect', {})],
  [{ from: 'source', to: 'gate' }, { from: 'gate', to: 'collect' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  assert.equal(run.nodes.gate.output.passed, true);
  assert.equal(run.nodes.collect.status, 'succeeded');
});

test('循环依赖在运行前被拒绝', async t => {
  const { engine } = await harness(t);
  const target = workflow([node('a', 'text.input'), node('b', 'result.collect')],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
  await assert.rejects(engine.start(target), { code: 'WORKFLOW_CYCLE' });
});

test('节点失败会终止运行并跳过剩余节点', async t => {
  const { engine } = await harness(t);
  const target = workflow([node('source', 'text.input', { content: '{bad', format: 'json' }), node('collect', 'result.collect')],
    [{ from: 'source', to: 'collect' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'INVALID_JSON');
  assert.equal(run.nodes.collect.status, 'skipped');
});

test('Agent 节点暂停等待，由界面发起的 resume 完成服务调用', async t => {
  let received = null;
  const { engine } = await harness(t, { agents: { run: async request => { received = request;
    return { state: 'succeeded', output: '根因：连接池耗尽', provider: 'ai-agent-sessions' }; } } });
  const target = workflow([node('source', 'text.input', { content: 'ERROR timeout' }),
    node('review', 'agent.review', { input: '{{source.text}}', instructions: '请分析：' }),
    node('collect', 'result.collect', { input: '{{review.output}}' })],
  [{ from: 'source', to: 'review' }, { from: 'review', to: 'collect' }]);
  const started = await engine.start(target);
  const paused = await settled(engine, started.id);
  assert.equal(paused.status, 'waiting');
  assert.equal(paused.nodes.review.status, 'waiting');
  assert.equal(await engine.get(paused.id).nodes.collect, undefined);
  const resumed = await engine.resume(paused.id);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.nodes.review.output.provider, 'ai-agent-sessions');
  assert.match(resumed.nodes.review.output.output, /连接池耗尽/);
  assert.match(resumed.nodes.collect.output.report, /连接池耗尽/);
  assert.match(received.prompt, /请分析：[\s\S]*ERROR timeout/);
  await assert.rejects(engine.resume(paused.id), { code: 'RUN_NOT_WAITING' });
});

test('缺少 Agent 提供方时 resume 让节点明确失败', async t => {
  const { engine } = await harness(t, {});
  const target = workflow([node('source', 'text.input', { content: 'ERROR timeout' }),
    node('review', 'agent.review', { input: '{{source.text}}' }), node('collect', 'result.collect')],
  [{ from: 'source', to: 'review' }, { from: 'review', to: 'collect' }]);
  const paused = await settled(engine, (await engine.start(target)).id);
  assert.equal(paused.status, 'waiting');
  const failed = await engine.resume(paused.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'AGENT_PROVIDER_MISSING');
  assert.equal(failed.nodes.collect.status, 'skipped');
});

test('等待服务调用期间取消运行会归档', async t => {
  const { engine } = await harness(t, {});
  const target = workflow([node('source', 'text.input', { content: 'ERROR timeout' }),
    node('review', 'agent.review', { input: '{{source.text}}' })], [{ from: 'source', to: 'review' }]);
  const paused = await settled(engine, (await engine.start(target)).id);
  assert.equal(await engine.cancel(paused.id), true);
  const run = await engine.get(paused.id);
  assert.equal(run.status, 'canceled');
  assert.equal(run.nodes.review.status, 'skipped');
  const stored = await engine.runs.list(target.id);
  assert.equal(stored[stored.length - 1].pending, null);
});

test('停止时等待运行任务结束并归档，等待中的运行一并取消', async t => {
  const { engine } = await harness(t, {});
  const target = workflow([node('source', 'text.input', { content: 'x' }),
    node('review', 'agent.review', { input: '{{source.text}}' }), node('collect', 'result.collect')],
  [{ from: 'source', to: 'review' }, { from: 'review', to: 'collect' }]);
  const paused = await settled(engine, (await engine.start(target)).id);
  assert.equal(engine.snapshot().length, 1);
  await engine.stop('disable');
  assert.equal(engine.snapshot().length, 0);
  const stored = await engine.runs.list(target.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'canceled');
  assert.equal(stored[0].error.code, 'PLUGIN_STOPPED');
  assert.equal(stored[0].nodes.collect.status, 'skipped');
  assert.equal(paused.status, 'waiting');
});

test('运行历史按工作流上限保留并写入存储', async t => {
  const { engine } = await harness(t);
  const target = workflow([node('source', 'text.input', { content: 'a' })]);
  for (let round = 0; round < 3; round += 1) {
    await settled(engine, (await engine.start(target)).id);
  }
  const stored = await engine.runs.list(target.id);
  assert.equal(stored.length, 3);
  assert.equal(stored[2].status, 'succeeded');
});

test('人工节点只能显式确认，重复确认与服务自动恢复被拒绝', async t => {
  const { engine } = await harness(t);
  const original = engine.registry;
  let confirms = 0;
  const manual = { type: 'test.manual', manual: true, timeoutMs: 1000,
    prepare: async () => ({ stage: 'tree' }), confirm: async input => { confirms++; return { confirmed: input.revision }; } };
  engine.registry = { ...original, get: id => id === manual.type ? manual : original.get(id) };
  const target = workflow([node('wait', manual.type), node('end', 'flow.end')], [{ from: 'wait', to: 'end' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  assert.equal(run.pending.kind, 'manual');
  await assert.rejects(engine.resume(run.id), /人工/);
  const result = await engine.complete(run.id, 'wait', { revision: 2 });
  assert.equal(result.status, 'succeeded');
  assert.equal(confirms, 1);
  await assert.rejects(engine.complete(run.id, 'wait', { revision: 2 }), /等待/);
});


test('Agent 长任务分多次短请求推进，问题等待不执行下游', async t => {
  let response;
  let state = { state: 'running', requests: [{ id: 'q1', method: 'item/tool/requestUserInput', params: {} }] };
  const { engine } = await harness(t, { agents: { run: async () => state,
    respond: async (request, input) => { response = input; } } });
  const target = workflow([node('source', 'text.input', { content: '素材' }),
    node('review', 'agent.review', { input: '{{source.text}}' }), node('end', 'flow.end')],
  [{ from: 'source', to: 'review' }, { from: 'review', to: 'end' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  const waiting = await engine.resume(run.id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.pending.task.requests[0].id, 'q1');
  assert.equal(waiting.nodes.end, undefined);
  await engine.respond(run.id, { requestId: 'q1', answers: { context: '订单' } });
  assert.equal(response.requestId, 'q1');
  state = { state: 'succeeded', output: '处理完成', provider: 'ai' };
  const done = await engine.resume(run.id);
  assert.equal(done.status, 'succeeded');
  assert.match(done.nodes.end.output.final, /处理完成/);
});

test('并发轮询只推进一次，停止后迟到 Agent 结果不能恢复工作流', async t => {
  let resolve;
  let calls = 0;
  let cancelled = 0;
  const { engine } = await harness(t, { agents: {
    run: async () => { calls++; return new Promise(done => { resolve = done; }); },
    cancel: async () => { cancelled++; }
  } });
  const target = workflow([node('review', 'agent.review', { input: '素材' }), node('end', 'flow.end')],
    [{ from: 'review', to: 'end' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  const pending = engine.resume(run.id);
  assert.equal((await engine.resume(run.id)).status, 'waiting');
  assert.equal(calls, 1);
  await engine.cancel(run.id);
  resolve({ state: 'succeeded', output: '迟到结果', provider: 'ai' });
  assert.equal((await pending).status, 'canceled');
  assert.equal(cancelled, 1);
  assert.equal(engine.get(run.id).nodes.end.status, 'skipped');
});

test('Agent 节点准备期间停止，不会重新进入等待或执行下游', async t => {
  const { engine } = await harness(t);
  let release;
  let entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  const original = engine.runs.append.bind(engine.runs);
  engine.runs.append = async run => {
    if (run.nodes.review?.status === 'running') {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return original(run);
  };
  const target = workflow([node('review', 'agent.review', { input: '素材' }), node('end', 'flow.end')],
    [{ from: 'review', to: 'end' }]);
  const run = await engine.start(target);
  await preparing;
  await engine.cancel(run.id);
  release();
  await engine.active.get(run.id).task;
  assert.equal(engine.get(run.id).status, 'canceled');
  assert.equal(engine.get(run.id).pending, null);
  assert.equal(engine.get(run.id).nodes.end.status, 'skipped');
});

test('Agent 失败清理期间停止，迟到的失败不会覆盖取消结果', async t => {
  let release;
  let entered;
  let cancels = 0;
  const cleaning = new Promise(resolve => { entered = resolve; });
  const { engine } = await harness(t, { agents: {
    run: async () => { throw Error('提供方已退出'); },
    cancel: async () => {
      if (++cancels === 1) {
        entered();
        await new Promise(resolve => { release = resolve; });
        throw Error('清理请求已失效');
      }
    }
  } });
  const target = workflow([node('review', 'agent.review', { input: '素材' }), node('end', 'flow.end')],
    [{ from: 'review', to: 'end' }]);
  const run = await settled(engine, (await engine.start(target)).id);
  const resuming = engine.resume(run.id);
  await cleaning;
  await engine.cancel(run.id);
  release();
  assert.equal((await resuming).status, 'canceled');
  assert.equal(engine.get(run.id).nodes.end.status, 'skipped');
});

test('消息事件要求真实输入，预生成ID/origin，完整模板，仅执行指定入口', async t => {
  const { engine } = await harness(t);
  const target = workflow([node('message', 'message.wechat', { connectionId: 'wx' }),
    node('other', 'text.input', { content: '不应执行' }), node('collect', 'result.collect', { input: '{{message.text}}' })],
  [{ from: 'message', to: 'collect' }]);
  await assert.rejects(engine.start(target), { code: 'MESSAGE_EVENT_REQUIRED' });
  const message = { channel: 'wechat', connectionId: 'wx', messageId: 'm1', chat: { id: 'g', type: 'group' },
    sender: { id: 'u' }, text: 'x'.repeat(5000), sentAt: 1, receivedAt: 2 };
  const run = await settled(engine, (await engine.start(target, { runId: 'claimed-id', entryNodeId: 'message', message })).id);
  assert.equal(run.id, 'claimed-id');
  assert.deepEqual(run.origin, { kind: 'message', connectionId: 'wx', messageId: 'm1', entryNodeId: 'message' });
  assert.equal(run.input.text.length, 5000);
  assert.equal(run.nodes.other.status, 'skipped');
  assert.match(run.nodes.collect.output.report, /x{3000}/);
});


test('首次运行落盘失败撤销内存状态，恢复后允许下一次运行', async t => {
  const { engine, runs } = await harness(t);
  const target = workflow([node('source', 'text.input', { content: 'hello' })]);
  const append = runs.append.bind(runs);
  runs.append = async () => { throw Error('disk unavailable'); };
  await assert.rejects(engine.start(target));
  assert.equal(Boolean(engine.activeRun(target.id)), false);
  assert.equal(engine.active.size, 0);
  assert.equal(engine.records.size, 0);
  runs.append = append;
  assert.equal((await settled(engine, (await engine.start(target)).id)).status, 'succeeded');
});
