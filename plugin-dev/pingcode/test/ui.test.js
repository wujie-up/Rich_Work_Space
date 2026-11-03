import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

test('query, settings, themes and tiled/narrow layouts use isolated deterministic views', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pingcode-ui-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), env,
    args: [resolve('plugin-dev/pingcode/test/fixtures/ui.cjs'), `--test-data=${directory}`] });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => console.log('UI error:', error.message));
  page.on('console', entry => { if (entry.type() === 'error') { console.log('UI console:', entry.text()); } });
  const frame = page.frameLocator('iframe');
  await frame.getByLabel('月份', { exact: true }).fill('');
  await frame.getByLabel('人员名称', { exact: true }).fill('吴杰');
  assert.equal(await frame.getByRole('button', { name: '查询任务', exact: true }).isDisabled(), true);
  await frame.getByRole('button', { name: '搜索人员', exact: true }).click();
  await frame.locator('#member option[value="two"]').waitFor({ state: 'attached' }).catch(async error => {
    console.log(await frame.locator('body').innerText());
    console.log(await page.evaluate(() => fixture.calls));
    console.log(await frame.locator('#keywords').inputValue());
    console.log(await frame.locator('form').evaluate(node => ({ valid: node.checkValidity(), html: node.outerHTML })));
    throw error;
  });
  await frame.getByLabel('人员', { exact: true }).selectOption('two');
  await frame.locator('#total').getByText('5.3', { exact: true }).waitFor();
  assert.equal(await frame.locator('tbody tr').count(), 5);
  assert.equal(await frame.locator('tbody img').count(), 0, 'task content must be text');
  const query = await page.evaluate(() => fixture.calls.findLast(call => call.name === 'pingcode.start').args[0]);
  assert.equal(query.assigneeId, 'two');
  await page.evaluate(() => { fixture.delaySettings = 500; });
  await frame.getByRole('button', { name: '查询任务', exact: true }).click();
  assert.equal(await frame.getByLabel('项目', { exact: true }).isDisabled(), true, 'filters must lock before config RPC');
  await frame.getByRole('status').filter({ hasText: '查询完成' }).waitFor();
  await frame.getByRole('button', { name: '查询任务', exact: true }).waitFor();
  await page.evaluate(() => { fixture.delaySettings = 0; });
  await frame.getByLabel('状态', { exact: true }).selectOption('done');
  assert.equal(await frame.locator('#total strong').textContent(), '0.3');
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await frame.getByRole('button', { name: '统计口径说明', exact: true }).focus();
  await frame.getByRole('tooltip').waitFor({ state: 'visible' }).catch(async error => {
    console.log('Help focus:', await frame.locator('#help-slot .help').evaluate(node => ({
      active: document.activeElement.outerHTML, match: node.matches(':has(button:focus)'),
      display: getComputedStyle(node.querySelector('[role=tooltip]')).display, focused: document.hasFocus(),
      status: document.querySelector('#status').textContent
    })));
    throw error;
  });
  await page.keyboard.press('Escape');
  await frame.getByLabel('状态', { exact: true }).selectOption('');
  await page.evaluate(() => { fixture.projects = [{ id: 'other', name: '另一个项目' }]; });
  await frame.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await frame.locator('#project option[value="other"]').waitFor({ state: 'attached' });
  await frame.locator('#total strong').waitFor();
  assert.equal(await page.evaluate(() => fixture.calls.findLast(call => call.name === 'pingcode.start').args[0].projectId), '');
  await page.evaluate(() => { fixture.failTasks = true; });
  await frame.getByRole('button', { name: '查询任务', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: '第二页读取失败' }).waitFor();
  assert.equal(await frame.locator('#total strong').count(), 0, 'failed partial results must not retain a total');
  await page.evaluate(() => { fixture.failTasks = false; fixture.slow = true; });
  await frame.getByRole('button', { name: '查询任务', exact: true }).click();
  await frame.getByRole('button', { name: '取消查询', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: '已取消' }).waitFor();
  await frame.getByRole('button', { name: '查询任务', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: '正在读取' }).waitFor();
  await page.evaluate(() => { fixture.settings.revision = 'changed-during-query'; fixture.slow = false; });
  await frame.getByRole('status').filter({ hasText: '连接配置已更改' }).waitFor();
  assert.equal(await frame.locator('#total strong').count(), 0, 'an old config job cannot publish a current total');
  assert.equal(await frame.getByLabel('人员', { exact: true }).inputValue(), '');
  await frame.getByRole('button', { name: '搜索人员', exact: true }).click();
  await frame.getByLabel('人员', { exact: true }).selectOption('two');
  await page.evaluate(() => { fixture.slow = false; });
  await frame.locator('#total strong').waitFor();
  await mkdir('.test-results/pingcode', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await frame.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
    for (const width of [1100, 560, 320]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 700), width);
      assert.equal(await frame.locator('body').evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
      await frame.getByLabel('人员名称', { exact: true }).focus();
      assert.equal(await frame.getByLabel('人员名称', { exact: true }).evaluate(node => node === document.activeElement), true);
      await page.screenshot({ path: resolve(`.test-results/pingcode/main-${theme}-${width}.png`) });
    }
  }
  await page.locator('iframe').evaluate(node => { node.src = 'desk-plugin://pingcode/dist/renderer/settings.html'; });
  await frame.getByLabel('访问令牌', { exact: true }).waitFor();
  assert.equal(await frame.getByLabel('访问令牌', { exact: true }).inputValue(), '');
  await frame.getByLabel('授权模式', { exact: true }).selectOption('client');
  await frame.getByText('企业令牌具有管理员级权限', { exact: false }).waitFor();
  await frame.getByLabel('Client ID', { exact: true }).fill('example-id');
  await frame.getByLabel('Client Secret', { exact: true }).fill('fixture-only-secret');
  await frame.getByRole('button', { name: '保存配置', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await frame.getByLabel('Client Secret', { exact: true }).inputValue(), '');
  assert.match(await frame.getByLabel('Client Secret', { exact: true }).getAttribute('placeholder'), /已配置/);
  for (const theme of ['light', 'dark']) {
    await frame.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
    for (const width of [800, 320]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width);
      assert.equal(await frame.locator('body').evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(`.test-results/pingcode/settings-${theme}-${width}.png`) });
    }
  }
});
