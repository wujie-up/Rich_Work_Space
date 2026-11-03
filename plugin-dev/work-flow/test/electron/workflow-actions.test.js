import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

test('最新 DeskPG：图标操作、新建入口和工作流删除二次确认', { timeout: 120000 }, async t => {
  const { app, page } = await launch(t, { executablePath: '/Applications/DeskPG.app/Contents/MacOS/DeskPG',
    openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  // The latest installation already includes this plugin; verify the packaged version instead of installing twice.
  const installed = await page.evaluate(() => workDesk.plugins.list());
  assert.equal(installed.find(plugin => plugin.id === 'work-flow')?.version, manifest.version);
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const graph = { nodes: [{ id: 'start', type: 'flow.start', params: {} }, { id: 'end', type: 'flow.end', params: {} }],
    edges: [{ from: 'start', to: 'end' }] };
  const workflow = await invoke('workflows.save', { name: '待删除 <研发流程>', ...graph });
  const retained = await invoke('workflows.save', { name: '保留流程', ...graph });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  for (const [id, label] of [['save', '保存'], ['run', '运行'], ['cancel-run', '停止'],
    ['new-workflow', '新建工作流'], ['delete-workflow', '删除工作流']]) {
    const button = frame.locator(`#${id}`);
    assert.equal(await button.getAttribute('aria-label'), label);
    assert.equal(await button.getAttribute('title'), label);
    assert.equal((await button.innerText()).trim(), '');
    assert.equal(await button.locator('svg[aria-hidden="true"]').count(), 1);
  }
  assert.equal(await frame.locator('#new-menu-workflow').count(), 0);
  assert.equal(await frame.locator('.workflow-sidebar #delete-workflow').count(), 0);
  const sidebar = await frame.locator('.workflow-sidebar').boundingBox();
  const add = await frame.locator('#new-workflow').boundingBox();
  assert.ok(add.y > sidebar.y + sidebar.height - 60, '新建入口固定在列表底部');
  const count = await frame.locator('.node').count();
  await frame.locator('#add-node').click();
  const picker = frame.getByRole('dialog', { name: '添加节点', exact: true });
  await picker.waitFor();
  assert.equal(await frame.locator('.node').count(), count);
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await frame.locator('.node').count(), count);
  await frame.locator('#add-node').click();
  await picker.locator('#node-category').selectOption('flow');
  await picker.locator('#node-capability').selectOption('flow.route');
  await picker.getByRole('button', { name: '添加', exact: true }).click();
  assert.equal(await frame.locator('.node').count(), count + 1);
  assert.equal(await frame.locator('.node.shape-route .node-outline path').count(), 1);
  assert.equal(await frame.locator('.node.shape-terminal').count(), 2);
  await frame.locator('#delete-workflow').click();
  const dialog = frame.getByRole('dialog', { name: '删除工作流' });
  await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /待删除 <研发流程>/);
  assert.ok((await invoke('workflows.list')).some(item => item.id === workflow.id));
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.ok((await invoke('workflows.list')).some(item => item.id === workflow.id));
  await frame.locator('#delete-workflow').click();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.ok((await invoke('workflows.list')).some(item => item.id === workflow.id));
  await frame.locator('#delete-workflow').click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await frame.locator(`[data-workflow="${workflow.id}"]`).waitFor({ state: 'detached' });
  const remaining = await invoke('workflows.list');
  assert.ok(!remaining.some(item => item.id === workflow.id));
  assert.ok(remaining.some(item => item.id === retained.id));
  assert.equal(await frame.locator('#status').innerText(), '');
  await frame.locator('#new-workflow').click();
  assert.equal(await frame.locator('#workflow-name').inputValue(), '新建工作流');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
  assert.ok(await frame.locator('#delete-workflow').isVisible());
  await frame.locator('#toggle-list').click();
  assert.equal(await frame.locator('#new-workflow').isVisible(), false);
  await frame.locator('#toggle-list').click();
  assert.ok(await frame.locator('#new-workflow').isVisible());
  await mkdir('.test-results/work-flow', { recursive: true });
  await page.screenshot({ path: '.test-results/work-flow/workflow-actions-narrow.png' });
});

test('最新 DeskPG：重启前的普通服务运行显示已中断，保留历史并允许重新运行', { timeout: 120000 }, async t => {
  const workflows = ['waiting', 'running'].map(status => ({ id: `stale-${status}`, name: `重启前${status}`,
    nodes: [{ id: 'start', type: 'flow.start', params: {} }, { id: 'end', type: 'flow.end', params: {} }],
    edges: [{ from: 'start', to: 'end' }] }));
  const { app, page } = await launch(t, { executablePath: '/Applications/DeskPG.app/Contents/MacOS/DeskPG',
    openPlugin: false, prepareData: async data => {
      const directory = resolve(data, 'plugin-data/work-flow');
      await mkdir(resolve(directory, 'runs'), { recursive: true });
      await writeFile(resolve(directory, 'workflows.json'), JSON.stringify({ version: 1, items: workflows }));
      for (const workflow of workflows) {
        const status = workflow.id.slice('stale-'.length);
        await writeFile(resolve(directory, `runs/${workflow.id}.json`), JSON.stringify([{ id: workflow.id,
          workflowId: workflow.id, status, startedAt: Date.now(), nodes: {}, pending: { kind: 'service', nodeId: 'end' } }]));
      }
    } });
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  // The latest installation already includes this plugin; verify the packaged version instead of installing twice.
  const installed = await page.evaluate(() => workDesk.plugins.list());
  assert.equal(installed.find(plugin => plugin.id === 'work-flow')?.version, manifest.version);
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  for (const workflow of workflows) {
    await frame.locator(`[data-workflow="${workflow.id}"]`).click();
    await frame.getByText('插件已重启，本次运行不自动恢复，请核对外部结果后重新运行。', { exact: true }).waitFor();
    assert.ok(await frame.locator('#run').isEnabled());
    assert.ok(await frame.locator('#cancel-run').isDisabled());
    const history = await page.evaluate(id => workDesk.plugins.invoke('work-flow', 'runs.list', [id]), workflow.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, workflow.id.slice('stale-'.length), '仅修正显示，不覆盖历史');
    await frame.locator('#run').click();
    await frame.locator('#status').filter({ hasText: '运行完成' }).waitFor();
    assert.ok(await frame.locator('#run').isEnabled());
    t.diagnostic(`${workflow.id}：已中断显示、原历史保留、重新运行完成，断言全部通过`);
  }
});
