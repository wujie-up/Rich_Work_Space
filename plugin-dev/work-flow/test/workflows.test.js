import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Workflows } from '../src/main/common/workflows.js';
import { Credentials } from '../src/main/common/credentials.js';

const PLUGIN_ID = 'work-flow';

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
