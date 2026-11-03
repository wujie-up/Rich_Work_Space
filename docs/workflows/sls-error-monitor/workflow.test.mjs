import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWorkflow, TARGETS, GROUPS } from './workflow.mjs';
import { createRegistry } from '../../../plugin-dev/work-flow/src/main/common/nodes.js';
import { Workflows } from '../../../plugin-dev/work-flow/src/main/common/workflows.js';
import { WorkflowTransfer } from '../../../plugin-dev/work-flow/src/main/common/workflow-transfer.js';
import { Engine } from '../../../plugin-dev/work-flow/src/main/common/engine.js';
import { Runs } from '../../../plugin-dev/work-flow/src/main/common/runs.js';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { marked } from '../../../plugin-dev/text-editor/node_modules/marked/lib/marked.esm.js';

test('可导入JSON与源定义一致', async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL('./sls-error-monitor.workflow.json', import.meta.url), 'utf8')), buildWorkflow());
});

test('57库唯一覆盖，使用真实库名和现有并行/导入协议，定时30分钟', () => {
  assert.equal(TARGETS.length, 57);
  assert.equal(TARGETS.filter(t => t.system === 'old').length, 50);
  assert.equal(new Set(TARGETS.filter(t => t.system === 'old').map(t => t.country)).size, 16);
  assert.equal(new Set(TARGETS.map(t => `${t.region}/${t.project}/${t.logstore}`)).size, 57);
  const key = target => `${target.region}/${target.project}/${target.logstore}`;
  assert.deepEqual(GROUPS.flatMap(g => g.targets).map(key).sort(), TARGETS.map(key).sort());
  assert.ok(TARGETS.every(t => !/server/.test(t.logstore)));
  assert.equal(TARGETS.find(t => t.country === 'tr').project, 'aitr');
  const registry = createRegistry({ credentials: {} });
  const workflows = new Workflows({ storage: {}, pluginId: 'work-flow', classify: type => registry.list().find(n => n.type === type) });
  const transfer = new WorkflowTransfer({ workflows, types: () => registry.list(), activeRun: () => false, logger: () => {} });
  const document = buildWorkflow();
  assert.doesNotThrow(() => transfer.preview(document));
  assert.deepEqual(document.workflow.trigger, { mode: 'interval', every: 30, unit: 'minute', enabled: true });
  assert.equal(document.workflow.edges.filter(e => e.from === 'parallel').length, GROUPS.length);
  const query = document.workflow.nodes.find(n => n.id === GROUPS[0].id).params.instructions;
  assert.match(query, /level: ERROR/);
  assert.match(query, /Complete/);
  assert.match(query, /100/);
  assert.match(query, /失败/);
  assert.match(document.workflow.nodes.find(n => n.id === 'classify').params.instructions, /未知/);
  assert.match(document.workflow.nodes.find(n => n.id === 'classify').params.instructions, /规则为空/);
  assert.ok(document.workflow.nodes.every(n => n.type !== 'agent.review' || n.params.mode === 'plan'));
  assert.ok(document.workflow.nodes.every(n => n.type !== 'agent.review' || n.params.providerId === 'ai-agent-sessions'));
});

for (const fullCoverage of [false, true]) {
  test(`真实Engine七组并行、规则查询传递、报告落盘及${fullCoverage ? '完整覆盖连续两轮' : '缺口不推进'}游标`, async t => {
    const storage = await temporaryStore(t);
    let now = 1800000123;
    t.mock.method(Date, 'now', () => now * 1000);
    const registry = createRegistry({ credentials: {} });
    const workflows = new Workflows({ storage, pluginId: 'work-flow', classify: type => registry.list().find(n => n.type === type) });
    const definition = buildWorkflow({ desktop: storage.root, stateDirectory: join(storage.root, 'state') }).workflow;
    definition.nodes.find(node => node.id === 'queries').params.rules = JSON.stringify([{ id: 'known-business', enabled: true,
      reason: '测试中已确认', scope: { country: 'br', logstore: 'app' },
      conditions: [{ field: 'message', operator: 'equals', value: 'confirmed expected rejection' }] }]);
    const workflow = await workflows.save(definition);
    const pending = new Map();
    const calls = [];
    const agents = { cancel: async () => {}, run: async (request, { nodeId }) => {
      calls.push({ nodeId, request });
      const group = GROUPS.find(g => g.id === nodeId);
      if (group) {
        const material = JSON.parse(request.prompt.split('\n\n').find(block => block.startsWith('{')));
        const targets = Object.values(material.targetsByCountry).flat();
        assert.deepEqual(targets.map(target => `${target.project}/${target.logstore}`).sort(),
          group.targets.map(target => `${target.project}/${target.logstore}`).sort());
        for (const target of targets) {
          assert.equal(target.ruleIds.length, target.country === 'br' && target.logstore === 'app' ? 1 : 0);
          assert.equal(target.queries.patterns.includes('WHERE NOT'), target.ruleIds.length > 0);
        }
        return new Promise(resolve => pending.set(nodeId, () => resolve({ state: 'succeeded', output: JSON.stringify({
          coverage: targets.map((target, index) => ({ ...target, ...material.window,
            status: !fullCoverage && group === GROUPS[0] && index === 0 ? 'failed' : 'complete',
            patternsComplete: true, errorCount: 0, excludedErrors: 0, totalErrors: 0, requestIds: ['test-request'] })),
          findings: [{ fingerprint: 'UNKNOWN-1', priority: 'P2', title: '不能默认排除', samples: [{ source: group.targets[0],
            location: 'Example.java:42', message: `本轮关键错误 ${group.id}`, time: null, requestId: null, slsRequestId: 'test-request' }] }],
          notes: [] }) })));
      }
      if (nodeId === 'classify') {
        assert.match(request.prompt, /UNKNOWN-1/);
        return { state: 'succeeded', output: JSON.stringify({ coverage: { complete: fullCoverage }, actionable: [],
          unknown: [{ fingerprint: 'UNKNOWN-1' }], excluded: [], continuity: [], notes: [] }) };
      }
      assert.equal(nodeId, 'analysis');
      assert.match(request.prompt, /UNKNOWN-1/);
      return { state: 'succeeded', output: JSON.stringify({ report: '# 巡检\n\nUNKNOWN-1 待核实\n\n- **处理：**先核实后修改。',
        state: { fingerprints: [{ fingerprint: 'UNKNOWN-1' }] } }) };
    } };
    const engine = new Engine({ registry, runs: new Runs({ storage, pluginId: 'work-flow' }), credentials: {}, agents,
      emit: () => {}, logger: () => {}, pluginId: 'work-flow' });
    t.after(() => engine.stop('test'));
    let previous;
    for (let round = 0; round < 2; round += 1) {
      pending.clear();
      calls.length = 0;
      const { id } = await engine.start(workflow);
      await engine.active.get(id).task;
      const poll = engine.resume(id);
      for (let i = 0; i < 200 && pending.size !== GROUPS.length; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(pending.size, GROUPS.length);
      assert.equal(calls.some(c => c.nodeId === 'classify'), false, '全部查询结束前不得汇总');
      for (const finish of pending.values()) { finish(); }
      await poll;
      for (let i = 0; i < 10 && engine.get(id).status === 'waiting'; i += 1) { await engine.resume(id); }
      const run = engine.get(id);
      assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
      const window = run.nodes.window.output;
      assert.equal(window.to, now);
      if (previous) {
        assert.equal(window.from, fullCoverage ? previous.to : previous.from);
      }
      const summary = JSON.parse(await readFile(join(storage.root, 'state', 'latest.json'), 'utf8'));
      assert.equal(summary.windowTo, now);
      assert.equal(summary.coverage.length, 57);
      assert.equal(summary.watermarkAdvanceAllowed, fullCoverage);
      assert.equal(run.nodes.state.output.advanced, fullCoverage);
      const reportPath = run.nodes.state.output.reportPath;
      assert.match(reportPath, /ERROR日志巡检-\d{6}-\d{2}:\d{2}\.md$/);
      const report = await readFile(reportPath, 'utf8');
      assert.match(report, /UNKNOWN-1/);
      const samples = marked.lexer(report).filter(token => token.type === 'code').map(token => JSON.parse(token.text));
      assert.equal(samples.length, GROUPS.length, '分析节点省略样本时，报告仍保留每个并行分支的查询证据');
      for (const group of GROUPS) {
        assert.ok(samples.some(sample => sample.message === `本轮关键错误 ${group.id}`
          && sample.source.project === group.targets[0].project && sample.source.logstore === group.targets[0].logstore));
      }
      assert.match(marked.parse(report), /<strong>处理<\/strong>：先核实后修改/);
      assert.equal(await readFile(join(storage.root, 'state', 'reports', `${window.stamp}.md`), 'utf8'), report);
      previous = window;
      now += 2073;
    }
  });
}
