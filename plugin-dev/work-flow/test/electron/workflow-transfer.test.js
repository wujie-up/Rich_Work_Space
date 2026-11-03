import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, toggleTheme } from '../../../../desk/test/electron/helpers.js';

// Native picker responses are deterministic; the packaged host and sandboxed plugin bridge remain real.
test('工作流 JSON 导入导出：编辑、取消、新建、二次确认更新及明暗窄窗口', { timeout: 120000 }, async t => {
  const { app, page, data } = await launch(t, { executablePath: '/Applications/DeskPG.app/Contents/MacOS/DeskPG',
    openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const { version } = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  await page.evaluate(async source => {
    const preview = await workDesk.plugins.preview('work-flow', 'upgrade');
    await workDesk.plugins.upgrade('work-flow', source, preview.confirmationToken);
  }, resolve(`plugin-dev/dist/work-flow-${version}.plg`));
  await page.evaluate(() => workDesk.plugins.enable('work-flow'));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '原流程', nodes: [
    { id: 'start', type: 'flow.start', title: '开始', params: {}, x: 0, y: 0 },
    { id: 'end', type: 'flow.end', title: '结束', params: { input: '保留内容' }, x: 250, y: 0 }
  ], edges: [{ from: 'start', to: 'end' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  const importButton = frame.getByRole('button', { name: '导入工作流', exact: true });
  const exportButton = frame.getByRole('button', { name: '导出工作流', exact: true });
  await importButton.waitFor({ timeout: 5000 });
  for (const button of [importButton, exportButton]) {
    assert.equal((await button.innerText()).trim(), '');
    assert.ok(await button.getAttribute('title'));
    assert.equal(await button.locator('svg[aria-hidden="true"]').count(), 1);
  }
  await frame.locator('#workflow-name').fill('未保存的导出内容');
  const picker = async path => app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: !path, filePaths: path ? [path] : [] });
  }, path);
  await picker(data);
  await exportButton.click();
  await frame.locator('#status-text').filter({ hasText: '已导出' }).waitFor();
  const path = join(data, (await readdir(data)).find(name => name.endsWith('.workflow.json')));
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.workflow.name, '未保存的导出内容');
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).name, '原流程');
  await picker(null);
  await importButton.click();
  assert.equal(await frame.locator('#workflow-name').inputValue(), '未保存的导出内容');
  await picker(path);
  await importButton.click();
  const dialog = frame.getByRole('dialog', { name: '导入工作流', exact: true });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /未保存的导出内容 · 2 个节点/);
  await page.keyboard.press('Escape');
  assert.equal(await frame.locator('#workflow-name').inputValue(), '未保存的导出内容');
  await importButton.click();
  await dialog.locator('[data-target]').selectOption(workflow.id);
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  const confirmation = frame.getByRole('dialog', { name: '确认更新工作流', exact: true });
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).name, '原流程');
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认更新', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await frame.locator('#status-text').filter({ hasText: '已导入' }).waitFor();
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).name, '未保存的导出内容');
  const count = (await invoke('workflows.list')).length;
  await frame.locator('#workflow-name').fill('其他流程导入前的草稿');
  await importButton.click();
  await dialog.locator('[data-target]').selectOption('');
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await frame.locator('#status-text').filter({ hasText: '已导入' }).waitFor();
  assert.equal((await invoke('workflows.list')).length, count + 1);
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  assert.equal(await frame.locator('#workflow-name').inputValue(), '其他流程导入前的草稿');
  await frame.getByRole('button', { name: '运行', exact: true }).click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  assert.equal((await invoke('workflows.list')).find(item => item.id === workflow.id).name, '其他流程导入前的草稿');
  const invalid = join(data, 'invalid.json');
  await writeFile(invalid, '{broken');
  await picker(invalid);
  await importButton.click();
  await frame.locator('#status-text').filter({ hasText: '不是有效的 JSON' }).waitFor();
  assert.equal((await invoke('workflows.list')).length, count + 1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  await picker(path);
  await importButton.click();
  await dialog.waitFor();
  const box = await dialog.boundingBox();
  assert.ok(box.width < 900);
  await dialog.locator('[data-target]').focus();
  assert.equal(await dialog.locator('[data-target]').evaluate(element => element === document.activeElement), true);
  await mkdir('.test-results/work-flow', { recursive: true });
  await page.screenshot({ path: '.test-results/work-flow/workflow-transfer-light.png' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await toggleTheme(page);
  await importButton.click();
  await dialog.waitFor();
  await page.screenshot({ path: '.test-results/work-flow/workflow-transfer-dark.png' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});
