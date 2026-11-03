import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Engine } from '../../../plugin-dev/work-flow/src/main/common/engine.js';
import { Runs } from '../../../plugin-dev/work-flow/src/main/common/runs.js';
import { Workflows } from '../../../plugin-dev/work-flow/src/main/common/workflows.js';
import { WorkflowTransfer } from '../../../plugin-dev/work-flow/src/main/common/workflow-transfer.js';
import { createRegistry } from '../../../plugin-dev/work-flow/src/main/common/nodes.js';

const document = JSON.parse(await readFile(new URL('./requirements-design-review.workflow.json', import.meta.url), 'utf8'));
const draft = { requirements: '固定需求', design: '设计初稿', changes: [], decisions: [], coverage: ['REQ-01 待核对'] };
const revision = { ...draft, design: `完整修订方案${'修订正文'.repeat(1500)}修订结束`, changes: ['DEV-01 已解决'], decisions: ['保留历史'] };
const passed = { passed: true, summary: '通过', issues: [], questions: [] };
const failed = { ...passed, passed: false, issues: ['DEV-01 补充异常分支'] };
const confirmRound = '确认结论，继续流程';

// Only the external model is stubbed; import validation, scheduling, routing, loop snapshots and file writes are real.
async function fixture(t, firstReview = passed, initialDraft = draft, revisedDraft = revision) {
  const storage = await temporaryStore(t);
  const registry = createRegistry({ credentials: {} });
  const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: type => registry.list().find(item => item.type === type) });
  const transfer = new WorkflowTransfer({ workflows, types: () => registry.list(), activeRun: () => false, logger: () => {} });
  const workflow = (await transfer.import({ document })).workflow;
  const calls = [];
  const counts = {};
  const agents = { cancel: async () => {}, run: async (request, { nodeId }) => {
    const count = counts[nodeId] = (counts[nodeId] || 0) + 1;
    calls.push({ nodeId, count, prompt: request.prompt });
    let output = passed;
    if (nodeId === 'coordinator') { output = count === 1 ? initialDraft : revisedDraft; }
    if (nodeId === 'development-revision') { output = revisedDraft; }
    if (nodeId === 'development' && count === 1) { output = firstReview; }
    if (nodeId === 'decision') {
      output = { route: firstReview.questions.length && count === 1 ? 'clarify' : 'aligned',
        summary: '本轮汇总', issues: count === 1 ? firstReview.issues : [], questions: count === 1 ? firstReview.questions : [] };
    }
    return { state: 'succeeded', output: JSON.stringify(output) };
  } };
  const engine = new Engine({ registry, runs: new Runs({ storage, pluginId: 'work-flow' }), credentials: {}, agents,
    emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
  t.after(() => engine.stop('test'));
  const run = await engine.start(workflow);
  await engine.active.get(run.id).task;
  async function submit(text, file) {
    const pending = engine.records.get(run.id).pending;
    await engine.complete(run.id, pending.nodeId, { requestId: pending.request.form.id, text, ...(file ? { file } : {}) });
    return drive(engine, run.id);
  }
  await submit('固定需求', { name: '需求.md', size: 12 });
  await submit(initialDraft.design, { name: '设计.md', size: Buffer.byteLength(initialDraft.design) });
  return { engine, id: run.id, calls, counts, storage, submit };
}

async function drive(engine, id) {
  for (let index = 0; index < 60; index += 1) {
    const run = engine.get(id);
    assert.notEqual(run.status, 'failed', JSON.stringify(run.error));
    if (run.status !== 'waiting' || run.pending.kind !== 'service') { return run; }
    await engine.resume(id);
  }
  assert.fail('流程未到达预期等待节点');
}

function assertRevisionCycle(f) {
  assert.equal(f.engine.get(f.id).pending.nodeId, 'round-review');
  assert.equal(f.counts['development-revision'], 1, '不通过必须先由研发 Agent 修订');
  const author = f.calls.findIndex(call => call.nodeId === 'development-revision');
  const coordinator = f.calls.findIndex(call => call.nodeId === 'coordinator' && call.count === 2);
  assert.ok(author < coordinator);
  assert.match(f.calls[author].prompt, /固定需求/);
  assert.match(f.calls[author].prompt, /设计初稿/);
  assert.match(f.calls[coordinator].prompt, /修订结束/);
  assert.match(f.calls[coordinator].prompt, /保留历史/);
  assert.ok(f.calls.filter(call => ['product', 'architecture', 'development', 'testing'].includes(call.nodeId)
    && call.count === 2).every(call => call.prompt.includes('修订结束')));
}

test('角色不通过、用户确认：研发修订后交协调 Agent 开始下一轮，最终导出完整修订稿', async t => {
  const f = await fixture(t, failed);
  assert.equal(f.counts['development-revision'], undefined, '用户审核前不能提前修订');
  await f.submit(confirmRound);
  assertRevisionCycle(f);
  assert.match(f.calls.find(call => call.nodeId === 'development-revision').prompt, /DEV-01/);
  const run = await f.submit(confirmRound);
  assert.equal(run.pending.nodeId, 'destination');
  assert.equal(f.counts['development-revision'], 1);
  const directory = join(f.storage.root, 'output');
  assert.equal((await f.submit(directory)).status, 'succeeded');
  assert.equal(await readFile(join(directory, '需求基准.md'), 'utf8'), '固定需求');
  assert.equal(await readFile(join(directory, '研发设计修订稿.md'), 'utf8'), revision.design);
});

test('角色全部通过、用户不通过：研发收到用户修改意见，再全员复审', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit('提出修改意见，重新评审')).pending.nodeId, 'round-feedback');
  await f.submit('增加离线恢复场景');
  assertRevisionCycle(f);
  assert.match(f.calls.find(call => call.nodeId === 'development-revision').prompt, /增加离线恢复场景/);
});

test('需要业务澄清：先逐题答复，研发收到回答后修订，再交协调 Agent', async t => {
  const f = await fixture(t, { ...failed, questions: ['是否保留历史？'] });
  const run = await f.submit(confirmRound);
  assert.equal(run.pending.nodeId, 'clarification');
  assert.equal(f.counts['development-revision'], undefined);
  const interaction = run.pending.interaction;
  await f.engine.answer(f.id, { batchId: interaction.id, questionId: interaction.questions[0].id, text: '保留历史，便于审计' });
  await drive(f.engine, f.id);
  assertRevisionCycle(f);
  assert.match(f.calls.find(call => call.nodeId === 'development-revision').prompt, /保留历史，便于审计/);
});

test('首轮全通过及人工结束均不调用修订 Agent', async t => {
  for (const answer of [confirmRound, '结束审核，保留分歧']) {
    const f = await fixture(t);
    const run = await f.submit(answer);
    assert.equal(run.pending.nodeId, 'destination');
    assert.equal(f.counts['development-revision'], undefined);
    assert.equal(f.counts.coordinator, 1);
  }
});

test('三轮长文评审只传一份当前稿，不重复原稿或历史全文，运行记录仍保留原文', async t => {
  const original = { ...draft, design: `原稿标记${'原文'.repeat(10000)}` };
  const current = { ...revision, design: `当前稿标记${'正文'.repeat(15000)}` };
  const f = await fixture(t, passed, original, current);
  for (let index = 0; index < 2; index += 1) {
    await f.submit('提出修改意见，重新评审');
    await f.submit('保留历史，增加异常恢复设计');
  }
  assert.equal(f.counts.coordinator, 3);
  const consumers = ['coordinator', 'product', 'architecture', 'development', 'testing', 'development-revision'];
  for (const call of f.calls.filter(item => consumers.includes(item.nodeId))) {
    const usesCurrent = call.count > 1;
    const text = usesCurrent ? current.design : original.design;
    assert.equal(call.prompt.split(text).length - 1, 1, `${call.nodeId} 第${call.count}轮重复全文`);
    if (usesCurrent) { assert.ok(!call.prompt.includes(original.design), `${call.nodeId} 仍携带原稿`); }
  }
  const second = f.calls.find(call => call.nodeId === 'coordinator' && call.count === 2);
  const third = f.calls.find(call => call.nodeId === 'coordinator' && call.count === 3);
  assert.equal(second.prompt.length, third.prompt.length, '历史轮次不应叠加到下一轮输入');
  const record = f.engine.records.get(f.id);
  const stored = (await f.engine.runs.list(record.workflowId, { checkpoints: true })).find(run => run.id === f.id);
  assert.equal(stored.checkpoint.outputs.design.text, original.design, '原稿应完整保留在持久化检查点');
  assert.equal(stored.checkpoint.loopContext.previous['development-revision'].output.design, current.design);
});
