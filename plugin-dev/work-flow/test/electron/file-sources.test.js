import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { launch } from '../../../../desk/test/electron/helpers.js';

test('用户介入从工作台和系统选择文件，取消和中断均保留确认边界', { timeout: 90000 }, async t => {
  const text = '项目目录：/tmp/demo\n需求：双来源文件测试';
  const { app, page } = await launch(t, { openPlugin: false, prepareData: async root => {
    await mkdir(join(root, 'desktop-files'), { recursive: true });
    await writeFile(join(root, 'desktop-files', '工作台需求.md'), text);
    await writeFile(join(root, 'desktop-files', '空文档.md'), '');
  } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const configure = async () => {
    await page.locator('.account-trigger').click();
    await page.locator('#account-menu').getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.locator('#settings-panel .plugin-toolbar').waitFor();
  };
  await page.evaluate(() => workDesk.plugins.enable('work-flow'));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '双来源验证', nodes: [
    { id: 'start', type: 'flow.start', params: {}, x: 0, y: 0 },
    { id: 'file', type: 'flow.user-input', params: { interaction: 'file', title: '选择需求文档' }, x: 250, y: 0 },
    { id: 'end', type: 'flow.end', params: { input: '{{file.text}}' }, x: 500, y: 0 }
  ], edges: [{ from: 'start', to: 'file' }, { from: 'file', to: 'end' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('#run').click();
  const dialog = frame.locator('dialog[aria-labelledby="user-input-title"]');
  const source = dialog.getByLabel('文件来源', { exact: true });
  await source.waitFor();
  assert.equal(await source.inputValue(), 'system');
  const running = (await invoke('runs.list', workflow.id)).at(-1);
  await source.selectOption('desktop');
  await dialog.getByRole('button', { name: '选择工作台文件', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择工作台文件', exact: true });
  await picker.waitFor();
  const centeredPicker = async () => {
    await page.waitForFunction(() => {
      const bounds = document.querySelector('dialog[aria-label="选择工作台文件"]').getBoundingClientRect();
      return Math.abs(bounds.x + bounds.width / 2 - innerWidth / 2) < 1
        && Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2) < 1;
    }, undefined, { timeout: 3000 });
  };
  await centeredPicker();
  await setTimeout(36000);
  assert.equal(await picker.isVisible(), true);
  await picker.press('Escape');
  assert.equal((await invoke('runs.get', running.id)).status, 'waiting');
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByRole('button', { name: '选择工作台文件', exact: true }).click();
  await picker.getByLabel('工作台文件', { exact: true }).selectOption('空文档.md');
  await picker.getByRole('button', { name: '选择文件', exact: true }).click();
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '请选择不超过' }).waitFor();
  await dialog.getByRole('button', { name: '选择工作台文件', exact: true }).click();
  await picker.getByLabel('工作台文件', { exact: true }).selectOption('工作台需求.md');
  // The picker rechecks its selection if a desktop file disappears while the dialog is open.
  await page.evaluate(() => workDesk.desktop.rename('工作台需求.md', '已改名.md'));
  await picker.getByRole('button', { name: '选择文件', exact: true }).click();
  await picker.getByRole('alert').filter({ hasText: '文件已被移走或删除' }).waitFor();
  await picker.getByRole('button', { name: '取消选择', exact: true }).click();
  await page.evaluate(() => workDesk.desktop.rename('已改名.md', '工作台需求.md'));
  await dialog.getByRole('button', { name: '选择工作台文件', exact: true }).click();
  await picker.getByLabel('工作台文件', { exact: true }).selectOption('工作台需求.md');
  await picker.getByRole('button', { name: '选择文件', exact: true }).click();
  await dialog.locator('[data-file-name]').filter({ hasText: '工作台需求.md' }).waitFor();
  assert.equal((await invoke('runs.get', running.id)).status, 'waiting');
  await source.selectOption('system');
  assert.equal(await dialog.locator('[data-file-name]').innerText(), '');
  await dialog.locator('input[type="file"]').setInputFiles({ name: '系统需求.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
  await frame.locator('#continue-run').click();
  await source.waitFor();
  assert.equal(await dialog.locator('input[type="file"]').inputValue(), '');
  await source.selectOption('desktop');
  await dialog.getByRole('button', { name: '选择工作台文件', exact: true }).click();
  await picker.getByLabel('工作台文件', { exact: true }).selectOption('工作台需求.md');
  await picker.getByRole('button', { name: '选择文件', exact: true }).click();
  await dialog.locator('[data-file-name]').filter({ hasText: '工作台需求.md' }).waitFor();
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, 'file-sources.png') });
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  const done = await invoke('runs.get', running.id);
  assert.equal(done.nodes.file.output.text, text);
  assert.equal(done.nodes.file.output.file.name, '工作台需求.md');
  assert.equal(done.nodes.end.output.final, text);
  await frame.locator('#run').click();
  await source.waitFor();
  await dialog.locator('input[type="file"]').setInputFiles({ name: '系统需求.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  assert.equal((await invoke('runs.get', (await invoke('runs.list', workflow.id)).at(-1).id)).nodes.file.output.file.name, '系统需求.md');
  for (let index = 0; index < 2; index += 1) {
    await configure();
    await page.locator('#theme-settings').click();
    const current = await page.locator('html').getAttribute('data-theme');
    await page.locator('#theme-mode').selectOption(current === 'dark' ? 'light' : 'dark');
    await page.getByRole('button', { name: '关闭配置', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 650));
    await frame.locator('#run').click();
    await source.selectOption('desktop');
    await dialog.getByRole('button', { name: '选择工作台文件', exact: true }).click();
    await picker.waitFor();
    await centeredPicker();
    const bounds = await picker.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= await page.evaluate(() => innerWidth), JSON.stringify(bounds));
    const theme = await page.locator('html').getAttribute('data-theme');
    await picker.evaluate(panel => Promise.allSettled(panel.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: join(output, `file-picker-narrow-${theme}.png`) });
    await picker.press('Escape');
    await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await frame.locator('#continue-run').waitFor({ state: 'visible' });
  }
  await configure();
  await page.locator('.plugin-card[data-plugin="work-flow"]').getByRole('button', { name: '插件配置', exact: true }).click();
  await page.locator('dialog.plugin-settings').waitFor();
  assert.deepEqual(errors, []);
});
