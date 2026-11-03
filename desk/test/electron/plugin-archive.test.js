import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { launch, openConfiguration } from './helpers.js';
import { temporaryStore, fixture } from '../helpers.js';
import { packPackage } from '../../src/main/common/plugin-package.js';

test('native .plg import and scanned one-click upgrades preserve data and enabled state', { timeout: 120000 }, async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  const archive = join(storage.root, 'test-agent.plg');
  await packPackage(source, archive);
  const second = join(storage.root, 'second-agent.plg');
  await packPackage(await fixture(storage, 'second-agent'), second);
  const { app, page } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]'),
    ...(process.env.DESK_EXECUTABLE ? { executablePath: process.env.DESK_EXECUTABLE } : {}) });
  await app.evaluate(({ dialog }, archives) => {
    dialog.showOpenDialog = async (...args) => {
      globalThis.packageDialogOptions = args.at(-1);
      return { canceled: false, filePaths: archives };
    };
  }, [archive, second]);
  await openConfiguration(page);
  await page.getByRole('button', { name: '导入本地插件', exact: true }).click();
  await page.locator('.plugin-card[data-plugin="test-agent"]').waitFor();
  await page.locator('.plugin-card[data-plugin="second-agent"]').waitFor();
  const installed = await page.evaluate(() => workDesk.plugins.list());
  assert.ok(installed.filter(plugin => ['test-agent', 'second-agent'].includes(plugin.id)).every(plugin => plugin.state === 'disabled'));
  const options = await app.evaluate(() => globalThis.packageDialogOptions);
  assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
  assert.deepEqual(options.filters[0].extensions, ['plg']);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.shelf-app[data-plugin="test-agent"]').count(), 0);
  await page.evaluate(() => workDesk.plugins.enable('test-agent'));
  const data = await app.evaluate(({ app }) => app.getPath('userData'));
  const { mkdir, readFile } = await import('node:fs/promises');
  await mkdir(join(data, 'plugin-data/test-agent'), { recursive: true });
  await writeFile(join(data, 'plugin-data/test-agent/history.json'), '{"saved":true}');
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json')));
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, version: '2.0.0' }));
  await packPackage(source, archive);
  assert.equal(await page.getByRole('button', { name: '升级到 v2.0.0', exact: true }).count(), 0);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, storage.root);
  assert.equal(await page.getByRole('textbox', { name: '插件包扫描目录', exact: true }).count(), 0);
  await page.getByRole('button', { name: '插件更新设置', exact: true }).click();
  assert.equal(await page.locator('.plugin-update-directory').getByRole('button', { name: '检查插件更新', exact: true }).count(), 0);
  await page.getByRole('button', { name: '选择插件包扫描目录', exact: true }).click();
  await page.waitForFunction(directory => document.querySelector('input[aria-label="插件包扫描目录"]').value === directory, storage.root);
  assert.deepEqual((await page.evaluate(() => workDesk.plugins.checkUpdates())).updates, []);
  await page.getByRole('textbox', { name: '插件包扫描目录', exact: true }).press('Escape');
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await openConfiguration(page);
  assert.deepEqual((await page.evaluate(() => workDesk.plugins.checkUpdates())).updates, []);
  const check = page.locator('.plugin-toolbar').getByRole('button', { name: '检查插件更新', exact: true });
  assert.equal(await check.isVisible(), true);
  await check.click();
  await page.waitForFunction(async () => (await workDesk.plugins.checkUpdates()).updates[0]?.version === '2.0.0');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => { throw Error('One-click upgrade must not open a file picker'); };
  });
  const upgrade = page.locator('.plugin-card[data-plugin="test-agent"]').getByRole('button', { name: '升级到 v2.0.0', exact: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await upgrade.waitFor();
    const color = await upgrade.evaluate(node => getComputedStyle(node).color);
    const [red, green, blue] = color.match(/\d+/g).map(Number);
    assert.ok(red > green && red > blue, `Upgrade icon must be red in ${theme}: ${color}`);
  }
  await upgrade.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await workDesk.plugins.list()).find(p => p.id === 'test-agent').version), '1.0.0');
  await upgrade.click();
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await page.locator('.plugin-card[data-plugin="test-agent"]').getByText('test-agent · v2.0.0', { exact: true }).waitFor();
  const upgraded = await page.evaluate(async () => (await workDesk.plugins.list()).find(p => p.id === 'test-agent'));
  assert.equal(upgraded.version, '2.0.0');
  assert.equal(upgraded.state, 'enabled');
  assert.equal(await readFile(join(data, 'plugin-data/test-agent/history.json'), 'utf8'), '{"saved":true}');
  assert.equal((await page.evaluate(() => workDesk.storage.getPreferences())).pluginPackageDirectory, storage.root);
  await page.waitForFunction(() => !document.querySelector('[title="升级到 v2.0.0"]'));
  await page.getByRole('button', { name: '插件更新设置', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const input = page.getByRole('textbox', { name: '插件包扫描目录', exact: true });
    assert.equal(await input.isVisible(), true);
    const colors = await input.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    assert.notEqual(colors.color, colors.background);
  }
  await page.getByRole('button', { name: '清空扫描目录', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="插件包扫描目录"]').value === '');
  assert.equal((await page.evaluate(() => workDesk.storage.getPreferences())).pluginPackageDirectory, '');
});
