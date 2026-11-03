import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('editing has distinct paper and logical line numbers aligned across wrapping, scrolling and font changes', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const path = join(data, 'lines.sql');
  const source = `SELECT 1;\n-- ${'宽度变化 long wrap '.repeat(10)}\nSELECT 3;\n\n${Array.from({ length: 400 }, (_, i) => `SELECT ${i + 5};`).join('\n')}\n`;
  await writeFile(path, source);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'lines.sql' }).waitFor();
  const gutter = frame.locator('#line-numbers');
  await gutter.waitFor({ timeout: 3000 });
  assert.equal(await gutter.getAttribute('aria-hidden'), 'true');
  await frame.locator('#source-highlight .hljs-keyword').first().waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  await page.emulateMedia({ colorScheme: null });
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    assert.notEqual(await frame.locator('#source-pane').evaluate(node => getComputedStyle(node).backgroundColor),
      await frame.locator('#preview').evaluate(node => getComputedStyle(node).backgroundColor), 'editing and reading surfaces differ');
    for (const width of [1200, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      await frame.locator('#font-size').fill(width === 580 ? '20' : '14');
      await frame.locator('#editor').evaluate(node => { node.scrollTop = 0; });
      await gutter.locator('[data-line="3"]').waitFor();
      await gutter.evaluate(node => new Promise((resolve, reject) => {
        const deadline = performance.now() + 2500;
        const check = () => {
          const number = node.querySelector('[data-line="3"]');
          const keyword = document.querySelectorAll('#source-highlight .hljs-keyword')[1];
          const range = document.createRange();
          if (number && keyword) {
            range.selectNodeContents(number);
            if (Math.abs(range.getBoundingClientRect().top - keyword.getBoundingClientRect().top) < 2) {
              resolve();
              return;
            }
          }
          if (performance.now() > deadline) {
            reject(Error('logical line 3 is not aligned with its wrapped source'));
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      }));
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/line-numbers-${theme}-${width}.png`) });
      await frame.locator('#editor').evaluate(node => { node.scrollTop = node.scrollHeight; });
      await gutter.locator('[data-line="405"]').waitFor();
      assert.ok(await gutter.locator('[data-line]').count() < 100, 'only viewport line numbers are rendered');
      assert.equal(await frame.locator('#editor').inputValue(), source, 'line numbers never enter document text');
    }
  }
  await frame.locator('#editor').fill('\n');
  await gutter.locator('[data-line="2"]').waitFor();
  assert.equal(await gutter.locator('[data-line]').count(), 2, 'an empty final line retains its number');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 650));
  const markdown = join(data, 'reading.md');
  await writeFile(markdown, '# 阅读模式\n\n正文');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, markdown);
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'reading.md' }).waitFor();
  await frame.locator('button[data-mode="read"]').click();
  assert.equal(await gutter.isVisible(), false);
  await frame.getByRole('heading', { name: '阅读模式', exact: true }).waitFor();
  await frame.locator('button[data-mode="split"]').click();
  await gutter.locator('[data-line="1"]').waitFor();
  assert.equal(await frame.locator('#editor').isVisible(), true);
  assert.equal(await frame.locator('#preview').isVisible(), true);
});
