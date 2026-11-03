import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Workflows } from '../src/main/common/workflows.js';
import { Credentials } from '../src/main/common/credentials.js';

const PLUGIN_ID = 'work-flow';

test('分组含未分组可排序并持久化，保留定义和历史；新增删除不破坏顺序', async t => {
  const { storage, workflows } = await domains(t);
  const a = await workflows.createGroup({ name: 'A' });
  const b = await workflows.createGroup({ name: 'B' });
  await workflows.save({ groupId: a.id, nodes: [{ id: 'input', type: 'text.input' }] });
  const definitions = await workflows.list();
  const historyKey = 'plugin-data/work-flow/runs/order.json';
  await storage.writeJson(historyKey, [{ status: 'interrupted' }]);
  const directory = service => service.listGroups({ includeUngrouped: true }).then(groups => groups.map(group => group.id));
  assert.deepEqual(await directory(workflows), [a.id, b.id, '']);
  assert.deepEqual(await workflows.reorderGroups({ id: '', targetId: a.id, position: 'before' }), ['', a.id, b.id]);
  await workflows.reorderGroups({ id: b.id, targetId: a.id, position: 'before' });
  const reloaded = new Workflows({ storage, pluginId: PLUGIN_ID });
  assert.deepEqual(await directory(reloaded), ['', b.id, a.id]);
  assert.deepEqual((await reloaded.listGroups()).map(group => group.id), [b.id, a.id]);
  await reloaded.renameGroup({ id: b.id, name: 'B2' });
  const c = await reloaded.createGroup({ name: 'C' });
  await reloaded.removeGroup({ id: b.id });
  assert.deepEqual(await directory(reloaded), ['', a.id, c.id]);
  assert.deepEqual(await reloaded.list(), definitions);
  assert.deepEqual(await storage.readJson(historyKey), [{ status: 'interrupted' }]);
  await assert.rejects(reloaded.reorderGroups({ id: 'missing', targetId: a.id, position: 'before' }), { code: 'GROUP_NOT_FOUND' });
  await assert.rejects(reloaded.reorderGroups({ id: '', targetId: a.id, position: 'bad' }), { code: 'INVALID_ARGUMENT' });
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw Error('磁盘写入失败'); };
  await assert.rejects(reloaded.reorderGroups({ id: '', targetId: a.id, position: 'after' }), /磁盘写入失败/);
  assert.deepEqual(await directory(reloaded), ['', a.id, c.id]);
  storage.writeJson = write;
});

async function domains(t) {
  const storage = await temporaryStore(t);
  return { storage, workflows: new Workflows({ storage, pluginId: PLUGIN_ID }),
    credentials: new Credentials({ storage, pluginId: PLUGIN_ID }) };
}

test('工作流保存时补全默认值并拒绝非法结构', async t => {
  const { workflows } = await domains(t);
  await assert.rejects(workflows.save({ name: '空' }), { code: 'INVALID_WORKFLOW' });
  await assert.rejects(workflows.save({ nodes: [{ id: 'a', type: 'text.input' }, { id: 'a', type: 'text.input' }] }),
    { code: 'INVALID_WORKFLOW' });
  const saved = await workflows.save({ nodes: [{ id: 'a', type: 'text.input' }], edges: [{ from: 'a', to: 'a' },
    { from: 'a', to: 'missing' }] });
  assert.equal(saved.name, '未命名工作流');
  assert.deepEqual(saved.edges, []);
  assert.equal(saved.nodes[0].title, 'text.input');
  assert.equal(saved.nodes[0].x, 0);
});

test('重复连线只保留一条依赖', async t => {
  const { workflows } = await domains(t);
  const saved = await workflows.save({ id: 'wf', nodes: [{ id: 'a', type: 'text.input' }, { id: 'b', type: 'result.collect' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }] });
  assert.equal(saved.edges.length, 1);
  assert.equal((await workflows.list()).length, 1);
  await workflows.remove('wf');
  assert.deepEqual(await workflows.list(), []);
  await assert.rejects(workflows.read('wf'), { code: 'WORKFLOW_NOT_FOUND' });
});

test('更新保留首次创建时间，删除不影响其他工作流', async t => {
  const { workflows } = await domains(t);
  const first = await workflows.save({ nodes: [{ id: 'a', type: 'text.input' }] });
  await workflows.save({ nodes: [{ id: 'b', type: 'text.input' }] });
  const updated = await workflows.save({ ...first, name: '改名' });
  assert.equal(updated.name, '改名');
  assert.equal(updated.createdAt, first.createdAt);
  await workflows.remove(updated.id);
  assert.equal((await workflows.list()).length, 1);
});

test('分组可保存、移动和移出，兼容未分组旧流程且不改运行快照', async t => {
  const { storage, workflows } = await domains(t);
  const legacy = await workflows.save({ name: '旧流程', nodes: [{ id: 'a', type: 'text.input' }] });
  const key = `plugin-data/${PLUGIN_ID}/runs/${legacy.id}.json`;
  const history = [{ id: 'paused', status: 'interrupted', workflow: legacy }];
  await storage.writeJson(key, history);
  const grouped = await workflows.save({ ...legacy, group: '  软件研发七阶段  ' });
  assert.equal(grouped.group, '软件研发七阶段');
  const reloaded = new Workflows({ storage, pluginId: PLUGIN_ID });
  assert.equal((await reloaded.read(legacy.id)).group, '软件研发七阶段');
  const moved = await reloaded.save({ ...grouped, groupId: undefined, group: '其他分组' });
  assert.equal(moved.group, '其他分组');
  const ungrouped = await workflows.save({ ...moved, groupId: undefined, group: '' });
  assert.equal(Object.hasOwn(ungrouped, 'group'), false);
  assert.equal(ungrouped.createdAt, legacy.createdAt);
  assert.deepEqual(ungrouped.nodes, legacy.nodes);
  assert.deepEqual(await storage.readJson(key), history);
  await assert.rejects(workflows.save({ ...legacy, group: {} }), { code: 'INVALID_WORKFLOW' });
});

test('节点尺寸保存后可恢复，旧节点仍使用默认布局，非法尺寸不写入', async t => {
  const { workflows } = await domains(t);
  const first = await workflows.save({ nodes: [{ id: 'a', type: 'text.input', width: 380, height: 230 }] });
  assert.equal((await workflows.read(first.id)).nodes[0].width, 380);
  assert.equal((await workflows.read(first.id)).nodes[0].height, 230);
  const legacy = await workflows.save({ nodes: [{ id: 'b', type: 'text.input' }] });
  assert.equal(Object.hasOwn(legacy.nodes[0], 'width'), false);
  assert.equal(Object.hasOwn(legacy.nodes[0], 'height'), false);
  const invalid = await workflows.save({ nodes: [{ id: 'c', type: 'text.input', width: -10, height: Infinity }] });
  assert.equal(Object.hasOwn(invalid.nodes[0], 'width'), false);
  assert.equal(Object.hasOwn(invalid.nodes[0], 'height'), false);
});

test('整组重命名单次保存所有成员，只修改分组与更新时间，保留历史和其他分组', async t => {
  const { storage, workflows } = await domains(t);
  const first = await workflows.save({ name: '阶段一', group: '七阶段', nodes: [{ id: 'a', type: 'text.input' }] });
  const second = await workflows.save({ name: '阶段二', group: '七阶段', nodes: [{ id: 'b', type: 'text.input' }] });
  const other = await workflows.save({ name: '其他', group: '其他组', nodes: [{ id: 'c', type: 'text.input' }] });
  const historyKey = `plugin-data/${PLUGIN_ID}/runs/${first.id}.json`;
  const history = [{ id: 'paused', status: 'interrupted', workflow: first }];
  await storage.writeJson(historyKey, history);
  let writes = 0;
  const write = storage.writeJson.bind(storage);
  storage.writeJson = (...args) => { writes++; return write(...args); };
  const renamed = await workflows.renameGroup({ group: '七阶段', name: '  软件研发  ' });
  assert.equal(writes, 1);
  assert.equal(renamed.length, 2);
  const reloaded = new Workflows({ storage, pluginId: PLUGIN_ID });
  for (const before of [first, second]) {
    const after = await reloaded.read(before.id);
    assert.equal(after.group, '软件研发');
    assert.deepEqual({ ...after, group: before.group, updatedAt: before.updatedAt }, before);
  }
  assert.deepEqual(await reloaded.read(other.id), other);
  assert.deepEqual(await storage.readJson(historyKey), history);
  const snapshot = await reloaded.list();
  await assert.rejects(workflows.renameGroup({ group: '软件研发', name: '其他组' }), { code: 'GROUP_EXISTS' });
  await assert.rejects(workflows.renameGroup({ group: '软件研发', name: '  ' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(workflows.renameGroup({ group: '', name: '新名称' }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(await workflows.list(), snapshot);
  await workflows.renameGroup({ group: '软件研发', name: ' 软件研发 ' });
  assert.equal(writes, 1, '同名不写入');
  assert.deepEqual(await workflows.renameGroup({ group: '尚未保存的分组', name: '草稿分组' }), []);
  assert.equal(writes, 1, '纯草稿分组无需写入磁盘');
});

test('邮件账号列表不返回密码，留空保存保留原密钥', async t => {
  const { credentials } = await domains(t);
  const id = await credentials.save({ name: '工作邮箱', host: 'imap.example.com', port: 993, username: 'ops', password: 'secret-token' });
  const listed = await credentials.list();
  assert.equal(listed[0].hasPassword, true);
  assert.ok(!JSON.stringify(listed).includes('secret-token'));
  await credentials.save({ id, name: '工作邮箱', host: 'imap.example.com', port: 993, username: 'ops', password: '' });
  const secret = await credentials.secret(id);
  assert.equal(secret.password, 'secret-token');
  await credentials.remove(id);
  await assert.rejects(credentials.secret(id), { code: 'CREDENTIAL_NOT_FOUND' });
});

test('邮件账号校验覆盖名称、端口与连接方式', async t => {
  const { credentials } = await domains(t);
  await assert.rejects(credentials.save({ name: '', host: 'imap.example.com', username: 'ops', password: 'p' }),
    { code: 'INVALID_ARGUMENT' });
  await assert.rejects(credentials.save({ name: 'x', host: 'imap.example.com', username: 'ops', password: 'p', port: 70000 }),
    { code: 'INVALID_ARGUMENT' });
  await assert.rejects(credentials.save({ name: 'x', host: 'imap.example.com', username: 'ops', password: 'p', security: 'ftp' }),
    { code: 'INVALID_ARGUMENT' });
  await assert.rejects(credentials.save({ name: 'x', host: 'imap.example.com', username: 'ops', password: '' }),
    { code: 'INVALID_ARGUMENT' });
});

test('旧分组迁移为稳定目录，空分组及收起状态独立保存', async t => {
  const { storage, workflows } = await domains(t);
  const key = `plugin-data/${PLUGIN_ID}/workflows.json`;
  const legacy = { id: 'legacy', name: '旧流程', group: '旧分组', nodes: [{ id: 'a', type: 'text.input' }], edges: [] };
  await storage.writeJson(key, { version: 1, items: [legacy] });
  const [group] = await workflows.listGroups();
  assert.equal(group.name, '旧分组');
  assert.equal((await workflows.read('legacy')).groupId, group.id);
  assert.deepEqual((await workflows.read('legacy')).nodes, legacy.nodes);
  const empty = await workflows.createGroup({ name: '  空分组  ' });
  assert.equal(empty.name, '空分组');
  await workflows.setGroupCollapsed({ id: empty.id, collapsed: true });
  const reloaded = new Workflows({ storage, pluginId: PLUGIN_ID });
  assert.deepEqual(await reloaded.listGroups(), [group, { ...empty, collapsed: true }]);
  await assert.rejects(workflows.createGroup({ name: ' 空分组 ' }), { code: 'GROUP_EXISTS' });
  await assert.rejects(workflows.createGroup({ name: '  ' }), { code: 'INVALID_ARGUMENT' });
  await workflows.remove('legacy');
  assert.equal((await workflows.listGroups()).length, 2, '删除最后一个成员保留分组');
});

test('移动和删除分组只修改成员元数据，旧草稿不能复活删除的分组', async t => {
  const { storage, workflows } = await domains(t);
  const first = await workflows.save({ group: '研发', nodes: [{ id: 'a', type: 'text.input' }] });
  const second = await workflows.save({ group: '研发', nodes: [{ id: 'b', type: 'text.input' }] });
  const other = await workflows.createGroup({ name: '测试' });
  const key = `plugin-data/${PLUGIN_ID}/runs/${first.id}.json`;
  const history = [{ id: 'waiting', status: 'interrupted', workflow: first }];
  await storage.writeJson(key, history);
  await workflows.moveGroup({ workflowId: first.id, groupId: other.id });
  assert.equal((await workflows.read(first.id)).group, '测试');
  assert.equal((await workflows.read(second.id)).group, '研发');
  await workflows.moveGroup({ workflowId: first.id, groupId: null });
  assert.equal((await workflows.read(first.id)).group, undefined);
  await workflows.renameGroup({ id: other.id, name: '质量' });
  assert.equal((await workflows.listGroups()).find(group => group.id === other.id).name, '质量');
  const removed = await workflows.removeGroup({ id: second.groupId });
  assert.equal(removed.length, 1);
  const after = await workflows.read(second.id);
  assert.equal(after.group, undefined);
  assert.deepEqual(after.nodes, second.nodes);
  const saved = await workflows.save({ ...second, name: '旧草稿保存' });
  assert.equal(saved.group, undefined, '旧 groupId 已删除时不按旧名称重建');
  assert.deepEqual(await storage.readJson(key), history);
  assert.equal((await workflows.list()).length, 2);
  assert.equal((await workflows.listGroups()).some(group => group.name === '研发'), false);
});

test('改名后旧草稿沿用稳定分组标识，导入同名定义复用分组', async t => {
  const { workflows } = await domains(t);
  const draft = await workflows.save({ group: '旧名', nodes: [{ id: 'a', type: 'text.input' }] });
  await workflows.setGroupCollapsed({ id: draft.groupId, collapsed: true });
  await workflows.renameGroup({ id: draft.groupId, name: '新名' });
  const saved = await workflows.save({ ...draft, name: '编辑内容' });
  assert.equal(saved.group, '新名');
  assert.equal(saved.groupId, draft.groupId);
  const imported = await workflows.save({ group: '新名', nodes: [{ id: 'b', type: 'text.input' }] });
  assert.equal(imported.groupId, draft.groupId);
  assert.equal((await workflows.listGroups()).length, 1);
  assert.equal((await workflows.listGroups())[0].collapsed, true);
});

test('分组写入失败时成员与目录均不改变，失效分组不能被误操作', async t => {
  const { storage, workflows } = await domains(t);
  const saved = await workflows.save({ group: '研发', nodes: [{ id: 'a', type: 'text.input' }] });
  const snapshot = await workflows.list();
  const groups = await workflows.listGroups();
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw new Error('磁盘写入失败'); };
  await assert.rejects(workflows.removeGroup({ id: saved.groupId }), /磁盘写入失败/);
  assert.deepEqual(await workflows.list(), snapshot);
  assert.deepEqual(await workflows.listGroups(), groups);
  storage.writeJson = write;
  await assert.rejects(workflows.moveGroup({ workflowId: saved.id, groupId: 'missing' }), { code: 'GROUP_NOT_FOUND' });
  await assert.rejects(workflows.removeGroup({ id: 'missing' }), { code: 'GROUP_NOT_FOUND' });
});

test('未分组支持组内排序并拒绝跨组移动', async t => {
  const { workflows } = await domains(t);
  for (const id of ['a', 'b', 'c']) {
    await workflows.save({ id, nodes: [{ id: 'input', type: 'text.input' }], ...(id === 'b' ? { group: '其他组' } : {}) });
  }
  assert.deepEqual(await workflows.reorder({ workflowId: 'a', targetId: 'c', position: 'before' }), ['a', 'b', 'c']);
  await assert.rejects(workflows.reorder({ workflowId: 'a', targetId: 'b', position: 'before' }), /同一/);
  assert.equal((await workflows.read('a')).groupId, undefined);
});

test('same-group reorder preserves other slots, definitions, timestamps and history across restart', async t => {
  const { workflows, storage } = await domains(t);
  const save = (id, group) => workflows.save({ id, name: id, group, nodes: [{ id: 'input', type: 'text.input' }] });
  await save('a', 'G');
  await save('other', 'Other');
  await save('b', 'G');
  await save('c', 'G');
  const before = await workflows.list();
  const historyKey = 'plugin-data/work-flow/runs/a.json';
  await storage.writeJson(historyKey, [{ id: 'paused', status: 'interrupted' }]);
  const history = await storage.readJson(historyKey);
  assert.deepEqual(await workflows.reorder({ workflowId: 'a', targetId: 'c', position: 'before' }), ['a', 'c', 'other', 'b']);
  const reloaded = new Workflows({ storage, pluginId: PLUGIN_ID });
  assert.deepEqual((await reloaded.list()).map(item => item.id), ['a', 'c', 'other', 'b']);
  assert.deepEqual((await reloaded.list()).find(item => item.id === 'a'), before.find(item => item.id === 'a'));
  assert.deepEqual(await storage.readJson(historyKey), history);
  assert.deepEqual(await workflows.reorder({ workflowId: 'a', targetId: 'a', position: 'after' }), ['a', 'c', 'other', 'b']);
  assert.deepEqual(await workflows.reorder({ workflowId: 'a', targetId: 'b', position: 'after' }), ['c', 'b', 'other', 'a']);
  await assert.rejects(workflows.reorder({ workflowId: 'a', targetId: 'other', position: 'before' }), /同一/);
  await assert.rejects(workflows.reorder({ workflowId: 'missing', targetId: 'a', position: 'before' }), /保存/);
  await assert.rejects(workflows.reorder({ workflowId: 'a', targetId: 'b', position: 'bad' }), /位置/);
  const group = (await workflows.listGroups()).find(item => item.name === 'G');
  await workflows.removeGroup({ id: group.id });
  assert.deepEqual(await workflows.reorder({ workflowId: 'a', targetId: 'b', position: 'before' }), ['c', 'a', 'other', 'b']);
});
