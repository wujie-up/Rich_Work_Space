import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('presentation shows the entire unsaved document fullscreen and restores editing', { timeout: 120000 }, async t => {
  const { app, page } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, archive);
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#new').click();
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#editor').waitFor();
  const present = frame.getByRole('button', { name: '演示', exact: true });
  assert.equal(await frame.locator('#present').count(), 1, 'the top toolbar must offer presentation');
  const source = `# 演示文档\n\n${'这是完整正文。\n\n'.repeat(80)}全文最后一行`;
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.locator('#editor').fill(source);
  await present.click();
  await frame.locator('body[data-presenting]').waitFor();
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isFullScreen()) { await new Promise(resolve => window.once('enter-full-screen', resolve)); }
  });
  // macOS finishes its native transition after Electron reports fullscreen entry.
  await page.waitForTimeout(1000);
  assert.equal(await frame.locator('body').evaluate(element => document.fullscreenElement === element), true);
  await frame.getByRole('heading', { name: '演示文档' }).waitFor();
  assert.equal(await frame.locator('#editor').isVisible(), false);
  assert.equal(await frame.locator('header').isVisible(), false);
  await frame.getByText('全文最后一行', { exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await frame.locator('#preview').evaluate(element => element.scrollTop > 0));
  await frame.locator('#preview').evaluate(element => { element.scrollTop = 0; });
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await frame.locator('body').screenshot({ path: resolve('.test-results/text-editor/presentation.png') });
  await frame.getByRole('button', { name: '退出演示', exact: true }).click();
  await frame.locator('body[data-presenting]').waitFor({ state: 'hidden' });
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isFullScreen()) { await new Promise(resolve => window.once('leave-full-screen', resolve)); }
  });
  assert.equal(await frame.locator('#editor').inputValue(), source);
  assert.equal(await frame.locator('#panes').getAttribute('data-mode'), 'edit');
  assert.equal(await frame.locator('#editor').isVisible(), true);
  assert.equal(await frame.locator('#dirty').textContent(), '未保存');

  const text = '<img src=x onerror="window.injected=true">\n  保留缩进\n最后一行';
  await frame.locator('#new').click();
  await frame.locator('#type').selectOption('txt');
  await frame.locator('#filename').fill('演示纯文本.txt');
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  // The previous draft already has the same status; wait for this document before typing.
  await frame.locator('#document-name').filter({ hasText: '演示纯文本.txt' }).waitFor();
  await frame.locator('#editor').fill(text);
  await present.click();
  await frame.locator('body[data-presenting]').waitFor();
  await frame.locator('#preview pre').waitFor();
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window.isFullScreen()) { await new Promise(resolve => window.once('enter-full-screen', resolve)); }
  });
  assert.equal(await frame.locator('#preview pre').textContent(), text);
  assert.equal(await frame.locator('#preview img').count(), 0);
  // macOS finishes its native transition after Electron reports fullscreen entry.
  await page.waitForTimeout(1000);
  await frame.getByRole('button', { name: '退出演示', exact: true }).press('Escape');
  await frame.locator('body[data-presenting]').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#editor').inputValue(), text);
  assert.deepEqual(errors, []);
});
