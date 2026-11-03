import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

test('web login needs no client secret and logout has a cancellable anchored confirmation', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pingcode-web-ui-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), env,
    args: [resolve('plugin-dev/pingcode/test/fixtures/ui.cjs'), `--test-data=${directory}`] });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await page.evaluate(() => { fixture.settings.authMode = 'web'; fixture.settings.revision = 'web'; });
  await page.locator('iframe').evaluate(node => { node.src += '?mode=web'; });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: '登录 PingCode', exact: true }).click();
  await frame.getByRole('button', { name: '检查登录状态', exact: true }).click();
  await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
  await frame.getByLabel('人员名称', { exact: true }).fill('吴杰');
  await frame.getByRole('button', { name: '搜索人员', exact: true }).click();
  await frame.getByLabel('人员', { exact: true }).selectOption('two');
  await frame.locator('#total strong').waitFor();
  const current = await frame.getByLabel('月份', { exact: true }).inputValue();
  assert.equal(current, await page.evaluate(() => new Date().getFullYear()+'-'+String(new Date().getMonth()+1).padStart(2,'0')));
  assert.equal(await frame.getByLabel('时间口径', { exact: true }).inputValue(), 'completedAt');
  assert.equal(await frame.locator('#total strong').textContent(), '0.3');
  await frame.getByLabel('时间口径', { exact: true }).selectOption('createdAt');
  await frame.locator('#total strong').waitFor();
  assert.equal(await frame.locator('#total strong').textContent(), '5.2');
  const previous = await page.evaluate(() => {
    const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-1);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
  });
  await frame.getByLabel('月份', { exact: true }).fill(previous);
  await frame.locator('#total strong').waitFor();
  assert.equal(await frame.locator('#total strong').textContent(), '0.1');
  await frame.getByLabel('时间口径', { exact: true }).selectOption('completedAt');
  await frame.locator('#total strong').waitFor();
  assert.equal(await frame.locator('#total strong').textContent(), '0');
  await frame.getByLabel('月份', { exact: true }).fill(current);
  await frame.locator('#total strong').waitFor();
  await mkdir('.test-results/pingcode', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await frame.locator('html').evaluate((node, theme) => { node.dataset.theme = theme; }, theme);
    for (const width of [1100, 560, 320]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width);
      assert.equal(await frame.locator('body').evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(`.test-results/pingcode/web-${theme}-${width}.png`) });
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await frame.getByRole('button', { name: '退出 PingCode 登录', exact: true }).click();
  await frame.getByRole('button', { name: '取消退出', exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.session.state), 'connected');
  await frame.getByRole('button', { name: '退出 PingCode 登录', exact: true }).click();
  await frame.getByRole('button', { name: '确认退出并清除登录资料', exact: true }).click();
  await frame.getByText('未登录，请打开登录窗口', { exact: true }).waitFor();
  assert.equal(await frame.locator('#total strong').count(), 0);
  await page.locator('iframe').evaluate(node => { node.src = 'desk-plugin://pingcode/dist/renderer/settings.html'; });
  await frame.getByLabel('授权模式', { exact: true }).waitFor();
  assert.equal(await frame.getByLabel('授权模式', { exact: true }).inputValue(), 'web');
  assert.equal(await frame.getByLabel('Client Secret', { exact: true }).isVisible(), false);
  for (const theme of ['light', 'dark']) {
    await frame.locator('html').evaluate((node, theme) => { node.dataset.theme = theme; }, theme);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(320, 760));
    assert.equal(await frame.locator('body').evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
    await frame.getByRole('button', { name: '登录 PingCode', exact: true }).click();
    await frame.getByRole('button', { name: '检查登录状态', exact: true }).click();
    await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
    await frame.getByRole('button', { name: '退出 PingCode 登录', exact: true }).click();
    const bounds = await frame.locator('dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 321);
    await frame.locator('dialog').evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: resolve(`.test-results/pingcode/web-settings-${theme}-320.png`) });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => fixture.session.state), 'connected');
  }
});
