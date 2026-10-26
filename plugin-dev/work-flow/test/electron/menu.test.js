import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packPackage } from '../../../../desk/src/main/common/plugin-package.js';
import { launch } from '../../../../desk/test/electron/helpers.js';

// Only external transport/model boundaries are fixtures. Production UI, engine, SQL and capability RPC remain real.
async function fixtures(root) {
  const workflow = join(root, 'workflow');
  await mkdir(workflow);
  for (const file of ['plugin.json', 'package.json', 'src', 'dist', 'ico', 'title.md']) {
    await cp(resolve('plugin-dev/work-flow', file), join(workflow, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(join(workflow, 'plugin.json'), 'utf8'));
  manifest.main = 'fixture.js';
  await writeFile(join(workflow, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(workflow, 'fixture.js'), `
import { MenuApi } from './src/main/common/menu-api.js';
import { activate as original } from './src/main/common/index.js';
export { deactivate } from './src/main/common/index.js';
export async function activate(context) {
  MenuApi.prototype.request = async function(path, body) {
    if (path.startsWith('/sys/role-menu-rel/tree')) {
      return [{systemCode:'ADMIN',systemName:'管理',menus:[{id:'9223372036854775806',parentId:0,
        menuType:'DIR',menuCode:'ops',menuName:'运营',treeLevel:1,buttons:[],children:[]}]}];
    }
    if (path === '/sys/menu/page') { return {pages:1,records:[{appCode:'existing-app'}]}; }
    if (path === '/sys/permission/data-sync/sync-menu') {
      await context.storage.writeJson('plugin-data/work-flow/sync-fixture.json', {body});
      return true;
    }
    throw Error('Unexpected fixture API: '+path);
  };
  await original(context);
}
`);
  const agent = join(root, 'agent');
  await mkdir(agent);
  await writeFile(join(agent, 'plugin.json'), JSON.stringify({ id: 'menu-test-agent', name: '菜单测试 Agent', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: true, background: 'service', main: 'index.mjs' }));
  await writeFile(join(agent, 'index.mjs'), `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function deactivate() {}
export async function activate(context) {
  const tasks = new Map();
  const plan = {additions:[
    {key:'d:orders',kind:'MENU',name:'订单',code:'orders',parent:'m:9223372036854775806',path:'/orders',sort:0},
    {key:'d:create',kind:'BUTTON',name:'新增订单',code:'orders:create',parent:'d:orders',sort:0}],questions:[]};
  for (const [id, effects, handler] of [
    ['agent.menu.plan.start.v1',['workspace.read'], async input => {
      tasks.set(input.taskKey,{state:'succeeded',output:JSON.stringify(plan)}); return {state:'running'};
    }],
    ['agent.menu.code.start.v1',['workspace.write'], async input => {
      const file = input.files[0]; const path = join(input.cwd,file); const before = await readFile(path,'utf8');
      const mapping = input.prompt.match(/菜单映射：([^\\n]+)/)[1];
      const after = before+'\\n// '+mapping+'\\n'; await writeFile(path,after);
      tasks.set(input.taskKey,{state:'succeeded',output:'完成映射；本地夹具验证通过',digest:'a'.repeat(64),diff:[{file,before,after}]});
      return {state:'running'};
    }],
    ['agent.task.read.v1',['workspace.read'], input => tasks.get(input.taskKey)],
    ['agent.task.cancel.v1',['workspace.read'], input => { tasks.set(input.taskKey,{state:'cancelled'}); return {state:'cancelled'}; }],
    ['agent.task.respond.v1',['workspace.write'], () => ({accepted:true})]
  ]) {
    await context.capabilities.register({id,version:1,title:id,description:id,state:'ready',effects,confirmation:'policy',
      inputSchema:{type:'object'},outputSchema:{type:'object'},execution:{timeoutMs:30000,cancellable:true,retry:'never'}},handler);
  }
}
`);
  const packages = [join(root, 'workflow.plg'), join(root, 'agent.plg')];
  await packPackage(workflow, packages[0]);
  await packPackage(agent, packages[1]);
  return packages;
}
async function install(app, page, path) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path);
  await page.evaluate(() => workDesk.plugins.install());
}

test('DeckPg 安装包：菜单计划、资源树、代码审批与审查、完整 SQL、手动同步', { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-menu-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = await fixtures(root);
  const cwd = join(root, 'repo');
  await mkdir(cwd);
  await writeFile(join(cwd, 'Registry.java'), 'class Registry {}');
  const { app, page, data, logs } = await launch(t, { openPlugin: false });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await mkdir(resolve('.test-results/work-flow'), { recursive: true });
    await writeFile(resolve('.test-results/work-flow/menu.log'), logs.join(''));
  });
  await page.evaluate(async () => {
    const record = (await workDesk.plugins.list()).find(item => item.id === 'work-flow');
    if (record && record.state !== 'uninstalled') {
      const preview = await workDesk.plugins.preview(record.id, 'remove');
      await workDesk.plugins.remove(record.id, 'clear', preview.confirmationToken);
    }
  });
  for (const file of packages) { await install(app, page, file); }
  await page.evaluate(() => workDesk.plugins.enable('menu-test-agent'));
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible');
  await frame.locator('#new-menu-workflow').click();
  await frame.locator('#run').click();
  await frame.locator('#menu-token').fill('fixture-secret-token');
  await frame.locator('#menu-role').fill('1');
  await frame.locator('[data-action="load"]').click();
  await frame.locator('[data-tree="m:9223372036854775806"]').waitFor();
  await frame.locator('[data-action="confirm"]').click();
  await frame.locator('#menu-text').fill('在运营菜单下加入订单菜单，在订单菜单下加入新增订单按钮；编码 orders 和 orders:create，路由 /orders');
  await frame.locator('#menu-cwd').fill(cwd);
  await frame.locator('#menu-providerId').selectOption('menu-test-agent');
  await frame.locator('[data-action="plan"]').click();
  await frame.locator('[data-tree="d:create"]').waitFor({ timeout: 30000 });
  assert.equal(await frame.locator('.menu-new').count(), 2);
  await frame.locator('[data-action="confirm"]').click();
  await frame.locator('#menu-scope').fill('Registry.java | 注册新增菜单 appCode');
  await frame.locator('[data-action="code"]').click();
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await frame.locator('.menu-diff').waitFor({ timeout: 30000 });
  await frame.locator('[data-action="confirm-code"]').click();
  assert.match(await frame.locator('#menu-error').textContent(), /勾选/);
  await frame.locator('#menu-reviewed').check();
  await frame.locator('[data-action="confirm-code"]').click();
  await frame.locator('.menu-sql').waitFor();
  const preview = await frame.locator('.menu-sql').textContent();
  assert.match(preview, /START TRANSACTION;/);
  assert.match(preview, /sys_menu_resource_rel/);
  await frame.locator('[data-action="confirm"]').click();
  await frame.locator('[data-action="download"]').waitFor();
  const sql = await frame.locator('.menu-sql').textContent();
  const code = await readFile(join(cwd, 'Registry.java'), 'utf8');
  const codeValue = code.match(/[a-f0-9]{32}/)[0];
  assert.ok(sql.includes(codeValue), 'Java 和 SQL 使用相同 appCode');
  assert.match(sql, /COMMIT;/);
  const output = join(root, 'output');
  await mkdir(output);
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, output);
  await frame.locator('[data-action="download"]').click();
  await frame.locator('#menu-export-result', { hasText: '已保存' }).waitFor();
  const savedPath = (await frame.locator('#menu-export-result').textContent()).replace('已保存：', '');
  assert.match(savedPath, /menu-.+\.sql$/);
  assert.equal(await readFile(savedPath, 'utf8'), sql);
  await frame.getByText('执行 SQL 后，手动同步机构', { exact: true }).click();
  await frame.locator('[data-action="roots"]').click();
  await frame.locator('#menu-root option[value="9223372036854775806"]').waitFor({ state: 'attached' });
  await frame.locator('#menu-institutions').fill('9223372036854775805,2');
  await frame.locator('[data-action="sync"]').click();
  assert.match(await frame.locator('#menu-error').textContent(), /手动执行/);
  await assert.rejects(readFile(join(data, 'plugin-data/work-flow/sync-fixture.json')));
  await frame.locator('#menu-executed').check();
  await frame.locator('[data-action="sync"]').click();
  await frame.locator('#menu-sync-result', { hasText: '同步成功' }).waitFor();
  assert.equal(await frame.locator('#menu-error').textContent(), '');
  const sync = JSON.parse(await readFile(join(data, 'plugin-data/work-flow/sync-fixture.json'), 'utf8'));
  assert.ok(sync.body.includes('9223372036854775806'));
  assert.ok(sync.body.includes('9223372036854775805'));
  const workflows = JSON.parse(await readFile(join(data, 'plugin-data/work-flow/workflows.json'), 'utf8'));
  const workflow = workflows.items.find(item => item.name === 'AI 菜单初始化');
  const runs = JSON.parse(await readFile(join(data, 'plugin-data/work-flow/runs', workflow.id + '.json'), 'utf8'));
  assert.equal(runs.at(-1).status, 'succeeded');
  const session = await readFile(join(data, 'plugin-data/work-flow/menu', runs.at(-1).id + '.json'), 'utf8');
  assert.ok(!session.includes('fixture-secret-token'));
  assert.deepEqual(errors, []);
  await mkdir(resolve('.test-results/work-flow'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/work-flow/menu-sql.png') });
});
