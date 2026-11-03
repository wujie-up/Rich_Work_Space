import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Workflows } from '../src/main/common/workflows.js';
import { WorkflowTransfer } from '../src/main/common/workflow-transfer.js';

const types = [{ type: 'text.input', params: [] }, { type: 'message.wechat', params: [{ name: 'connectionId', kind: 'connection' }] }, { type: 'mail.fetch', params: [{ name: 'credentialId', kind: 'credential' }] }];
const graph = { name: '可复用流程', nodes: [{ id: 'input', type: 'text.input', title: '输入', x: 12, y: 34,
  width: 240, height: 120, params: { content: '自定义提示 {{previous.output}}' } }], edges: [],
  trigger: { mode: 'interval', enabled: true, every: 5, unit: 'minute' } };

async function fixture(t) {
  const storage = await temporaryStore(t);
  const workflows = new Workflows({ storage, pluginId: 'work-flow' });
  const transfer = new WorkflowTransfer({ workflows, types: () => types, activeRun: () => null, logger: () => {} });
  return { storage, workflows, transfer };
}

test('导出当前编辑内容；重复导入创建独立流程并禁用自动触发', async t => {
  const { storage, workflows, transfer } = await fixture(t);
  const original = await workflows.save(graph);
  const exported = await transfer.export({ workflow: { ...original, name: '尚未保存的新名字', runtime: '不应导出' }, directory: storage.root });
  const data = JSON.parse(await readFile(exported.path, 'utf8'));
  assert.equal(data.format, 'deckpg.workflow');
  assert.equal(data.version, 1);
  assert.equal(data.workflow.name, '尚未保存的新名字');
  assert.equal(data.workflow.runtime, undefined);
  const inspected = await transfer.inspect(exported.path);
  const first = await transfer.import({ document: inspected.document });
  const second = await transfer.import({ document: inspected.document });
  assert.notEqual(first.workflow.id, original.id);
  assert.notEqual(first.workflow.id, second.workflow.id);
  assert.deepEqual(first.workflow.nodes, original.nodes);
  assert.equal(first.workflow.trigger.mode, 'manual');
  assert.equal(first.workflow.trigger.enabled, false);
  assert.deepEqual(await workflows.read(original.id), original);
});

test('分组随定义导入导出，旧格式仍作为未分组工作流导入', async t => {
  const { storage, transfer } = await fixture(t);
  const exported = await transfer.export({ workflow: { ...graph, group: '软件研发七阶段' }, directory: storage.root });
  const document = JSON.parse(await readFile(exported.path, 'utf8'));
  assert.equal(document.workflow.group, '软件研发七阶段');
  const imported = await transfer.import({ document });
  assert.equal(imported.workflow.group, '软件研发七阶段');
  delete document.workflow.group;
  const legacy = await transfer.import({ document });
  assert.equal(Object.hasOwn(legacy.workflow, 'group'), false);
});

test('更新只替换指定流程，保留创建时间、其他流程和续跑快照；活跃运行拒绝更新', async t => {
  const { storage, workflows, transfer } = await fixture(t);
  const target = await workflows.save(graph);
  const other = await workflows.save({ ...graph, name: '另一个' });
  const historyKey = `plugin-data/work-flow/runs/${target.id}.json`;
  const history = [{ id: 'paused', status: 'interrupted', workflow: target }];
  await storage.writeJson(historyKey, history);
  const document = { format: 'deckpg.workflow', version: 1, workflow: { ...graph, name: '新定义' } };
  await assert.rejects(transfer.import({ document, targetId: target.id }), { code: 'IMPORT_CONFIRM_REQUIRED' });
  const result = await transfer.import({ document, targetId: target.id, confirmed: true });
  assert.equal(result.workflow.id, target.id);
  assert.equal(result.workflow.createdAt, target.createdAt);
  assert.equal(result.workflow.name, '新定义');
  assert.deepEqual(await workflows.read(other.id), other);
  assert.deepEqual(await storage.readJson(historyKey), history);
  transfer.activeRun = () => ({ id: 'active' });
  await assert.rejects(transfer.import({ document, targetId: target.id, confirmed: true }), { code: 'RUN_BUSY' });
  assert.equal((await workflows.read(target.id)).name, '新定义');
});

test('外部连接不随流程转移，提示用户重新配置', async t => {
  const { transfer } = await fixture(t);
  const document = { format: 'deckpg.workflow', version: 1, workflow: { name: '邮箱流程',
    nodes: [{ id: 'mail', type: 'mail.fetch', params: { credentialId: 'old-secret-id', limit: 10 } }], edges: [] } };
  const imported = await transfer.import({ document });
  assert.equal(imported.workflow.nodes[0].params.credentialId, '');
  assert.equal(imported.workflow.nodes[0].params.limit, 10);
  assert.match(imported.warnings.join(' '), /邮件账号/);
});

test('无效 JSON、版本、节点和连线不写入任何流程', async t => {
  const { storage, workflows, transfer } = await fixture(t);
  const before = await workflows.save(graph);
  const document = { format: 'deckpg.workflow', version: 1, workflow: graph };
  for (const invalid of [null, { ...document, version: 2 }, { ...document, workflow: { ...graph, nodes: [{ ...graph.nodes[0], params: [] }] } }, { ...document, workflow: { ...graph, nodes: [
    { id: 'unknown', type: 'not.installed', params: {} }] } }, { ...document, workflow: { ...graph, edges: [{ from: 'input', to: 'missing' }] } },
    { ...document, workflow: { ...graph, nodes: [...graph.nodes, ...graph.nodes] } }]) {
    await assert.rejects(transfer.import({ document: invalid }));
    assert.deepEqual(await workflows.list(), [before]);
  }
  const path = join(storage.root, 'bad.json');
  await writeFile(path, '{invalid');
  await assert.rejects(transfer.inspect(path), { code: 'INVALID_WORKFLOW_FILE' });
  assert.deepEqual(await workflows.list(), [before]);
});


test('消息监听流程可导出，但账号引用清空，重新导入不启动监听', async t => {
  const { storage, transfer } = await fixture(t);
  const exported = await transfer.export({ directory: storage.root, workflow: { name: '消息入口',
    nodes: [{ id: 'message', type: 'message.wechat', params: { connectionId: 'local-account' } }], edges: [],
    trigger: { mode: 'message', enabled: true } } });
  const document = JSON.parse(await readFile(exported.path, 'utf8'));
  assert.equal(document.workflow.nodes[0].params.connectionId, '');
  assert.equal(document.workflow.trigger.mode, 'message');
  const result = await transfer.import({ document });
  assert.equal(result.workflow.trigger.mode, 'manual');
  assert.match(result.warnings.join(' '), /消息连接/);
});
