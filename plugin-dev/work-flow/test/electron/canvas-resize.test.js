import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openConfiguration, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('最新 DeskPG：节点缩放、最小尺寸、连线跟随和保存恢复，缩放不移动或误选节点', { timeout: 120000 }, async t => {
  const { app, page, data, logs } = await launch(t, { executablePath: '/Applications/DeskPG.app/Contents/MacOS/DeskPG',
    openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  t.after(() => writeFile(`${output}/canvas-resize.log`, logs.join('')));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const manifest = JSON.parse(await readFile('plugin-dev/work-flow/plugin.json', 'utf8'));
  // The latest installation already includes this plugin; verify the packaged version instead of installing twice.
  const installed = await page.evaluate(() => workDesk.plugins.list());
  assert.equal(installed.find(plugin => plugin.id === 'work-flow')?.version, manifest.version);
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '节点拉伸验证', nodes: [
    { id: 'source', type: 'text.input', title: '可调整尺寸的需求输入节点', x: 20, y: 20, params: { content: '需求' } },
    { id: 'done', type: 'flow.end', title: '完成', x: 600, y: 40, params: {} }
  ], edges: [{ from: 'source', to: 'done' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.application-window')]
    .every(node => ['open', 'inactive'].includes(node.dataset.phase)));
  const source = frame.locator('[data-node="source"]');
  const handle = source.getByRole('button', { name: '调整节点大小', exact: true });
  await handle.waitFor({ timeout: 5000 });
  const initial = await source.boundingBox();
  const originalEdge = await frame.locator('.edges path.hit').getAttribute('d');
  async function resizeBy(dx, dy) {
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  }
  await resizeBy(160, 90);
  const enlarged = await source.boundingBox();
  assert.equal(enlarged.width, initial.width + 160);
  assert.ok(Math.abs(enlarged.height - initial.height - 90) < 1, '自然高度的小数像素允许取整');
  assert.equal(enlarged.x, initial.x);
  assert.equal(enlarged.y, initial.y);
  assert.notEqual(await frame.locator('.edges path.hit').getAttribute('d'), originalEdge);
  assert.equal(await frame.locator('.node.selected').count(), 0);
  await frame.locator('#status').filter({ hasText: '未保存' }).waitFor();
  await resizeBy(-enlarged.width + 30, -enlarged.height + 30);
  const minimum = await source.boundingBox();
  assert.equal(minimum.width, 210);
  assert.equal(minimum.height, 130);
  await handle.focus();
  await handle.press('ArrowRight');
  await handle.press('Shift+ArrowDown');
  const resized = await source.boundingBox();
  assert.equal(resized.width, 220);
  assert.equal(resized.height, 180);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  const saved = (await invoke('workflows.list')).find(item => item.id === workflow.id);
  assert.equal(saved.nodes[0].width, 220);
  assert.equal(saved.nodes[0].height, 180);
  assert.equal(saved.nodes[0].x, 20);
  assert.equal(saved.nodes[0].y, 20);
  const disk = JSON.parse(await readFile(join(data, 'plugin-data/work-flow/workflows.json'), 'utf8'));
  assert.equal(disk.items.find(item => item.id === workflow.id).nodes[0].width, 220);
  await page.reload();
  if (!await frame.locator('#stage').isVisible()) {
    await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  }
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  assert.equal((await source.boundingBox()).width, 220);
  assert.equal((await source.boundingBox()).height, 180);
  await resizeBy(180, 80);
  await page.screenshot({ path: `${output}/canvas-resize-dark.png` });
  await toggleTheme(page);
  await page.screenshot({ path: `${output}/canvas-resize-light.png` });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
  await page.screenshot({ path: `${output}/canvas-resize-narrow.png` });
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="work-flow"]').getByRole('button', { name: '插件配置', exact: true }).click();
  await page.locator('dialog.plugin-settings').getByText(`v${manifest.version}`, { exact: false }).waitFor();
  await page.locator('dialog.plugin-settings').screenshot({ path: `${output}/canvas-resize-settings.png` });
  assert.deepEqual(errors, []);
});
