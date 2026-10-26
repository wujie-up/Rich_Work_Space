import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const module = await import('../src/main/common/menu-workflow.js').catch(() => ({}));
const catalog = [{ key: 's:ADMIN', kind: 'SYSTEM', code: 'ADMIN', name: '管理', system: 'ADMIN', parent: '', level: 0 }];
const draft = { key: 'd:menu', kind: 'MENU', code: 'new', name: '新菜单', parent: 's:ADMIN', path: '/new', sort: 0 };
async function fixture(t) {
  assert.equal(typeof module.MenuWorkflows, 'function');
  const storage = await temporaryStore(t);
  const calls = [];
  const tasks = { call: async (id, input) => { calls.push({ id, input }); return { state: 'running' }; } };
  const api = { snapshot: async () => catalog, appCodes: async () => [], sync: async () => ({ synced: true }) };
  const menus = new module.MenuWorkflows({ storage, tasks, pluginId: 'work-flow', api: () => api });
  await menus.prepare('run', 'load');
  return { menus, storage, calls, tasks, api };
}
test('token 不落盘；确认按 revision，SQL 未完成树确认不可获取', async t => {
  const { menus, storage } = await fixture(t);
  await menus.load({ runId: 'run', revision: 0, connection: { token: 'private-token' } });
  let state = await menus.read('run');
  await assert.rejects(menus.sql('run'), /确认/);
  state = await menus.edit({ runId: 'run', revision: state.revision, drafts: [draft] });
  await assert.rejects(menus.confirm('run', 'tree', { revision: state.revision - 1 }), /修订/);
  await menus.confirm('run', 'load', { revision: state.revision });
  await menus.confirm('run', 'tree', { revision: state.revision });
  await menus.confirm('run', 'code', { revision: state.revision, skip: true });
  await menus.confirm('run', 'sql', { revision: state.revision });
  assert.match((await menus.sql('run')).sql, /COMMIT;/);
  const saved = await menus.exportSql('run', storage.root);
  assert.equal(await readFile(saved.path, 'utf8'), (await menus.sql('run')).sql);
  await assert.rejects(menus.exportSql('run', storage.root), /已存在/);
  assert.ok(!JSON.stringify(await storage.readJson('plugin-data/work-flow/menu/run.json')).includes('private-token'));
});
test('延迟计划回包不能覆盖新修订；本地 appCode 在重复编辑后保持一致', async t => {
  const { menus, tasks } = await fixture(t);
  await menus.load({ runId: 'run', revision: 0, connection: { token: 'token' } });
  let state = await menus.read('run');
  await menus.plan({ runId: 'run', revision: state.revision, text: '新增', cwd: '/tmp' });
  let reply;
  tasks.call = async id => id === 'agent.task.read.v1' ? new Promise(resolve => { reply = resolve; }) : {};
  const pending = menus.poll({ runId: 'run', kind: 'plan' });
  while (!reply) { await new Promise(resolve => setImmediate(resolve)); }
  state = await menus.edit({ runId: 'run', revision: state.revision, drafts: [draft] });
  const appCode = state.drafts[0].appCode;
  reply({ state: 'succeeded', output: JSON.stringify({ additions: [{ ...draft, key: 'd:old', code: 'old' }], questions: [] }) });
  await pending;
  state = await menus.edit({ runId: 'run', revision: state.revision, drafts: [{ ...state.drafts[0], name: '改名' }] });
  assert.deepEqual(state.drafts.map(item => item.key), ['d:menu']);
  assert.equal(state.drafts[0].appCode, appCode);
});
test('生成前刷新检查冲突，摘要变化阻断代码确认，机构同步必须确认已执行 SQL', async t => {
  const { menus, tasks, api } = await fixture(t);
  await menus.load({ runId: 'run', revision: 0, connection: { token: 'token' } });
  let state = await menus.read('run');
  state = await menus.edit({ runId: 'run', revision: state.revision, drafts: [draft] });
  await menus.confirm('run', 'load', { revision: state.revision });
  await menus.confirm('run', 'tree', { revision: state.revision });
  const internal = await menus.session('run');
  internal.codeTask = { taskKey: 'k', state: 'succeeded', digest: 'old' };
  tasks.call = async () => ({ state: 'succeeded', digest: 'new' });
  await assert.rejects(menus.confirm('run', 'code', { revision: state.revision, digest: 'old' }), /摘要/);
  await menus.confirm('run', 'code', { revision: state.revision, skip: true });
  api.appCodes = async () => [state.drafts[0].appCode];
  await assert.rejects(menus.confirm('run', 'sql', { revision: state.revision }), /appCode/);
  api.appCodes = async () => [];
  await menus.confirm('run', 'sql', { revision: state.revision });
  await assert.rejects(menus.sync({ runId: 'run', sqlExecuted: false }), /手动执行/);
  assert.deepEqual(await menus.sync({ runId: 'run', sqlExecuted: true, menuId: '1', institutions: '2' }), { synced: true });
});
test('修改清空下游确认和产物，旧 AI 回包不覆盖新草稿', async t => {
  const { menus, calls } = await fixture(t);
  await menus.load({ runId: 'run', revision: 0, connection: { token: 'token' } });
  let state = await menus.read('run');
  await menus.plan({ runId: 'run', revision: state.revision, text: '添加菜单', cwd: '/tmp' });
  const previous = calls.at(-1).input.taskKey;
  state = await menus.edit({ runId: 'run', revision: state.revision, drafts: [draft] });
  assert.ok(calls.some(call => call.id === 'agent.task.cancel.v1' && call.input.taskKey === previous));
  await assert.rejects(menus.confirm('run', 'code', { revision: state.revision, skip: true }), /资源树/);
  assert.equal(state.drafts.length, 1);
});
test('启动等待期间停止运行，迟到的启动回包不能恢复任务或连接', async t => {
  const { menus, tasks } = await fixture(t);
  await menus.load({ runId: 'run', revision: 0, connection: { token: 'token' } });
  let reply;
  let cancelled = 0;
  tasks.call = async (id, input, options) => {
    if (id.endsWith('start.v1')) {
      assert.ok(options.signal);
      return new Promise(resolve => { reply = resolve; });
    }
    cancelled++;
    return { state: 'cancelled' };
  };
  const state = await menus.read('run');
  const starting = menus.plan({ runId: 'run', revision: state.revision, text: '新增', cwd: '/tmp' });
  while (!reply) { await new Promise(resolve => setImmediate(resolve)); }
  await menus.cancel('run');
  reply({ state: 'running' });
  await starting;
  const stopped = await menus.read('run');
  assert.equal(stopped.planTask.state, 'cancelled');
  assert.equal(stopped.connected, false);
  assert.equal(cancelled, 2);
});
