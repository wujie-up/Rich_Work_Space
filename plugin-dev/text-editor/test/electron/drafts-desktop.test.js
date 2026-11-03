import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('menus dismiss and a fixed draft group follows creation, restore, desktop save and save-as', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const original = join(data, 'original.txt');
  await writeFile(original, 'original');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, original);
  await frame.locator('#open').click();
  const file = frame.locator('#group-files button[data-path="original.txt"]');
  await file.click({ button: 'right' });
  await frame.locator('#file-menu').waitFor();
  await frame.locator('#editor').click();
  assert.equal(await frame.locator('#file-menu').isVisible(), false, 'outside click must remove the menu visually');
  await file.click({ button: 'right' });
  await frame.locator('#file-menu button').first().press('Escape');
  await frame.locator('#file-menu').waitFor({ state: 'hidden' });
  await file.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await frame.locator('#file-action-dialog').waitFor();
  assert.equal(await frame.locator('#file-menu').isVisible(), false);
  await frame.locator('#file-action-dialog [data-cancel]').click();

  const drafts = frame.locator('#draft-group');
  assert.equal(await frame.locator('#folder').count(), 0);
  assert.equal(await frame.locator('#drafts').count(), 0);
  await drafts.waitFor();
  assert.ok((await drafts.boundingBox()).y < (await frame.locator('.file-group[data-group=ungrouped]').boundingBox()).y);
  await drafts.locator('summary').click({ button: 'right' });
  assert.equal(await frame.locator('#group-menu').isVisible(), false);
  assert.equal(await frame.locator('#group-settings').isDisabled(), true);
  await frame.locator('#new').click();
  await frame.locator('#filename').fill('draft.txt');
  await frame.locator('#confirm-document').click();
  await frame.locator('#document-name').filter({ hasText: 'draft.txt' }).waitFor();
  await frame.locator('#editor').fill('draft text');
  await drafts.locator('button[data-id]').waitFor();
  await frame.locator('#new').click();
  await frame.locator('#filename').fill('empty.md');
  await frame.locator('#confirm-document').click();
  await drafts.locator('button[data-id]').filter({ hasText: 'empty' }).waitFor();
  assert.equal(await drafts.locator('button[data-id]').count(), 2);
  await drafts.locator('button[data-id]').filter({ hasText: 'draft' }).click();
  await frame.locator('#status').filter({ hasText: '已恢复草稿' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), 'draft text');
  assert.equal(await drafts.locator('button[data-id]').count(), 2, 'restoring must replace the draft rather than duplicate it');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => { throw new Error('normal save must not open a directory picker'); };
  });
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(data, 'desktop-files/draft.txt'), 'utf8'), 'draft text');
  assert.equal(await drafts.locator('button[data-id]').count(), 1);
  assert.equal(await frame.locator('#group-files button[data-path="draft.txt"]').count(), 1);
  assert.equal(await readFile(original, 'utf8'), 'original');

  const destination = join(data, 'copies');
  await mkdir(destination);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.draftSaveAsOptions = options;
      return { canceled: false, filePaths: [path] };
    };
  }, destination);
  await frame.locator('#save-as').click();
  await frame.locator('#filename').fill('copy.txt');
  await frame.locator('#confirm-document').click();
  await frame.locator('#document-name').filter({ hasText: 'copy.txt' }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.draftSaveAsOptions.properties), ['openDirectory', 'showHiddenFiles']);
  assert.equal(await readFile(join(destination, 'copy.txt'), 'utf8'), 'draft text');
  await frame.locator('#editor').fill('updated copy');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(destination, 'copy.txt'), 'utf8'), 'updated copy');
  assert.equal(await readFile(join(data, 'desktop-files/draft.txt'), 'utf8'), 'draft text');
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await drafts.locator('button[data-id]').waitFor();
  assert.equal(await drafts.locator('button[data-id]').count(), 1, 'only the unsaved empty draft survives reload');
  await drafts.locator('summary').click();
  assert.equal(await drafts.locator('button[data-id]').isVisible(), false);
  await drafts.locator('summary').press('ArrowRight');
  await drafts.locator('button[data-id]').waitFor();

  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    assert.notEqual(await drafts.locator('summary').evaluate(node => getComputedStyle(node).color),
      await frame.locator('.file-group[data-group=ungrouped] summary').evaluate(node => getComputedStyle(node).color));
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/drafts-${theme}-${width}.png`) });
    }
  }
  await drafts.locator('button[data-remove]').click();
  await drafts.locator('button[data-id]').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});
