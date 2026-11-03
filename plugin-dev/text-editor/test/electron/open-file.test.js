import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('open a chosen file directly, preserve drafts and keep the document on cancel or failure', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, archive);
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const open = frame.getByRole('button', { name: '打开文件', exact: true });
  await open.waitFor();
  assert.equal(await open.count(), 1, 'a direct file entry must be available');
  await frame.locator('#new').click();
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#document-name').filter({ hasText: '未命名.md' }).waitFor();
  await frame.locator('#editor').fill('unsaved original');

  const directory = join(data, '.hidden', 'DKY-641');
  const file = join(directory, 'API.md');
  await mkdir(directory, { recursive: true });
  await writeFile(file, '# API\n\n可编辑的正文');
  await writeFile(join(directory, 'TASK.md'), '# Unselected sibling');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.openFileOptions = options;
      return { canceled: false, filePaths: [path] };
    };
  }, file);
  await open.click();
  await frame.locator('#document-name').filter({ hasText: 'API.md' }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.openFileOptions.properties), ['openFile', 'showHiddenFiles']);
  await page.evaluate(() => workDesk.host.chooseFile({ title: '旧文件选择', extensions: ['md'] }));
  assert.deepEqual(await app.evaluate(() => globalThis.openFileOptions.properties), ['openFile']);
  assert.equal(await frame.locator('#editor').inputValue(), '# API\n\n可编辑的正文');
  assert.equal(await frame.locator('#directory').count(), 0, 'opening one file must not expand its parent directory');
  assert.equal(await frame.locator('#entries button').count(), 0);
  assert.equal(await frame.locator('#group-files').getByRole('button', { name: 'API.md', exact: true }).count(), 1);
  assert.equal(await frame.locator('#group-files').getByRole('button', { name: 'TASK.md', exact: true }).count(), 0);
  const history = await page.evaluate(() => workDesk.plugins.invoke('text-editor', 'editor.history', []));
  assert.deepEqual(history.map(({ root, path }) => ({ root, path })), [{ root: await realpath(directory), path: 'API.md' }]);
  await frame.locator('#draft-list button[data-id]').filter({ hasText: '未命名' }).waitFor();
  const drafts = await page.evaluate(() => workDesk.plugins.invoke('text-editor', 'editor.drafts', []));
  assert.ok(drafts.some(draft => draft.text === 'unsaved original'));
  await frame.locator('#editor').fill('# Saved API');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(file, 'utf8'), '# Saved API');
  assert.equal(await frame.locator('#directory').count(), 0, 'saving a directly opened file must not expand its parent');
  assert.equal(await frame.locator('#entries button').count(), 0);
  assert.equal(await readFile(join(directory, 'TASK.md'), 'utf8'), '# Unselected sibling');

  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await frame.locator('#editor').press('Meta+o');
  assert.equal(await frame.locator('#editor').inputValue(), '# Saved API');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, join(directory, 'missing.md'));
  await frame.locator('#editor').press('Control+o');
  await frame.locator('#status.error').waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '# Saved API');
  await frame.locator('#editor').fill('# After failed open');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(file, 'utf8'), '# After failed open');

  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(value, 650), width);
      await open.focus();
      assert.equal(await open.evaluate(button => {
        const bounds = button.getBoundingClientRect();
        return button === document.activeElement && !button.disabled && bounds.x >= 0 && bounds.right <= innerWidth;
      }), true);
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/open-${theme}-${width}.png`) });
    }
  }
});
