import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './helpers.js';

test('app menu: configuration opens from native menu, restores hidden window and retains workspace', { timeout: 30000 }, async (t) => {
  const { app, page } = await launch(t, { openPlugin: false, ...(process.env.DESK_EXECUTABLE ? { executablePath: process.env.DESK_EXECUTABLE } : {}) });
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'DeckPg');
  assert.equal(await page.title(), 'DeckPg');
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].label), 'DeckPg');
  assert.equal(await page.locator('#configuration, #active-app').count(), 0);
  const nativeOpen = async () => app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('configuration');
    item.click();
    return { label: item.label, accelerator: item.accelerator };
  });
  assert.deepEqual(await nativeOpen(), { label: '配置…', accelerator: 'CmdOrCtrl+,' });
  await page.locator('#settings-panel .plugin-toolbar').waitFor();
  await page.locator('#desktop-settings').click();
  await nativeOpen();
  await page.locator('#settings-panel .plugin-toolbar').waitFor();
  assert.equal(await page.locator('#settings-panel').count(), 1);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await page.locator('#settings-panel').count(), 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await nativeOpen();
  await page.locator('#settings-panel .plugin-toolbar').waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings-panel').count(), 0);
  assert.equal(await page.locator('iframe').count(), 0);
  await page.locator('.workspace-label').waitFor();
  await page.screenshot({ path: '.test-results/app-menu-workspace.png' });
});

test('app menu: language selection updates native menus and survives a renderer reload', { timeout: 30000 }, async (t) => {
  const { app, page, data } = await launch(t, { openPlugin: false, ...(process.env.DESK_EXECUTABLE ? { executablePath: process.env.DESK_EXECUTABLE } : {}) });
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '语言', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(JSON.parse(await readFile(join(data, 'preferences.json'), 'utf8')).language, 'en');
  assert.deepEqual(await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return [menu.getMenuItemById('configuration').label, ...menu.items.slice(1).map(item => item.label)];
  }), ['Settings…', 'Edit', 'View', 'Window']);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('configuration').click());
  await page.locator('#settings-panel .plugin-toolbar').waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'User menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('configuration').label), '配置…');
});
