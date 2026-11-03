import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflows } from './workflows.mjs';
import { createRegistry } from '../../../plugin-dev/work-flow/src/main/common/nodes.js';
import { Workflows } from '../../../plugin-dev/work-flow/src/main/common/workflows.js';
import { WorkflowTransfer } from '../../../plugin-dev/work-flow/src/main/common/workflow-transfer.js';

const entries = buildWorkflows();
const registry = createRegistry({ credentials: {} });
const workflows = new Workflows({ storage: {}, pluginId: 'work-flow', classify: type => registry.list().find(node => node.type === type) });
const transfer = new WorkflowTransfer({ workflows, types: () => registry.list(), activeRun: () => false, logger: () => {} });

test('九份定义使用当前导入协议和已注册节点，所有循环默认五轮', () => {
  assert.equal(entries.length, 9);
  assert.equal(new Set(entries.map(entry => entry.file)).size, 9);
  for (const { file, document } of entries) {
    assert.equal(document.format, 'deckpg.workflow', file);
    assert.equal(document.version, 1);
    assert.doesNotThrow(() => transfer.preview(document), file);
    assert.deepEqual(document.workflow.trigger, { mode: 'manual' });
    for (const node of document.workflow.nodes.filter(node => node.type === 'flow.loop')) {
      assert.equal(node.params.maxIterations, 5, `${file}: ${node.id}`);
      assert.equal(node.params.maxTotalIterations, 5, `${file}: ${node.id}`);
      if (node.id !== 'preflight-loop') {
        assert.equal(node.params.maxStagnantIterations, 2, `${file}: ${node.id}`);
        assert.equal(node.params.progressInput, `{{${node.id.replace('-loop', '-decision')}.output.resolvedIssueIds}}`);
      }
    }
    for (const node of document.workflow.nodes.filter(node => node.type === 'output.file')) {
      assert.equal(document.workflow.edges.some(edge => edge.from === node.id), false, `${file}: sink must stay terminal`);
    }
  }
});

test('评分限定当前阶段，作者修订与独立复核共同使用稳定问题证据', () => {
  const nodes = entries[0].document.workflow.nodes;
  for (let number = 1; number <= 7; number += 1) {
    const author = nodes.find(node => node.id === `s${number}-author`);
    assert.equal(JSON.parse(author.params.outputFields).resolutions, 'object[]');
    assert.match(author.params.instructions, /changeLocation/);
    const decision = nodes.find(node => node.id === `s${number}-decision`);
    assert.equal(JSON.parse(decision.params.outputFields).resolvedIssueIds, 'string[]');
    assert.match(decision.params.inputMapping, /上轮协调结论/);
    assert.match(decision.params.instructions, /校验证据/);
    const reviews = nodes.filter(node => node.id.startsWith(`s${number}-review-`) && node.type === 'agent.review');
    for (const review of reviews) {
      assert.match(review.params.instructions, /issueId/);
      assert.match(review.params.inputMapping, /上轮协调结论/);
      assert.match(review.params.instructions, number <= 3 ? /后续运行验收项不计入本阶段评分/ : /真实/);
    }
  }
});

test('完整与独立阶段使用同一职责、输出协议和评审提示词，仅输入接续不同', () => {
  const full = entries.find(entry => entry.file === '00-full-pipeline.workflow.json').document.workflow;
  for (let number = 1; number <= 7; number += 1) {
    const single = entries.find(entry => entry.file.startsWith(`0${number}-`)).document.workflow;
    const shared = single.nodes.filter(node => node.type === 'agent.review' && node.id.startsWith(`s${number}-`));
    assert.ok(shared.length, number);
    for (const node of shared) {
      const counterpart = full.nodes.find(candidate => candidate.id === node.id);
      assert.ok(counterpart, node.id);
      for (const field of ['rolePrompt', 'instructions', 'outputFields', 'mode']) {
        assert.equal(counterpart.params[field], node.params[field], `${node.id}.${field}`);
      }
    }
  }
});

test('前三阶段并行产品研发测试评审；实施评审并行但写代码串行', () => {
  const full = entries[0].document.workflow;
  for (let number = 1; number <= 3; number += 1) {
    const parallel = full.nodes.find(node => node.id === `s${number}-parallel`);
    assert.equal(parallel.type, 'flow.parallel');
    const roles = full.edges.filter(edge => edge.from === parallel.id).map(edge => edge.to);
    assert.deepEqual(roles, ['product', 'development', 'testing'].map(role => `s${number}-review-${role}`));
  }
  for (const parallel of full.nodes.filter(node => node.type === 'flow.parallel')) {
    const branches = full.edges.filter(edge => edge.from === parallel.id).map(edge => full.nodes.find(node => node.id === edge.to));
    assert.ok(branches.every(node => node.params.mode === 'plan'));
  }
  assert.equal(full.nodes.find(node => node.id === 's4-author').params.mode, 'code');
  assert.equal(full.nodes.find(node => node.id === 's5-author').params.mode, 'code');
  assert.equal(full.nodes.find(node => node.id === 's7-author').params.mode, 'code');
});

test('没有逐轮例行用户审批；链接由文件节点原样输入且无网络抓取节点', () => {
  for (const { document } of entries) {
    const nodes = document.workflow.nodes;
    assert.equal(nodes.find(node => node.id === 'materials').params.interaction, 'file');
    assert.ok(nodes.filter(node => node.type === 'flow.user-input').every(node => !node.id.includes('round-review')));
    assert.ok(nodes.every(node => !['http.fetch', 'web.fetch'].includes(node.type)));
    assert.match(nodes.find(node => node.id === 'preflight').params.instructions, /链接/);
  }
});

test('九份交付JSON与生成定义一致，可以重新导入', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const { file, document } of entries) {
    const saved = JSON.parse(await readFile(new URL(`./exports/${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(saved, document, file);
    assert.doesNotThrow(() => transfer.preview(saved));
  }
});
