import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('Markdown outline fades, reappears on hover and navigates document sections', { timeout: 90000 }, async t => {
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
  const source = `# **总览** ![状态](state.svg)\n\n\`\`\`md\n# 不是标题\n\`\`\`\n\n> # 引用\n\n${'正文\n\n'.repeat(60)}## 重复标题\n\n内容\n\n### 重复标题\n\n末节\n====\n`;
  await frame.locator('#editor').fill(source);
  const zone = frame.locator('#outline-zone');
  const outline = frame.getByRole('navigation', { name: '文档大纲', exact: true, includeHidden: true });
  await outline.waitFor({ timeout: 4000 });
  assert.deepEqual(await outline.locator('button').allTextContents(), ['总览 状态', '重复标题', '重复标题', '末节']);
  assert.equal(await outline.locator('button').nth(2).getAttribute('data-depth'), '3');
  await frame.locator('#editor').hover();
  await page.waitForTimeout(3400);
  assert.equal(await outline.evaluate(element => getComputedStyle(element).visibility), 'visible', 'outline must fade gradually');
  assert.ok(await outline.evaluate(element => Number(getComputedStyle(element).opacity) < 1));
  await page.waitForTimeout(1300);
  assert.equal(await outline.evaluate(element => getComputedStyle(element).visibility), 'hidden');
  await zone.hover();
  await page.waitForTimeout(180);
  assert.equal(await outline.evaluate(element => getComputedStyle(element).opacity), '1');
  await page.waitForTimeout(3200);
  assert.equal(await outline.evaluate(element => getComputedStyle(element).opacity), '1', 'hover must keep outline visible');
  await frame.locator('#preview').hover({ position: { x: 15, y: 150 } });
  await page.waitForTimeout(1400);
  assert.equal(await outline.evaluate(element => getComputedStyle(element).visibility), 'hidden', 'leaving must fade without another idle delay');
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await zone.hover();
  await outline.locator('button').nth(2).click();
  assert.equal(await frame.locator('#editor').evaluate(element => element.selectionStart), source.indexOf('### 重复标题'));
  assert.ok(await frame.locator('#editor').evaluate(element => element.scrollTop > 0));
  await frame.getByRole('button', { name: '阅读', exact: true }).click();
  await frame.locator('#preview h3').waitFor();
  await zone.hover();
  await outline.locator('button').nth(2).click();
  assert.ok(await frame.locator('#preview').evaluate(element => element.scrollTop > 0));
  await zone.focus();
  await zone.press('Tab');
  assert.equal(await outline.locator('button').first().evaluate(element => element === document.activeElement), true);
  await frame.locator('#preview').hover();
  await page.waitForTimeout(4700);
  assert.equal(await outline.evaluate(element => getComputedStyle(element).opacity), '1', 'keyboard focus must prevent fading');

  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      await zone.hover();
      assert.equal(await outline.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
      }), true);
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/outline-${theme}-${width}.png`) });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await outline.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await frame.getByRole('button', { name: '分栏', exact: true }).click();
  await frame.locator('#editor').fill('没有章节标题');
  await zone.waitFor({ state: 'hidden' });
  await frame.locator('#editor').fill('# 更新标题');
  await outline.getByRole('button', { name: '更新标题', exact: true }).waitFor();
  await frame.locator('#new').click();
  await frame.locator('#type').selectOption('txt');
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#editor').fill('# 纯文本标题');
  await zone.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});
