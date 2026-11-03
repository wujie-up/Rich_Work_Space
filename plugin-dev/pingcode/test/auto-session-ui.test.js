import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

async function fixture(t, connected) {
  const directory = await mkdtemp(join(tmpdir(), 'pingcode-auto-session-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), env,
    args: [resolve('plugin-dev/pingcode/test/fixtures/ui.cjs'), `--test-data=${directory}`] });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await page.evaluate(connected => {
    fixture.calls = []; fixture.settings.authMode = 'web'; fixture.settings.webMode = 'extension'; fixture.settings.revision = 'auto';
    fixture.session = { transport: 'extension', state: connected ? 'needs-login' : 'closed',
      extensionConnected: connected, epoch: 'auto', error: null };
  }, connected);
  await page.locator('iframe').evaluate(node => { node.src += '?auto'; });
  return { page, frame: page.frameLocator('iframe') };
}
const checkCount = page => page.evaluate(() => fixture.calls.filter(call => call.name === 'pingcode.checkLogin').length);
const show = (page, visible) => page.evaluate(visible => document.querySelector('iframe').contentWindow.postMessage(
  { type: 'desk:visibility', visible }, 'desk-plugin://pingcode'), visible);

test('opening and restoring the page check an existing connection automatically without clearing same-account results',
  { timeout: 45000 }, async t => {
    const { page, frame } = await fixture(t, true);
    await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
    assert.equal(await checkCount(page), 1);
    await frame.locator('body').evaluate(() => {
      for (let index = 0; index < 5; index++) { window.dispatchEvent(new Event('focus')); }
    });
    await page.waitForTimeout(100);
    assert.equal(await checkCount(page), 1, 'the focus echo of opening a page must not duplicate the initial check');
    await frame.getByLabel('人员名称', { exact: true }).fill('吴杰');
    await frame.getByRole('button', { name: '搜索人员', exact: true }).click();
    await frame.getByLabel('人员', { exact: true }).selectOption('two');
    await frame.locator('#total strong').waitFor();
    await frame.getByRole('status').filter({ hasText: '任务查询完成' }).waitFor();
    const total = await frame.locator('#total strong').textContent();
    const beforeResume = await checkCount(page);
    await show(page, false);
    await show(page, true);
    await page.waitForFunction(count => fixture.calls.filter(call => call.name === 'pingcode.checkLogin').length > count, beforeResume)
      .catch(async error => {
        console.log('Auto-check resume:', await page.evaluate(() => ({ session: fixture.session,
          calls: fixture.calls.map(call => call.name) })));
        throw error;
      });
    await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
    assert.equal(await frame.locator('#total strong').textContent(), total);
    await page.evaluate(() => { fixture.slow = true; });
    await frame.getByRole('button', { name: '查询任务', exact: true }).click();
    await frame.getByRole('status').filter({ hasText: '正在读取' }).waitFor();
    const duringQuery = await checkCount(page);
    await show(page, false); await show(page, true);
    await page.waitForTimeout(250);
    assert.equal(await checkCount(page), duringQuery, 'resume must not run an auth check during a task query');
    await frame.getByRole('button', { name: '取消查询', exact: true }).click();
  });

test('a late extension connection is checked automatically and failed checks do not loop', { timeout: 45000 }, async t => {
  const { page, frame } = await fixture(t, false);
  await frame.getByText('浏览器扩展未连接，首次使用请先安装扩展并点击登录连接', { exact: true }).waitFor();
  assert.equal(await checkCount(page), 0);
  await page.evaluate(() => { fixture.session.extensionConnected = true; fixture.session.state = 'needs-login'; fixture.session.epoch = 'late'; });
  await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
  assert.equal(await checkCount(page), 1);
  await page.evaluate(() => { fixture.checkError = true; });
  await show(page, false); await show(page, true);
  await frame.getByText('浏览器连接检查失败', { exact: true }).waitFor();
  const failedCount = await checkCount(page);
  await page.waitForTimeout(1800);
  assert.equal(await checkCount(page), failedCount, 'a failed check needs a new resume or explicit retry');
  await page.evaluate(() => { fixture.checkError = false; });
  await show(page, false); await show(page, true);
  await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
});

test('OpenAPI views skip automatic browser checks while opening web settings checks the existing session', { timeout: 45000 }, async t => {
  const { page, frame } = await fixture(t, true);
  await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
  await page.evaluate(() => { fixture.calls = []; fixture.settings.authMode = 'token'; fixture.settings.revision = 'token'; });
  await page.locator('iframe').evaluate(node => { node.src = 'desk-plugin://pingcode/dist/renderer/index.html?token'; });
  await frame.locator('#login-controls').waitFor({ state: 'hidden' });
  await show(page, false); await show(page, true);
  await page.waitForTimeout(250);
  assert.equal(await checkCount(page), 0);
  await page.evaluate(() => {
    fixture.calls = []; fixture.settings.authMode = 'web'; fixture.settings.revision = 'settings';
    fixture.session.state = 'needs-login'; fixture.session.epoch = 'settings';
  });
  await page.locator('iframe').evaluate(node => { node.src = 'desk-plugin://pingcode/dist/renderer/settings.html'; });
  await frame.getByText('已登录，可以查询任务', { exact: true }).waitFor();
  assert.equal(await checkCount(page), 1);
});
