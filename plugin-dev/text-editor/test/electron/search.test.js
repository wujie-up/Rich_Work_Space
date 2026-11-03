import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('document search locates literal text, wraps matches and searches rendered Markdown', { timeout: 90000 }, async t => {
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
  const searchButton = frame.getByRole('button', { name: '搜索', exact: true });
  await searchButton.waitFor({ timeout: 4000 });
  assert.equal(await searchButton.isDisabled(), true);
  await frame.locator('#new').click();
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  const editor = frame.locator('#editor');
  const source = `# 查找\n\n首个 **Needle** [a]\n\n${'正文\n\n'.repeat(80)}末尾 needle [a]\n`;
  await editor.fill(source);
  await editor.press('Meta+f');
  const query = frame.getByRole('searchbox', { name: '搜索当前文档' });
  await query.waitFor();
  assert.equal(await query.evaluate(element => element === document.activeElement), true);
  await query.fill('needle');
  const count = frame.locator('#search-count');
  await count.filter({ hasText: '1 / 2' }).waitFor();
  assert.equal(await editor.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), 'Needle');
  await query.press('Enter');
  await count.filter({ hasText: '2 / 2' }).waitFor();
  assert.ok(await editor.evaluate(element => element.scrollTop > 0));
  await query.press('Enter');
  await count.filter({ hasText: '1 / 2' }).waitFor();
  await query.press('Shift+Enter');
  await count.filter({ hasText: '2 / 2' }).waitFor();
  await query.fill('[a]');
  await count.filter({ hasText: '1 / 2' }).waitFor();
  await query.fill('不存在');
  await count.filter({ hasText: '无结果' }).waitFor();
  assert.equal(await frame.getByRole('button', { name: '下一个结果', exact: true }).isDisabled(), true);
  await query.fill('首个 Needle');
  await frame.getByRole('button', { name: '阅读', exact: true }).click();
  await count.filter({ hasText: '1 / 1' }).waitFor();
  assert.equal(await frame.locator('#preview').evaluate(() => [...CSS.highlights.get('document-search')][0].toString()), '首个 Needle');
  await query.fill('needle');
  await count.filter({ hasText: '1 / 2' }).waitFor();
  await frame.getByRole('button', { name: '下一个结果', exact: true }).click();
  await count.filter({ hasText: '2 / 2' }).waitFor();
  assert.ok(await frame.locator('#preview').evaluate(element => element.scrollTop > 0));
  assert.equal(await frame.locator('#preview').evaluate(element => {
    const match = [...CSS.highlights.get('document-search')][0].getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return match.top >= bounds.top && match.bottom <= bounds.bottom;
  }), true, 'the highlighted result must be inside the preview viewport');

  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(value, 650), width);
      assert.equal(await frame.locator('#search-bar').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.x >= 0 && bounds.right <= innerWidth;
      }), true);
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/search-${theme}-${width}.png`) });
    }
  }
  await query.press('Escape');
  await query.waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#preview').evaluate(() => CSS.highlights.has('document-search')), false);
  await searchButton.click();
  await query.waitFor();
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.fill('needle');
  await count.filter({ hasText: '1 / 1' }).waitFor();
  assert.equal(await editor.inputValue(), 'needle', 'search must not modify the document');
  await editor.press('End');
  await editor.press('x');
  await page.waitForTimeout(250);
  assert.equal(await editor.inputValue(), 'needlex');
  assert.equal(await editor.evaluate(element => element.selectionStart), 7, 'count refresh must preserve the typing caret');
  await editor.fill('**needlex**');
  await frame.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await query.waitFor({ state: 'hidden' });
  await editor.press('Control+f');
  await query.waitFor();
  await frame.getByRole('button', { name: '演示', exact: true }).click();
  await frame.locator('body[data-presenting]').waitFor();
  await query.fill('needlex');
  await frame.locator('#preview p').filter({ hasText: 'needlex' }).waitFor();
  await query.press('Enter');
  await count.filter({ hasText: '1 / 1' }).waitFor();
  assert.equal(await frame.locator('#preview').evaluate(() => [...CSS.highlights.get('document-search')][0].toString()), 'needlex');
  await query.press('Escape');
  await query.waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('body').getAttribute('data-presenting'), 'true', 'first Escape only closes search');
  await frame.getByRole('button', { name: '退出演示', exact: true }).press('Control+f');
  await query.fill('**');
  await count.filter({ hasText: '无结果' }).waitFor();
  await frame.getByRole('button', { name: '退出演示', exact: true }).click();
  await frame.locator('body:not([data-presenting])').waitFor();
  await count.filter({ hasText: '1 / 2' }).waitFor({ timeout: 3000 });
  await frame.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await frame.locator('#new').click();
  await frame.locator('#type').selectOption('txt');
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#document-name').filter({ hasText: '未命名.txt' }).waitFor();
  await editor.fill('plain needle needle');
  await searchButton.click();
  await query.fill('needle');
  await count.filter({ hasText: '1 / 2' }).waitFor();
  assert.equal(await editor.evaluate(element => element.selectionStart), 6);
  assert.deepEqual(errors, []);
});
