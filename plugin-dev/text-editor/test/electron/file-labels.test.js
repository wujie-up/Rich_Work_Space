import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('file lists hide extensions with type icons while file actions retain the original name', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const root = join(await realpath(data), 'documents');
  await mkdir(join(root, '.config'), { recursive: true });
  const names = ['report.md', 'report.json', 'notes.TXT', 'layout.xml', 'settings.yml', 'diagram.puml', 'archive.log', '.env',
    'README', 'release.v2.md', 'a&b.md', 'settings.jsonc', 'unknown.xyz', 'unknown.unrecognized', 'readme.markdown', 'query.SQL'];
  const labels = ['report', 'report', 'notes', 'layout', 'settings', 'diagram', 'archive', '.env', 'README', 'release.v2',
    'a&b', 'settings', 'unknown', 'unknown', 'readme', 'query'];
  for (const name of names) {
    await writeFile(join(root, name), 'original');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, join(root, name));
    await frame.locator('#open').click();
    await frame.locator('#document-name').filter({ hasText: name }).waitFor();
  }
  assert.deepEqual(await frame.locator('#group-files button .file-label').allTextContents(), labels);
  const markdown = frame.locator('#group-files').getByRole('button', { name: 'report.md', exact: true });
  const json = frame.locator('#group-files').getByRole('button', { name: 'report.json', exact: true });
  assert.equal(await markdown.getAttribute('title'), join(root, 'report.md'));
  assert.equal(await markdown.locator('svg[aria-hidden=true]').count(), 1);
  assert.deepEqual(await frame.locator('#group-files button svg text').allTextContents(),
    ['MD', 'JSON', 'TXT', 'XML', 'YML', 'PUML', 'LOG', 'FILE', 'FILE', 'MD', 'MD', 'JSON', 'FILE', 'FILE', 'MD', 'SQL']);
  for (const name of ['report.json', 'settings.jsonc']) {
    await frame.locator('#group-files').getByRole('button', { name, exact: true }).click();
    await frame.locator('#document-name').filter({ hasText: name }).waitFor();
    await frame.locator('#editor').fill('{// note\n"n":9007199254740993123,}');
    await frame.locator('#format').click();
    await frame.locator('#status').filter({ hasText: '已格式化' }).waitFor();
    assert.match(await frame.locator('#editor').inputValue(), /\/\/ note/);
    await frame.locator('#save').click();
    await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
    assert.match(await readFile(join(root, name), 'utf8'), /9007199254740993123/);
  }
  await frame.locator('#new').click();
  await frame.locator('#document-dialog').waitFor();
  assert.equal(await frame.locator('#type option[value=jsonc]').count(), 0);
  assert.equal(await frame.locator('#type option[value=puml]').count(), 0);
  assert.equal(await frame.locator('#type option[value=sql]').textContent(), 'SQL');
  await frame.locator('#filename').fill('existing.jsonc');
  assert.equal(await frame.locator('#type').inputValue(), 'json');
  await frame.locator('#cancel-document').click();
  await frame.locator('#new').click();
  await frame.locator('#filename').fill('created.md');
  await frame.locator('#type').selectOption('sql');
  assert.equal(await frame.locator('#filename').inputValue(), 'created.sql');
  await frame.locator('#confirm-document').click();
  await frame.locator('#document-name').filter({ hasText: 'created.sql' }).waitFor();
  await frame.locator('#editor').fill('SELECT 1;');
  assert.equal(await frame.locator('#format').isDisabled(), true);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(data, 'desktop-files', 'created.sql'), 'utf8'), 'SELECT 1;');
  await frame.locator('#group-files').getByRole('button', { name: 'query.SQL', exact: true }).click();
  await frame.locator('#save-as').click();
  assert.equal(await frame.locator('#type').inputValue(), 'sql');
  await frame.locator('#filename').fill('copy.sql');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, root);
  await frame.locator('#confirm-document').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(root, 'copy.sql'), 'utf8'), 'original');
  await frame.locator('#group-files').getByRole('button', { name: 'diagram.puml', exact: true }).click();
  await frame.locator('#save-as').click();
  assert.equal(await frame.locator('#type').inputValue(), 'txt');
  assert.equal(await frame.locator('#filename').inputValue(), 'diagram.puml');
  await frame.locator('#filename').fill('legacy.puml');
  assert.equal(await frame.locator('#type').inputValue(), 'txt');
  await frame.locator('#cancel-document').click();
  await markdown.locator('svg').click();
  await frame.locator('#document-name').filter({ hasText: 'report.md' }).waitFor();
  await frame.locator('#editor').fill('saved through original path');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(root, 'report.md'), 'utf8'), 'saved through original path');
  await json.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await frame.locator('#file-action-dialog').waitFor();
  assert.equal(await frame.locator('#file-action-dialog input').inputValue(), 'report.json');
  await frame.locator('#file-action-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await frame.locator('#history-toggle').click();
  const history = frame.locator('#history').getByRole('button', { name: 'report.md', exact: true });
  await history.waitFor();
  assert.equal(await history.locator('.file-label').textContent(), 'report');
  assert.equal(await history.locator('svg text').textContent(), 'MD');
  assert.equal(await history.getAttribute('title'), join(root, 'report.md'));
  await frame.locator('#history-close').click();
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await markdown.waitFor();
  assert.equal(await markdown.locator('.file-label').textContent(), 'report');
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    const colors = await frame.locator('#group-files button svg').evaluateAll(nodes =>
      nodes.slice(0, 6).map(node => getComputedStyle(node).color));
    assert.equal(new Set(colors).size, 5, 'type colors remain distinct in both themes');
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width);
      await markdown.focus();
      assert.equal(await markdown.locator('svg').evaluate(node => getComputedStyle(node).width), '40px');
      assert.equal(await markdown.locator('svg text').evaluate(node => getComputedStyle(node).fontSize), '12px');
      assert.equal(await markdown.evaluate(node => node === document.activeElement), true);
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/file-labels-${theme}-${width}.png`) });
    }
  }
});
