import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openConfiguration, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('暂停后重选已确认文件，支持二次确认、双来源及依赖结果重算', { timeout: 90000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false, prepareData: async root => {
    await mkdir(join(root, 'desktop-files'), { recursive: true });
    await writeFile(join(root, 'desktop-files', '正确需求.md'), '正确需求');
  } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/work-flow/plugin.json'), 'utf8'));
  await page.evaluate(async source => {
    const preview = await workDesk.plugins.preview('work-flow', 'upgrade');
    await workDesk.plugins.upgrade('work-flow', source, preview.confirmationToken);
    await workDesk.plugins.enable('work-flow');
  }, resolve(`plugin-dev/dist/work-flow-${version}.plg`));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '确认后重选文件验证', nodes: [
    { id: 'start', type: 'flow.start', title: '开始', params: {}, x: 0, y: 0 },
    { id: 'file', type: 'flow.user-input', title: '需求文档', params: { interaction: 'file', title: '需求文档' }, x: 0, y: 0 },
    { id: 'derived', type: 'result.collect', title: '依赖文档', params: { input: '{{file.text}}' }, x: 250, y: 0 },
    { id: 'pause', type: 'flow.user-input', title: '下一份文档', params: { interaction: 'file', title: '下一份文档' }, x: 500, y: 0 },
    { id: 'end', type: 'flow.end', title: '输出', params: { input: '{{derived.items}}' }, x: 750, y: 0 }
  ], edges: [{ from: 'start', to: 'file' }, { from: 'file', to: 'derived' }, { from: 'derived', to: 'pause' }, { from: 'pause', to: 'end' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('#run').click();
  const dialog = frame.locator('dialog[aria-labelledby="user-input-title"]');
  const confirmation = frame.locator('dialog[aria-labelledby="reselect-file-title"]');
  const systemFile = async (name, text) => {
    await dialog.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
    await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  };
  await dialog.waitFor();
  assert.equal(await frame.locator('[data-reselect-file]').count(), 0);
  await systemFile('错误需求.md', '错误需求');
  await dialog.locator('#user-input-title').filter({ hasText: '下一份文档' }).waitFor();
  await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
  await frame.locator('#continue-run').waitFor({ state: 'visible' });
  const run = (await invoke('runs.list', workflow.id)).at(-1);
  const fileResult = frame.locator('details[data-result-node="file"]');
  await fileResult.locator(':scope > summary').click();
  await fileResult.getByRole('button', { name: '重新选择文件', exact: true }).click();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await invoke('runs.get', run.id)).nodes.file.output.file.name, '错误需求.md');
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  for (let index = 0; index < 2; index += 1) {
    if (index) { await toggleTheme(page); }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 650));
    await fileResult.getByRole('button', { name: '重新选择文件', exact: true }).click();
    const bounds = await confirmation.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= await page.evaluate(() => innerWidth));
    await page.screenshot({ path: join(output, `file-reselection-confirm-${index}.png`) });
    await confirmation.getByRole('button', { name: '确认重新选择', exact: true }).click();
    await dialog.locator('#user-input-title').filter({ hasText: '需求文档' }).waitFor();
    assert.equal(await dialog.locator('input[type="file"]').inputValue(), '');
    assert.equal((await invoke('runs.get', run.id)).nodes.derived, undefined);
    if (!index) {
      await dialog.getByLabel('文件来源', { exact: true }).selectOption('desktop');
      await dialog.getByRole('button', { name: '选择工作台文件', exact: true }).click();
      const picker = page.getByRole('dialog', { name: '选择工作台文件', exact: true });
      await picker.getByLabel('工作台文件', { exact: true }).selectOption('正确需求.md');
      await picker.getByRole('button', { name: '选择文件', exact: true }).click();
      await dialog.locator('[data-file-name]').filter({ hasText: '正确需求.md' }).waitFor();
      await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
    } else {
      await systemFile('最终需求.md', '最终需求');
    }
    await dialog.locator('#user-input-title').filter({ hasText: '下一份文档' }).waitFor();
    await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
    await frame.locator('#continue-run').waitFor({ state: 'visible' });
    assert.equal((await invoke('runs.get', run.id)).nodes.derived.output.items[0], index ? '最终需求' : '正确需求');
  }
  await frame.locator('#continue-run').click();
  await dialog.waitFor();
  await systemFile('补充.md', '补充');
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  const done = await invoke('runs.get', run.id);
  assert.equal(done.nodes.end.output.final, '最终需求');
  assert.equal(done.history.filter(entry => entry.nodeId === 'file').length, 2);
  assert.equal(await frame.locator('[data-reselect-file]').count(), 0);
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="work-flow"]').getByRole('button', { name: '插件配置', exact: true }).click();
  await page.locator('dialog.plugin-settings').waitFor();
  assert.deepEqual(errors, []);
});
