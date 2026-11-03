import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openConfiguration, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('粘贴链接不发起网络请求，原样传递并支持暂停后重选', { timeout: 90000 }, async t => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    res.writeHead(403).end('需要登录');
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/private?doc=需求&version=1#章节`;
  const { app, page } = await launch(t, { openPlugin: false });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/work-flow/plugin.json'), 'utf8'));
  await page.evaluate(async source => {
    const preview = await workDesk.plugins.preview('work-flow', 'upgrade');
    await workDesk.plugins.upgrade('work-flow', source, preview.confirmationToken);
    await workDesk.plugins.enable('work-flow');
  }, resolve(`plugin-dev/dist/work-flow-${version}.plg`));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '网页需求输入', nodes: [
    { id: 'start', type: 'flow.start', params: {}, x: 0, y: 0 },
    { id: 'file', type: 'flow.user-input', title: '需求文档', params: { interaction: 'file', title: '需求文档' }, x: 250, y: 0 },
    { id: 'pause', type: 'flow.user-input', title: '下一步', params: { title: '下一步', interaction: 'file' }, x: 500, y: 0 },
    { id: 'end', type: 'flow.end', params: { input: '{{file.text}}' }, x: 750, y: 0 }
  ], edges: [{ from: 'start', to: 'file' }, { from: 'file', to: 'pause' }, { from: 'pause', to: 'end' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('#run').click();
  const dialog = frame.locator('dialog[aria-labelledby="user-input-title"]');
  const source = dialog.getByLabel('文件来源', { exact: true });
  await source.selectOption('link');
  const link = dialog.getByLabel('网页链接', { exact: true });
  await link.fill('file:///tmp/a');
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'HTTP' }).waitFor();
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  for (let index = 0; index < 2; index += 1) {
    if (index) { await toggleTheme(page); }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 650));
    await link.fill(url);
    const bounds = await link.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= await page.evaluate(() => innerWidth));
    await page.screenshot({ path: join(output, `document-link-${index}.png`) });
  }
  await source.selectOption('system');
  assert.equal(await link.isVisible(), false);
  await source.selectOption('link');
  assert.equal(await link.inputValue(), '');
  await link.fill(url);
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await dialog.locator('h2').filter({ hasText: '下一步' }).waitFor();
  const run = (await invoke('runs.list', workflow.id)).at(-1);
  assert.equal(run.nodes.file.output.text, url);
  assert.equal(run.nodes.file.output.file.url, url);
  assert.equal(run.nodes.file.output.file.name, new URL(url).hostname);
  const revisedUrl = `${url}&revision=2`;
  assert.equal(requests, 0);
  await dialog.getByRole('button', { name: '稍后处理', exact: true }).click();
  await frame.locator('#continue-run').waitFor();
  assert.equal((await invoke('runs.get', run.id)).nodes.file.output.text, url);
  const result = frame.locator('details[data-result-node="file"]');
  await result.locator(':scope > summary').click();
  await result.getByRole('button', { name: '重新选择文件', exact: true }).click();
  await frame.getByRole('button', { name: '确认重新选择', exact: true }).click();
  await dialog.locator('h2').filter({ hasText: '需求文档' }).waitFor();
  await source.selectOption('link');
  await link.fill(revisedUrl);
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await dialog.locator('h2').filter({ hasText: '下一步' }).waitFor();
  await dialog.locator('input[type="file"]').setInputFiles({ name: '补充.md', mimeType: 'text/markdown', buffer: Buffer.from('继续') });
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  assert.equal((await invoke('runs.get', run.id)).nodes.end.output.final, revisedUrl);
  assert.equal(requests, 0);
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="work-flow"]').getByRole('button', { name: '插件配置', exact: true }).click();
  await page.locator('dialog.plugin-settings').waitFor();
  assert.deepEqual(errors, []);
});
