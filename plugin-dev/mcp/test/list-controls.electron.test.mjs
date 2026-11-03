import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, toggleTheme } from '../../../desk/test/electron/helpers.js';

const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
const archive = resolve(`plugin-dev/dist/mcp-services-${manifest.version}.plg`);
const invoke = (page, method, ...args) => page.evaluate(({ method, args }) =>
  workDesk.plugins.invoke('mcp-services', method, args), { method, args });

test('list controls start and stop only their service and recover after a failed start', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('mcp-services', 'remove');
    await workDesk.plugins.remove('mcp-services', 'keep', preview.confirmationToken);
  });
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  }, resolve('plugin-dev/dist/mcp-services-0.4.21.plg'));
  await page.evaluate(async () => {
    await workDesk.plugins.install();
    await workDesk.plugins.enable('mcp-services');
  });
  for (const [id, name] of [['selected', '当前服务'], ['other', '其他服务']]) {
    await invoke(page, 'mcp.save', { id, name, transport: 'stdio', command: process.execPath,
      args: [resolve('plugin-dev/mcp/test/fixture.mjs')], env: {} });
  }
  await invoke(page, 'mcp.save', { id: 'offline', name: '启动失败服务', transport: 'stdio', command: '/missing/mcp-server', args: [] });
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  const frame = page.frameLocator('iframe[title="MCP 服务"]:visible');
  await frame.getByRole('button', { name: '配置 当前服务', exact: true }).waitFor();
  assert.equal(await frame.getByRole('button', { name: '开启 当前服务', exact: true }).count(), 0);
  await page.evaluate(async source => {
    const preview = await workDesk.plugins.preview('mcp-services', 'upgrade');
    await workDesk.plugins.upgrade('mcp-services', source, preview.confirmationToken);
  }, archive);
  await invoke(page, 'mcp.start', 'other');
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  await frame.getByRole('button', { name: '配置 当前服务', exact: true }).waitFor();
  const start = frame.getByRole('button', { name: '开启 当前服务', exact: true });
  const stop = frame.getByRole('button', { name: '关闭 当前服务', exact: true });
  assert.equal(await start.count(), 1);
  assert.equal(await stop.count(), 1);
  assert.equal(await start.isEnabled(), true);
  assert.equal(await stop.isDisabled(), true);
  await start.focus();
  await page.keyboard.press('Enter');
  await frame.locator('.service-row').filter({ has: start }).getByText(/running/).waitFor();
  assert.equal(await start.isDisabled(), true);
  assert.equal(await stop.isEnabled(), true);
  assert.match((await invoke(page, 'mcp.call', 'selected', 'echo', { text: 'LIST_STARTED' })).content[0].text, /LIST_STARTED/);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-data/mcp-services/desired-services.json'), 'utf8')).sort(),
    ['other', 'selected']);
  await stop.click();
  await frame.locator('.service-row').filter({ has: start }).getByText(/stopped/).waitFor();
  assert.equal(await start.isEnabled(), true);
  assert.equal(await stop.isDisabled(), true);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-data/mcp-services/desired-services.json'), 'utf8')), ['other']);
  assert.equal((await invoke(page, 'mcp.list')).find(service => service.id === 'other').state, 'running');
  await frame.getByRole('button', { name: '开启 启动失败服务', exact: true }).click();
  await frame.locator('#status').getByText(/启动失败/).waitFor();
  assert.equal(await frame.getByRole('button', { name: '开启 启动失败服务', exact: true }).isEnabled(), true);
  await frame.locator('.service-row').filter({ hasText: '启动失败服务' }).getByText(/error/).waitFor();
  assert.equal((await invoke(page, 'mcp.list')).find(service => service.id === 'other').state, 'running');
  await frame.getByRole('button', { name: '配置 当前服务', exact: true }).click();
  await frame.locator('#config').waitFor();
  await frame.getByRole('button', { name: '返回服务列表', exact: true }).click();
  await mkdir('.test-results/mcp-list-controls', { recursive: true });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') {
    await toggleTheme(page);
    await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  }
  await page.screenshot({ path: '.test-results/mcp-list-controls/light.png' });
  await toggleTheme(page);
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  await frame.locator('html[data-theme="dark"]').waitFor();
  await page.screenshot({ path: '.test-results/mcp-list-controls/dark.png' });
  await page.setViewportSize({ width: 360, height: 720 });
  assert.equal(await frame.locator('body').evaluate(node => node.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.test-results/mcp-list-controls/narrow.png' });
});
