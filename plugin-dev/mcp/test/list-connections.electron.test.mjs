import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { launch, toggleTheme } from '../../../desk/test/electron/helpers.js';

const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
const invoke = (page, method, ...args) => page.evaluate(({ method, args }) =>
  workDesk.plugins.invoke('mcp-services', method, args), { method, args });

test('connection count follows live clients without navigation and catches up after hiding', { timeout: 60000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('mcp-services', 'remove');
    await workDesk.plugins.remove('mcp-services', 'keep', preview.confirmationToken);
  });
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  }, resolve(`plugin-dev/dist/mcp-services-${manifest.version}.plg`));
  await page.evaluate(async () => {
    await workDesk.plugins.install();
    await workDesk.plugins.enable('mcp-services');
  });
  await invoke(page, 'mcp.save', { id: 'counted', name: '连接数测试', transport: 'stdio', command: process.execPath,
    args: [resolve('plugin-dev/mcp/test/fixture.mjs')], env: {} });
  await invoke(page, 'mcp.start', 'counted');
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  const frame = page.frameLocator('iframe[title="MCP 服务"]:visible');
  const row = frame.locator('.service-row').filter({ hasText: '连接数测试' });
  await row.getByText('running · 0 个连接', { exact: true }).waitFor();
  const stop = frame.getByRole('button', { name: '关闭 连接数测试', exact: true });
  const connection = (await invoke(page, 'mcp.connections')).services.find(service => service.id === 'counted');
  const clients = [];
  t.after(async () => {
    for (const { client } of clients) { await client.close(); }
  });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: 'list-count-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } });
    clients.push({ client, transport });
    await client.connect(transport);
  }
  assert.equal((await invoke(page, 'mcp.list')).find(service => service.id === 'counted').clients, 2);
  await stop.focus();
  await row.getByText('running · 2 个连接', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await stop.evaluate(node => node === document.activeElement), true);
  await mkdir('.test-results/mcp-list-connections', { recursive: true });
  await page.screenshot({ path: '.test-results/mcp-list-connections/connected.png' });
  await clients[0].transport.terminateSession();
  await clients[0].client.close();
  await row.getByText('running · 1 个连接', { exact: true }).waitFor({ timeout: 5000 });
  await page.locator('#desktop').click();
  await clients[1].transport.terminateSession();
  await clients[1].client.close();
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  await row.getByText('running · 0 个连接', { exact: true }).waitFor({ timeout: 5000 });
  await frame.getByRole('button', { name: '配置 连接数测试', exact: true }).click();
  const name = frame.locator('[name="name"]');
  await name.fill('尚未保存的编辑');
  await name.focus();
  await toggleTheme(page);
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  assert.equal(await name.inputValue(), '尚未保存的编辑');
  await frame.getByRole('button', { name: '返回服务列表', exact: true }).click();
  await page.setViewportSize({ width: 360, height: 720 });
  assert.equal(await frame.locator('body').evaluate(node => node.scrollWidth <= innerWidth), true);
  await stop.click();
  await row.getByText('stopped · 0 个连接', { exact: true }).waitFor();
  assert.equal(await frame.getByRole('button', { name: '开启 连接数测试', exact: true }).isEnabled(), true);
});
