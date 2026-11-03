import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('diagram controls sit at the right edge and hide after inactivity', { timeout: 60000 }, async t => {
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
  await frame.locator('#editor').fill('```mermaid\ngraph TD\n A[开始] --> B[预览]\n```');
  const figure = frame.locator('figure[data-rendered="mermaid"]');
  await figure.waitFor();
  await figure.click();
  const viewer = frame.locator('#diagram-viewer');
  const tools = viewer.locator('.diagram-tools');
  await tools.waitFor();
  const placement = await viewer.evaluate(element => {
    const dialog = element.getBoundingClientRect();
    const tools = element.querySelector('.diagram-tools').getBoundingClientRect();
    return { right: dialog.right - tools.right, center: tools.y + tools.height / 2 - (dialog.y + dialog.height / 2),
      vertical: tools.height > tools.width };
  });
  assert.ok(placement.right >= 0 && placement.right <= 24 && Math.abs(placement.center) <= 2 && placement.vertical,
    'zoom controls must form a vertical group centered near the right border');
  await tools.waitFor({ state: 'hidden', timeout: 4500 });
  assert.equal(await viewer.getByRole('button', { name: '关闭', exact: true }).isVisible(), true);
  const zone = viewer.locator('.diagram-tools-zone');
  await zone.hover();
  await tools.waitFor();
  await viewer.getByRole('button', { name: '放大', exact: true }).click();
  assert.equal(await tools.locator('output').textContent(), '125%');
  await page.waitForTimeout(1800);
  await viewer.getByRole('button', { name: '缩小', exact: true }).click();
  assert.equal(await tools.locator('output').textContent(), '100%');
  await page.waitForTimeout(1800);
  assert.equal(await tools.isVisible(), true, 'each zoom action must restart the idle timeout');
  await tools.waitFor({ state: 'hidden', timeout: 2000 });
  await zone.focus();
  await zone.press('Tab');
  assert.equal(await tools.getByRole('button', { name: '缩小', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.waitForTimeout(3200);
  assert.equal(await tools.isVisible(), true, 'keyboard controls must remain available while focused');
  await viewer.getByRole('button', { name: '关闭', exact: true }).focus();
  await tools.waitFor({ state: 'hidden', timeout: 4500 });
  await viewer.getByRole('button', { name: '关闭', exact: true }).click();
  await figure.click();
  await tools.waitFor();
  assert.equal(await tools.locator('output').textContent(), '100%');
  await viewer.getByRole('button', { name: '关闭', exact: true }).click();

  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    await figure.waitFor();
    await figure.click();
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      await zone.hover();
      await tools.waitFor();
      const within = await tools.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
      });
      assert.equal(within, true);
      await viewer.screenshot({ path: resolve(`.test-results/text-editor/diagram-tools-${theme}-${width}.png`) });
    }
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
  }
  assert.deepEqual(errors, []);
});
