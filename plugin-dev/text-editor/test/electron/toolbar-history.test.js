import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('single-row tools, blank startup, resizable history and file context actions', { timeout: 120000 }, async t => {
  const { app, page, data } = await launch(t, {
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
  const assertCurrentFile = async name => {
    assert.deepEqual(await frame.locator('#group-files button[aria-current="page"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), name ? [name] : []);
  };
  await frame.locator('#editor-tools').waitFor();
  await assertCurrentFile(null);
  assert.equal(await frame.locator('#panes').isVisible(), false);
  assert.equal(await frame.locator('#document-name').textContent(), '');
  assert.equal(await frame.locator('#save').isDisabled(), true);
  assert.equal(await frame.locator('#present').isDisabled(), true);
  assert.equal(await frame.locator('#filename').isVisible(), false);
  assert.equal(await frame.locator('#type').isVisible(), false);
  assert.equal(await frame.getByText('离线 · 本地文件', { exact: true }).count(), 0);
  assert.equal(await frame.locator('#configure').count(), 0);
  const tools = await frame.locator('#editor-tools').boundingBox();
  const actions = await frame.locator('header .actions').boundingBox();
  assert.ok(Math.abs(tools.y + tools.height / 2 - (actions.y + actions.height / 2)) <= 1,
    'tools must remain visible in the same top row');
  await frame.locator('.body').hover();
  assert.equal(await frame.locator('#editor-tools').isVisible(), true);
  await frame.locator('#new').click();
  await frame.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await frame.locator('#panes').isVisible(), false, 'cancelling creation keeps the blank start');
  await frame.locator('#new').click();
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#editor').waitFor();
  await frame.locator('button[data-mode="edit"]').focus();
  await frame.locator('button[data-mode="edit"]').press('Tab');
  assert.equal(await frame.locator('button[data-mode="read"]').evaluate(element => element === document.activeElement), true);
  assert.equal(await frame.locator('#format').isDisabled(), true);
  await frame.locator('#font-size').fill('28');
  assert.equal(await frame.locator('html').evaluate(element => element.style.getPropertyValue('--editor-size')), '28px');
  await frame.locator('#font-size').press('Escape');
  assert.equal(await frame.locator('#editor-tools').isVisible(), true);

  await frame.locator('#editor').fill('keep on cancellation');
  await frame.locator('#new').click();
  await frame.locator('#filename').fill('discarded.md');
  await frame.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await frame.locator('#editor').inputValue(), 'keep on cancellation');
  await frame.locator('#new').click();
  await frame.locator('#filename').fill('created.md');
  await frame.locator('#type').selectOption('json');
  assert.equal(await frame.locator('#filename').inputValue(), 'created.json');
  await frame.locator('#filename').press('Enter');
  await frame.locator('#document-name').filter({ hasText: 'created.json' }).waitFor();
  await frame.locator('#editor').fill('{"created":true}');
  assert.equal(await frame.locator('#document-name').textContent(), 'created.json');
  assert.equal(await frame.locator('#type').isVisible(), false);

  const first = join(data, 'first');
  const second = join(data, 'second');
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, 'old.md'), '# historical file');
  await writeFile(join(second, 'other.txt'), 'another workspace');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, join(first, 'old.md'));
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(data, 'desktop-files', 'created.json'), 'utf8'), '{"created":true}');
  await assertCurrentFile('created.json');
  await frame.locator('#open').click();
  await frame.locator('#group-files').getByRole('button', { name: 'old.md', exact: true }).waitFor();
  await assertCurrentFile('old.md');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, join(second, 'other.txt'));
  await frame.locator('#open').click();
  await frame.locator('#group-files').getByRole('button', { name: 'other.txt', exact: true }).waitFor();
  await assertCurrentFile('other.txt');
  assert.equal(await frame.locator('#group-files button').count(), 3);
  assert.equal((await frame.locator('#files').textContent()).includes(data), false);
  await frame.locator('#group-files').getByRole('button', { name: 'old.md', exact: true }).click();
  await frame.locator('#document-name').filter({ hasText: 'old.md' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '# historical file');
  await assertCurrentFile('old.md');
  await frame.locator('#editor').fill('# saved from history');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(first, 'old.md'), 'utf8'), '# saved from history');
  await assertCurrentFile('old.md');
  assert.equal(await readFile(join(second, 'other.txt'), 'utf8'), 'another workspace');

  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await frame.locator('#group-files button').nth(2).waitFor();
  assert.equal(await frame.locator('#group-files button').count(), 3);
  assert.equal(await frame.locator('#directory').count(), 0);
  assert.equal(await frame.locator('#panes').isVisible(), false, 'history must not automatically reopen a document');
  assert.equal(await frame.locator('#document-name').textContent(), '');
  await assertCurrentFile(null);
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await frame.locator('body').screenshot({ path: resolve('.test-results/text-editor/blank-history.png') });
  await frame.locator('#group-files').getByRole('button', { name: 'created.json', exact: true }).click();
  await frame.locator('#document-name').filter({ hasText: 'created.json' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '{"created":true}');
  await assertCurrentFile('created.json');
  await page.emulateMedia({ colorScheme: null });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    const current = frame.locator('#group-files button[aria-current="page"]');
    const inactive = frame.locator('#group-files button[aria-current="false"]').first();
    assert.notEqual(await current.evaluate(element => getComputedStyle(element).backgroundColor),
      await inactive.evaluate(element => getComputedStyle(element).backgroundColor));
    assert.equal(await current.evaluate(element => getComputedStyle(element).fontWeight), '600');
    await current.focus();
    await frame.locator('#document-name').hover();
    await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/current-file-${theme}.png`) });
  }

  const edge = frame.locator('#toggle-files');
  const initialWidth = await frame.locator('#files').evaluate(element => element.offsetWidth);
  const edgeBounds = await edge.boundingBox();
  await page.mouse.move(edgeBounds.x + edgeBounds.width / 2, edgeBounds.y + edgeBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(edgeBounds.x + edgeBounds.width / 2 + 50, edgeBounds.y + edgeBounds.height / 2, { steps: 5 });
  await page.mouse.up();
  const resized = await frame.locator('#files').evaluate(element => element.offsetWidth);
  assert.ok(resized >= initialWidth + 45);
  assert.equal(await edge.getAttribute('aria-expanded'), 'true', 'drag must not collapse the sidebar');
  await edge.click();
  assert.equal(await frame.locator('#files').isVisible(), false);
  assert.equal(await frame.locator('#files').evaluate(element => element.inert), true);
  await edge.press('Enter');
  assert.equal(await frame.locator('#files').isVisible(), true);
  assert.equal(await frame.locator('#files').evaluate(element => element.offsetWidth), resized);
  await edge.press('ArrowRight');
  assert.equal(await frame.locator('#files').evaluate(element => element.offsetWidth), resized + 20);

  const other = frame.locator('#group-files').getByRole('button', { name: 'other.txt', exact: true });
  await other.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '移除记录', exact: true }).click();
  await frame.locator('#status').filter({ hasText: '已移除记录' }).waitFor();
  assert.equal(await other.count(), 0);
  assert.equal(await readFile(join(second, 'other.txt'), 'utf8'), 'another workspace');
  assert.equal(await frame.locator('#editor').inputValue(), '{"created":true}');
  await assertCurrentFile('created.json');

  const old = frame.locator('#group-files').getByRole('button', { name: 'old.md', exact: true });
  await old.click();
  await frame.locator('#document-name').filter({ hasText: 'old.md' }).waitFor();
  await frame.locator('#editor').fill('# unfinished rename');
  await old.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await frame.getByRole('textbox', { name: '新的文件名称', exact: true }).fill('renamed.md');
  await frame.locator('#file-action-dialog').getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#status').filter({ hasText: '已重命名' }).waitFor();
  assert.equal(await readFile(join(first, 'renamed.md'), 'utf8'), '# saved from history');
  await assert.rejects(readFile(join(first, 'old.md')), { code: 'ENOENT' });
  assert.equal(await frame.locator('#editor').inputValue(), '# unfinished rename');
  assert.equal(await frame.locator('#document-name').textContent(), 'renamed.md');
  await assertCurrentFile('renamed.md');
  const renamed = frame.locator('#group-files').getByRole('button', { name: 'renamed.md', exact: true });
  await renamed.focus();
  await renamed.press('Shift+F10');
  await frame.getByRole('menuitem', { name: '重命名', exact: true }).press('ArrowDown');
  await frame.getByRole('menuitem', { name: '移除记录', exact: true }).press('Enter');
  await frame.locator('#status').filter({ hasText: '已移除记录' }).waitFor();
  assert.equal(await renamed.count(), 0);
  assert.equal(await readFile(join(first, 'renamed.md'), 'utf8'), '# saved from history');
  assert.equal(await frame.locator('#panes').isVisible(), false);
  assert.equal(await frame.locator('#editor').inputValue(), '');
  assert.equal(await frame.locator('#document-name').textContent(), '');
  assert.equal(await frame.locator('#save').isDisabled(), true);
  await assertCurrentFile(null);
  await frame.locator('.draft button[data-id]').filter({ hasText: 'renamed' }).click();
  await frame.locator('#status').filter({ hasText: '已恢复草稿' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '# unfinished rename');
  assert.equal(await renamed.count(), 0, 'restoring a draft must not restore the removed history');

  const created = frame.locator('#group-files').getByRole('button', { name: 'created.json', exact: true });
  await created.click();
  await frame.locator('#document-name').filter({ hasText: 'created.json' }).waitFor();
  await frame.locator('#editor').fill('{"unfinished":true}');
  await created.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '删除文件', exact: true }).click();
  await frame.locator('#file-action-dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await readFile(join(data, 'desktop-files', 'created.json'), 'utf8'), '{"created":true}');
  await created.click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '删除文件', exact: true }).click();
  await frame.locator('#file-action-dialog').getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#status').filter({ hasText: '已删除文件' }).waitFor();
  await assert.rejects(readFile(join(data, 'desktop-files', 'created.json')), { code: 'ENOENT' });
  assert.equal(await created.count(), 0);
  assert.equal(await frame.locator('#editor').inputValue(), '{"unfinished":true}');
  await assertCurrentFile(null);
  await frame.locator('.draft button').filter({ hasText: 'created' }).waitFor();

  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      const font = frame.locator('#font-size');
      await font.fill('28');
      await font.scrollIntoViewIfNeeded();
      const bounds = await font.evaluate(element => element.getBoundingClientRect().toJSON());
      const viewport = await frame.locator('body').evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, JSON.stringify({ bounds, viewport }));
      const room = await font.evaluate(element => {
        const style = getComputedStyle(element);
        return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      assert.ok(room >= 40, 'two digits and native number controls must have sufficient room');
      await font.focus();
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/toolbar-${theme}-${width}.png`) });
      await font.press('Escape');
    }
  }
  assert.deepEqual(errors, []);
});
