import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Engine } from '../src/main/common/engine.js';
import { Runs } from '../src/main/common/runs.js';
import { createRegistry } from '../src/main/common/nodes.js';
import { Workflows } from '../src/main/common/workflows.js';
import { documentReviewTemplate, ensureDocumentReviewTemplate } from '../src/main/common/document-review-template.js';

const approved = { passed: true, summary: '审核通过', issues: [], questions: [] };
const draft = { requirements: '需求原文', design: '设计原文', changes: [], decisions: [], coverage: ['REQ-01 | 需求原文 | 设计第1节 | 已覆盖 | 验收场景1'] };
const aligned = { route: 'aligned', summary: '四方对齐', issues: [], questions: [] };

function round({ revision = draft, reviews = [], decision = aligned } = {}) {
  return [revision, ...Array.from({ length: 4 }, (_, index) => reviews[index] || approved), decision].map(JSON.stringify);
}

async function fixture(t, outputs = []) {
  const storage = await temporaryStore(t);
  const calls = [];
  const agents = { run: async request => {
    calls.push(structuredClone(request));
    assert.ok(outputs.length, '模板不应意外重复调用 Agent');
    return { state: 'succeeded', output: outputs.shift(), provider: 'test-agent' };
  }, cancel: async () => {} };
  const registry = createRegistry({ credentials: {} });
  const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: type => registry.list().find(item => item.type === type) });
  const engine = new Engine({ registry, runs: new Runs({ storage, pluginId: 'work-flow' }), credentials: {}, agents,
    emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
  t.after(() => engine.stop('test'));
  return { storage, workflows, engine, calls };
}

async function confirm(engine, run, text, file) {
  return engine.complete(run.id, run.pending.nodeId, { requestId: run.pending.form.id, text, ...(file ? { file } : {}) });
}

async function startReview(engine, workflows) {
  const saved = await workflows.save(documentReviewTemplate());
  let run = await engine.start(saved);
  await engine.active.get(run.id).task;
  run = await confirm(engine, engine.get(run.id), '需求原文', { name: '需求.md', size: 12 });
  return confirm(engine, run, '设计原文', { name: '设计.md', size: 12 });
}

async function finishAgents(engine, run) {
  while (run.status === 'waiting' && run.pending.kind === 'service') {
    run = await engine.resume(run.id);
  }
  assert.notEqual(run.status, 'failed', JSON.stringify(run.error));
  return run;
}

test('首次导入保留已有工作流，定制或删除后不被重建，保存失败可重试', async t => {
  const { storage, workflows } = await fixture(t);
  const original = await workflows.save({ id: 'existing', name: '已有流程', nodes: [
    { id: 'source', type: 'text.input', title: '文本', x: 0, y: 0, params: { content: '原有内容' } }
  ], edges: [] });
  const options = { storage, workflows, pluginId: 'work-flow', logger: () => {} };
  await ensureDocumentReviewTemplate(options);
  assert.deepEqual(await workflows.read(original.id), original);
  const target = documentReviewTemplate();
  await workflows.save({ ...target, name: '我的审核模板' });
  await ensureDocumentReviewTemplate(options);
  assert.equal((await workflows.read(target.id)).name, '我的审核模板');
  await workflows.remove(target.id);
  await ensureDocumentReviewTemplate(options);
  assert.deepEqual((await workflows.list()).map(item => item.id), ['existing']);

  const fresh = await fixture(t);
  const retry = { ...options, storage: fresh.storage, workflows: fresh.workflows };
  await assert.rejects(ensureDocumentReviewTemplate({ ...retry, workflows: {
    list: () => fresh.workflows.list(), save: async () => { throw Error('disk full'); }
  } }), /disk full/);
  await ensureDocumentReviewTemplate(retry);
  assert.equal((await fresh.workflows.list()).length, 1);
});

test('首次导入也保留已经存在的同名模板修改', async t => {
  const { storage, workflows } = await fixture(t);
  const custom = await workflows.save({ ...documentReviewTemplate(), name: '保留用户修改' });
  await ensureDocumentReviewTemplate({ storage, workflows, pluginId: 'work-flow', logger: () => {} });
  assert.deepEqual(await workflows.read(custom.id), custom);
});

test('审核以原始需求为基准，导出完整设计和对应关系，不采用 Agent 改写的需求', async t => {
  const revision = { ...draft, requirements: '需'.repeat(6000), design: '设'.repeat(6500) };
  const { engine, workflows, calls } = await fixture(t, round({ revision }));
  let run = await finishAgents(engine, await startReview(engine, workflows));
  assert.equal(run.pending.nodeId, 'round-review');
  assert.equal(run.nodes.aligned, undefined);
  assert.equal(calls.length, 6);
  run = await confirm(engine, run, '确认结论，继续流程');
  assert.equal(run.pending.nodeId, 'destination');
  assert.equal(run.nodes.aligned.status, 'succeeded');
  assert.equal(run.nodes.unresolved.status, 'skipped');
  assert.equal(calls.length, 6);
  assert.ok(calls.slice(1, 5).every(call => call.prompt.includes(revision.design)));
  const directory = await mkdtemp(join(tmpdir(), 'document-review-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  run = await confirm(engine, run, directory);
  assert.equal(run.status, 'succeeded');
  assert.equal(await readFile(join(directory, '需求基准.md'), 'utf8'), '需求原文');
  assert.equal(await readFile(join(directory, '研发设计修订稿.md'), 'utf8'), revision.design);
  const report = await readFile(join(directory, '审核报告.md'), 'utf8');
  assert.match(report, /审核通过/);
  assert.match(report, /REQ-01/);
  assert.match(run.nodes['round-review'].output.text, /确认结论/);
  assert.ok(calls.slice(1, 5).every(call => call.prompt.includes('需求原文')));
  assert.match(calls[0].prompt, /不得改写需求/);
});

test('协调 Agent 错报对齐不能越过失败角色，修订携带上一轮反馈', async t => {
  const failed = { ...approved, passed: false, summary: '未通过', issues: ['ARCH-01 缺少失败重试设计'] };
  const { engine, workflows, calls } = await fixture(t, [
    ...round({ reviews: [approved, failed] }), ...round({ revision: { ...draft, changes: ['补充重试设计'] } })
  ]);
  let run = await finishAgents(engine, await startReview(engine, workflows));
  assert.equal(run.pending.nodeId, 'round-review');
  assert.equal(calls.length, 6);
  run = await finishAgents(engine, await confirm(engine, run, '确认结论，继续流程'));
  assert.equal(run.pending.nodeId, 'round-review');
  assert.equal(run.iterations.loop, 2);
  run = await confirm(engine, run, '确认结论，继续流程');
  assert.equal(run.pending.nodeId, 'destination');
  assert.match(calls[6].prompt, /ARCH-01/);
  assert.equal(run.nodes.requirements.status, 'succeeded');
  assert.equal(run.nodes.design.status, 'succeeded');
});

test('需求取舍逐题确认，全部回答后带入修订和复审', async t => {
  const questions = ['离线使用还是联网使用？', '是否保留操作历史？'];
  const { engine, workflows, calls } = await fixture(t, [
    ...round({ reviews: [{ ...approved, passed: false, questions }],
      decision: { route: 'clarify', summary: '需要需求取舍', issues: [], questions } }), ...round()
  ]);
  let run = await finishAgents(engine, await startReview(engine, workflows));
  assert.equal(run.pending.nodeId, 'round-review');
  run = await confirm(engine, run, '确认结论，继续流程');
  assert.equal(run.pending.nodeId, 'clarification');
  for (const [index, text] of ['离线使用', '保留历史'].entries()) {
    const batch = run.pending.interaction;
    assert.equal(batch.currentIndex, index);
    run = await engine.answer(run.id, { batchId: batch.id, questionId: batch.questions[index].id, text });
    assert.equal(calls.length, 6);
  }
  run = await finishAgents(engine, run);
  assert.equal(run.pending.nodeId, 'round-review');
  run = await confirm(engine, run, '确认结论，继续流程');
  assert.equal(run.pending.nodeId, 'destination');
  assert.match(calls[6].prompt, /离线使用/);
  assert.match(calls[6].prompt, /保留历史/);
});

test('三轮仍未对齐暂停；人工退出报告明确未通过', async t => {
  const rejected = { ...approved, passed: false, issues: ['TEST-01 缺少验收标准'] };
  const outputs = Array.from({ length: 3 }, () => round({ reviews: [approved, approved, approved, rejected],
    decision: { ...aligned, route: 'revise' } })).flat();
  const { engine, workflows, calls } = await fixture(t, outputs);
  let run = await finishAgents(engine, await startReview(engine, workflows));
  for (let round = 1; round <= 3; round += 1) {
    assert.equal(run.pending.nodeId, 'round-review');
    assert.equal(calls.length, round * 6);
    run = await finishAgents(engine, await confirm(engine, run, '确认结论，继续流程'));
  }
  assert.equal(run.pending.kind, 'loop');
  assert.equal(calls.length, 18);
  run = await engine.decideLoop(run.id, 'exit');
  assert.equal(run.pending.nodeId, 'destination');
  assert.equal(run.nodes.aligned.status, 'skipped');
  assert.match(run.nodes.unresolved.output.report, /未通过/);
});

test('三轮后允许继续全员复审，通过后再导出', async t => {
  const rejected = { ...approved, passed: false, issues: ['DEV-01 接口不一致'] };
  const outputs = Array.from({ length: 3 }, () => round({ reviews: [approved, approved, rejected],
    decision: { ...aligned, route: 'revise' } })).flat();
  const { engine, workflows, calls } = await fixture(t, [...outputs, ...round()]);
  let run = await finishAgents(engine, await startReview(engine, workflows));
  for (let round = 1; round <= 3; round += 1) {
    assert.equal(run.pending.nodeId, 'round-review');
    assert.equal(calls.length, round * 6);
    run = await finishAgents(engine, await confirm(engine, run, '确认结论，继续流程'));
  }
  assert.equal(run.pending.kind, 'loop');
  run = await finishAgents(engine, await engine.decideLoop(run.id, 'continue'));
  assert.equal(calls.length, 24);
  assert.equal(run.pending.nodeId, 'round-review');
  run = await confirm(engine, run, '确认结论，继续流程');
  assert.equal(run.pending.nodeId, 'destination');
  assert.equal(run.nodes.aligned.status, 'succeeded');
});


test('每轮全员通过仍需人工认可；用户修改意见带入下一轮', async t => {
  const { engine, workflows, calls } = await fixture(t, [...round(), ...round()]);
  let run = await finishAgents(engine, await startReview(engine, workflows));
  assert.equal(run.pending.nodeId, 'round-review');
  assert.equal(calls.length, 6);
  assert.match(run.pending.form.prompt, /四方对齐/);
  run = await confirm(engine, run, '提出修改意见，重新评审');
  assert.equal(run.pending.nodeId, 'round-feedback');
  assert.equal(calls.length, 6);
  run = await finishAgents(engine, await confirm(engine, run, '补充离线验收场景，保持原有范围'));
  assert.equal(run.pending.nodeId, 'round-review');
  assert.match(calls[6].prompt, /补充离线验收场景/);
  assert.equal(calls.length, 12);
  run = await confirm(engine, run, '结束审核，保留分歧');
  assert.equal(run.pending.nodeId, 'destination');
  assert.match(run.nodes.unresolved.output.report, /未通过/);
  assert.equal(run.nodes.aligned.status, 'skipped');
});

function legacyTemplate() {
  const current = documentReviewTemplate();
  const added = ['review-parallel', 'review-join', 'round-review', 'round-action', 'round-feedback'];
  return { ...current, nodes: current.nodes.filter(node => !added.includes(node.id)), edges: [
    ...current.edges.filter(edge => !added.includes(edge.from) && !added.includes(edge.to)),
    ...['product', 'architecture', 'development', 'testing'].flatMap(id => [
      { from: 'coordinator', to: id }, { from: id, to: 'decision' }
    ]), { from: 'decision', to: 'guard-product' }
  ] };
}

test('插件启动不改写已安装模板；用户删除及自定义拓扑保持不变', async t => {
  const { storage, workflows } = await fixture(t);
  const legacy = legacyTemplate();
  legacy.name = '我的联合审核';
  legacy.nodes.find(node => node.id === 'coordinator').params.input = '保留自定义输入';
  legacy.nodes.find(node => node.id === 'aligned').params.input = '保留自定义报告';
  legacy.nodes.find(node => node.id === 'product').params.providerId = 'my-ai';
  const savedLegacy = await workflows.save(legacy);
  const key = 'plugin-data/work-flow/template-imports.json';
  await storage.writeJson(key, { version: 1, imported: [legacy.id] });
  const options = { storage, workflows, pluginId: 'work-flow', logger: () => {} };
  await ensureDocumentReviewTemplate(options);
  const updated = await workflows.read(legacy.id);
  assert.deepEqual(updated, savedLegacy);
  await ensureDocumentReviewTemplate(options);
  assert.deepEqual(await workflows.read(legacy.id), updated);
  await workflows.remove(legacy.id);
  await ensureDocumentReviewTemplate(options);
  assert.equal((await workflows.list()).length, 0);

  const customized = { ...legacyTemplate(), nodes: [...legacy.nodes, { id: 'custom', type: 'text.input', params: {} }] };
  await workflows.save(customized);
  await storage.writeJson(key, { version: 1, imported: [legacy.id] });
  await ensureDocumentReviewTemplate(options);
  assert.equal((await workflows.read(legacy.id)).nodes.some(node => node.type === 'flow.parallel'), false);
});


test('旧修订标记不再触发迁移，既有定义、其他流程及历史逐字保留', async t => {
  const { storage, workflows } = await fixture(t);
  const previous = documentReviewTemplate();
  previous.name = '我的需求一致性审核';
  const coordinator = previous.nodes.find(node => node.id === 'coordinator');
  coordinator.params.instructions = '同时修改需求和设计';
  coordinator.params.providerId = 'my-provider';
  coordinator.params.mode = 'execute';
  coordinator.x = 777;
  coordinator.width = 333;
  const savedPrevious = await workflows.save(previous);
  const other = await workflows.save({ id: 'other', name: '其他流程', nodes: [{ id: 'start', type: 'flow.start', params: {} }], edges: [] });
  const historyKey = 'plugin-data/work-flow/runs.json';
  const history = { items: [{ id: 'old-run', workflow: previous, status: 'interrupted' }] };
  await storage.writeJson(historyKey, history);
  const key = 'plugin-data/work-flow/template-imports.json';
  await storage.writeJson(key, { version: 1, imported: [previous.id], revisions: { [previous.id]: 2 } });
  const options = { storage, workflows, pluginId: 'work-flow', logger: () => {} };
  await ensureDocumentReviewTemplate(options);
  const updated = await workflows.read(previous.id);
  const node = updated.nodes.find(entry => entry.id === 'coordinator');
  assert.equal(node.params.instructions, '同时修改需求和设计');
  assert.deepEqual(updated, savedPrevious);
  assert.equal(node.params.providerId, 'my-provider');
  assert.equal(node.params.mode, 'execute');
  assert.equal(node.x, 777);
  assert.equal(node.width, 333);
  assert.equal(updated.name, previous.name);
  assert.deepEqual(await workflows.read('other'), other);
  assert.deepEqual(await storage.readJson(historyKey), history);
  assert.equal((await storage.readJson(key)).revisions[previous.id], 2);
  await ensureDocumentReviewTemplate(options);
  assert.deepEqual(await workflows.read(previous.id), updated);

  await workflows.remove(previous.id);
  await storage.writeJson(key, { version: 1, imported: [previous.id], revisions: { [previous.id]: 2 } });
  await ensureDocumentReviewTemplate(options);
  await assert.rejects(workflows.read(previous.id), { code: 'WORKFLOW_NOT_FOUND' });
});
