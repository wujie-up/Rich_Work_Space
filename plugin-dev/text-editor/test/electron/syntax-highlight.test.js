import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('syntax colors follow the file format without changing editing, wrapping or scroll position', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const editor = frame.locator('#editor');
  const source = "-- 登录限制\nCREATE TABLE `admin_login_limits` (\n  `subject` varchar(255) NOT NULL,\n  `attempts` int NOT NULL DEFAULT 0,\n  `time` timestamp DEFAULT CURRENT_TIMESTAMP\n);\n";
  const path = join(data, 'limits.sql');
  await writeFile(path, source);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'limits.sql' }).waitFor();
  const layer = frame.locator('#source-highlight');
  await layer.locator('.hljs-keyword').first().waitFor({ timeout: 3000 });
  assert.equal(await layer.textContent(), `${source}\n`);
  assert.equal(await editor.inputValue(), source);
  assert.equal(await layer.getAttribute('aria-hidden'), 'true');
  assert.notEqual(await layer.locator('.hljs-keyword').first().evaluate(node => getComputedStyle(node).color),
    await layer.locator('.hljs-number').first().evaluate(node => getComputedStyle(node).color));
  assert.equal(await layer.locator('.hljs-comment').evaluate(node => getComputedStyle(node).fontStyle), 'italic');

  await editor.press('Control+End');
  await editor.press('x');
  await layer.filter({ hasText: 'x' }).waitFor();
  await editor.press('Meta+z');
  assert.equal(await editor.inputValue(), source, 'syntax rendering must preserve native undo');

  await editor.fill(`${source}${"SELECT '中文测试 wrapping alignment 0123456789' AS label; ".repeat(8)}\n`.repeat(100));
  await layer.locator('.hljs-keyword').first().waitFor();
  await editor.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const width of [1200, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      await frame.locator('#source-pane').evaluate(node => new Promise((resolve, reject) => {
        const deadline = performance.now() + 2000;
        const check = () => {
          const editor = node.querySelector('textarea');
          const layer = node.querySelector('pre');
          if (Math.abs(editor.scrollHeight - layer.scrollHeight) < 2 && Math.abs(editor.scrollTop - layer.scrollTop) < 2) {
            resolve();
          } else if (performance.now() > deadline) {
            reject(Error(`source/highlight geometry differs: ${editor.scrollHeight}/${layer.scrollHeight}, ${editor.scrollTop}/${layer.scrollTop}`));
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      }));
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/syntax-${theme}-${width}.png`) });
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 650));
  for (const [name, text, token] of [
    ['sample.json', '{"enabled":true,"count":42}', '.hljs-attr'],
    ['sample.jsonc', '// 注释\n{"enabled": true,}', '.hljs-comment'],
    ['sample.md', '# 标题\n\n**加粗** *强调*', '.hljs-strong'],
    ['sample.yaml', 'enabled: true\ncount: 42', '.hljs-attr'],
    ['sample.xml', '<item count="42">文本</item>', '.hljs-tag'],
    ['sample.html', '<script>window.injected = true</script>', '.hljs-tag'],
    ['sample.js', 'const count = 42;', '.hljs-keyword'],
    ['sample.ts', 'const count: number = 42;', '.hljs-keyword'],
    ['sample.css', '.item { color: red; }', '.hljs-attribute'],
    ['sample.py', 'def example():\n  return 42', '.hljs-keyword'],
    ['sample.java', 'public class Example { int count = 42; }', '.hljs-keyword'],
    ['sample.sh', 'if true; then echo "hello"; fi', '.hljs-keyword']
  ]) {
    const path = join(data, name);
    await writeFile(path, text);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await frame.locator('#open').click();
    await frame.locator('#document-name').filter({ hasText: name }).waitFor();
    await layer.locator(token).first().waitFor();
    assert.equal(await layer.textContent(), `${text}\n`, `${name} retains every source character`);
    assert.equal(await editor.inputValue(), text);
  }
  assert.equal(await layer.evaluate(() => window.injected), undefined, 'source markup must never execute');
  // A plain-text switch must discard any delayed result from the previous language.
  const plain = join(data, 'plain.txt');
  await writeFile(plain, '<script>window.injected = true</script> SELECT 42;');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, plain);
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'plain.txt' }).waitFor();
  assert.equal(await layer.isVisible(), false);
  assert.notEqual(await editor.evaluate(node => getComputedStyle(node).color), 'rgba(0, 0, 0, 0)');
  assert.equal(await editor.inputValue(), '<script>window.injected = true</script> SELECT 42;');
});
