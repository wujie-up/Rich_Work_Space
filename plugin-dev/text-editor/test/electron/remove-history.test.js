import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('mouse removal of a saved large document closes it and keeps the file', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  const root = join(data, 'documents');
  const text = '大文件内容\n'.repeat(40000);
  await mkdir(root);
  await writeFile(join(root, 'large.txt'), text);
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, join(root, 'large.txt'));
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'large.txt' }).waitFor();
  const history = frame.locator('#group-files button[data-path="large.txt"]');
  await history.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '移除记录', exact: true }).click();
  await frame.locator('#status').filter({ hasText: /已移除记录|请求参数无效或过大/ }).waitFor();
  assert.equal(await frame.locator('#status').textContent(), '已移除记录 · 文件仍保留');
  assert.equal(await history.count(), 0);
  assert.equal(await frame.locator('#panes').isVisible(), false);
  assert.equal(await frame.locator('#editor').inputValue(), '');
  assert.equal(await frame.locator('#document-name').textContent(), '');
  assert.equal(await frame.locator('#save').isDisabled(), true);
  assert.equal(await readFile(join(root, 'large.txt'), 'utf8'), text);
  assert.deepEqual(await page.evaluate(() => workDesk.plugins.invoke('text-editor', 'editor.history', [])), []);
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await frame.locator('#editor-tools').waitFor();
  assert.equal(await history.count(), 0, 'removal survives a restart of the view');

  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'large.txt' }).waitFor();
  await frame.locator('#editor').evaluate(editor => {
    editor.value += 'unfinished';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await history.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '移除记录', exact: true }).click();
  await frame.locator('#status').filter({ hasText: '已移除记录' }).waitFor();
  assert.equal(await history.count(), 0);
  assert.equal(await frame.locator('#panes').isVisible(), false);
  assert.equal(await readFile(join(root, 'large.txt'), 'utf8'), text);
  await frame.locator('.draft button[data-id]').filter({ hasText: 'large' }).click();
  await frame.locator('#status').filter({ hasText: '已恢复草稿' }).waitFor();
  assert.ok(await frame.locator('#editor').inputValue() === `${text}unfinished`, 'restored large draft retains unfinished text');
  assert.equal(await history.count(), 0, 'restoring a draft must not restore a removed history entry');
});
