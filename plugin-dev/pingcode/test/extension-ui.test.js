import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

test('extension UI opens pairing and disconnects without claiming account logout', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pingcode-extension-ui-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), env,
    args: [resolve('plugin-dev/pingcode/test/fixtures/ui.cjs'), `--test-data=${directory}`] });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await page.evaluate(() => {
    fixture.settings.authMode = 'web'; fixture.settings.webMode = 'extension'; fixture.settings.revision = 'extension';
    fixture.session = { state: 'closed', transport: 'extension', extensionConnected: false, epoch: 'extension', error: null };
  });
  await page.locator('iframe').evaluate(node => { node.src += '?extension'; });
  const frame = page.frameLocator('iframe');
  const disconnected = '浏览器扩展未连接，首次使用请先安装扩展并点击登录连接';
  await frame.getByText(disconnected, { exact: true }).waitFor();
  await frame.getByRole('button', { name: '浏览器扩展安装与连接说明' }).waitFor();
  await frame.getByRole('button', { name: '登录 PingCode', exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.externalCalls[0].startsWith('http://127.0.0.1:12345/pair#')), true);
  await page.evaluate(() => { fixture.session.extensionConnected = true; fixture.session.state = 'needs-login'; fixture.session.epoch = 'paired'; });
  await frame.getByRole('button', { name: '检查登录状态', exact: true }).click();
  await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
  await frame.getByRole('button', { name: '断开浏览器连接', exact: true }).click();
  assert.match(await frame.locator('dialog').innerText(), /浏览器、标签页和 PingCode 登录均保留/);
  await frame.getByRole('button', { name: '取消退出', exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.session.state), 'connected');
  await frame.getByRole('button', { name: '断开浏览器连接', exact: true }).click();
  await frame.getByRole('button', { name: '确认断开浏览器连接', exact: true }).click();
  await frame.getByText(disconnected, { exact: true }).waitFor();
  await page.locator('iframe').evaluate(node => { node.src = 'desk-plugin://pingcode/dist/renderer/settings.html'; });
  await frame.getByLabel('网页登录方式', { exact: true }).waitFor();
  assert.equal(await frame.getByLabel('网页登录方式', { exact: true }).inputValue(), 'extension');
  await mkdir('.test-results/pingcode', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await frame.locator('html').evaluate((node, theme) => { node.dataset.theme = theme; }, theme);
    for (const width of [1100, 560, 320]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width);
      assert.equal(await frame.locator('body').evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
      await frame.getByLabel('网页登录方式', { exact: true }).focus();
      assert.equal(await frame.getByLabel('网页登录方式', { exact: true }).evaluate(node => node === document.activeElement), true);
      await page.screenshot({ path: resolve(`.test-results/pingcode/extension-settings-${theme}-${width}.png`) });
    }
  }
  await frame.getByLabel('网页登录方式', { exact: true }).selectOption('window');
  await frame.getByRole('button', { name: '保存配置', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await page.evaluate(() => fixture.settings.webMode), 'window');
});
