import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('missing disk files show explicit notices in groups and history, and restored files open normally', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const root = join(await realpath(data), 'documents');
  await mkdir(root);
  for (const name of ['建表.sql', 'keep.txt']) {
    await writeFile(join(root, name), name);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, join(root, name));
    await frame.locator('#open').click();
    await frame.locator('#document-name').filter({ hasText: name }).waitFor();
  }
  const missing = frame.locator('#group-files').getByRole('button', { name: '建表.sql', exact: true });
  const live = frame.locator('#group-files').getByRole('button', { name: 'keep.txt', exact: true });
  await frame.locator('#editor').fill('unfinished live document');
  await unlink(join(root, '建表.sql'));
  await missing.click();
  await frame.locator('#status.error').filter({ hasText: 'ENOENT' }).waitFor();
  assert.equal(await missing.getAttribute('data-missing'), 'true');
  assert.equal(await frame.locator('#document-name').textContent(), 'keep.txt');
  assert.equal(await frame.locator('#editor').inputValue(), 'unfinished live document');
  assert.equal(await missing.getAttribute('title'), join(root, '建表.sql'));
  assert.match(await missing.getAttribute('aria-description'), /不存在/);
  assert.equal(await missing.locator('.file-missing').textContent(), '文件不存在');
  assert.equal(await live.locator('.file-missing').count(), 0);
  await frame.locator('#history-toggle').click();
  const historical = frame.locator('#history').getByRole('button', { name: '建表.sql', exact: true });
  await historical.waitFor();
  assert.equal(await historical.getAttribute('data-missing'), 'true');
  assert.equal(await historical.locator('.file-missing').textContent(), '文件不存在');
  await historical.click();
  await frame.locator('#status.error').filter({ hasText: 'ENOENT' }).waitFor();
  assert.equal(await frame.locator('#history-panel').isVisible(), true);
  assert.equal(await historical.getAttribute('data-missing'), 'true');
  await frame.locator('#history-close').click();
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      assert.equal(await missing.locator('.file-label').evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
      assert.equal(await live.locator('.file-label').evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
      assert.equal(await missing.locator('.file-type-icon').evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
      assert.equal(await missing.locator('.file-missing').evaluate(node => {
        const row = node.closest('button').getBoundingClientRect();
        const label = node.getBoundingClientRect();
        return label.left >= row.left && label.right <= row.right && node.scrollWidth <= node.clientWidth;
      }), true, 'the complete missing-file notice remains inside the row at narrow widths');
      await missing.focus();
      assert.equal(await missing.evaluate(node => node.matches(':focus')), true);
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/missing-files-${theme}-${width}.png`) });
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 650));
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await frame.locator('#group-files button[data-missing=true]').waitFor();
  assert.equal(await missing.getAttribute('data-missing'), 'true', 'startup checks historical paths without opening them');
  await writeFile(join(root, '建表.sql'), 'SELECT 2;');
  await missing.click();
  await frame.locator('#document-name').filter({ hasText: '建表.sql' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), 'SELECT 2;');
  assert.equal(await missing.getAttribute('data-missing'), 'false');
  assert.equal(await missing.locator('.file-missing').count(), 0);
  assert.equal(await missing.locator('.file-label').evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
  await frame.locator('#history-toggle').click();
  await historical.waitFor();
  assert.equal(await historical.getAttribute('data-missing'), 'false');
  assert.equal(await historical.locator('.file-missing').count(), 0);
  await frame.locator('#history-close').click();
  await unlink(join(root, '建表.sql'));
  await missing.click();
  await frame.locator('#status.error').filter({ hasText: 'ENOENT' }).waitFor();
  await missing.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '移除记录', exact: true }).click();
  await missing.waitFor({ state: 'detached' });
  assert.equal(await live.count(), 1, 'missing entries remain removable without affecting other files');
});
