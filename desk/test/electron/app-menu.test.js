import test from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './helpers.js';

test('app menu: configuration opens from native menu, restores hidden window and retains workspace', { timeout: 30000 }, async (t) => {
  const { app, page } = await launch(t, { openPlugin: false, ...(process.env.DESK_EXECUTABLE ? { executablePath: process.env.DESK_EXECUTABLE } : {}) });
  assert.equal(await page.locator('#configuration, #active-app').count(), 0);
  const nativeOpen = async () => app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('configuration');
    item.click();
    return { label: item.label, accelerator: item.accelerator };
  });
  assert.deepEqual(await nativeOpen(), { label: '配置…', accelerator: 'CmdOrCtrl+,' });
  await page.getByRole('heading', { name: '插件中心', exact: true }).waitFor();
  await page.locator('#desktop-settings').click();
  await nativeOpen();
  await page.getByRole('heading', { name: '插件中心', exact: true }).waitFor();
  assert.equal(await page.locator('#settings-panel').count(), 1);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await page.locator('#settings-panel').count(), 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await nativeOpen();
  await page.getByRole('heading', { name: '插件中心', exact: true }).waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings-panel').count(), 0);
  assert.equal(await page.locator('iframe').count(), 0);
  await page.locator('.workspace-label').waitFor();
  await page.screenshot({ path: '.test-results/app-menu-workspace.png' });
});
