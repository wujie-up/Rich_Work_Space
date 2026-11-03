import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('运行期间在右侧查看已提交文件，保留阅读位置且链接不读取网页', { timeout: 90000 }, async t => {
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
  const workflow = await invoke('workflows.save', { name: '已选文件查看验证', nodes: [
    { id: 'start', type: 'flow.start', title: '开始', params: {}, x: 0, y: 200 },
    { id: 'file', type: 'flow.user-input', title: '需求文档', params: { interaction: 'file', title: '需求文档' }, x: 0, y: 0 },
    { id: 'read', type: 'result.collect', title: '读取文档', params: { input: '{{file.text}}' }, x: 300, y: 0 },
    { id: 'loop', type: 'flow.loop', title: '等待下一轮', params: { input: '{{file.text}}', operator: 'not-empty', maxIterations: 1 }, x: 600, y: 0 },
    { id: 'end', type: 'flow.end', title: '完成', params: { input: '{{file.text}}' }, x: 900, y: 0 }
  ], edges: [{ from: 'start', to: 'file' }, { from: 'file', to: 'read' }, { from: 'read', to: 'loop' },
    { from: 'loop', to: 'read', branch: 'continue' }, { from: 'loop', to: 'end', branch: 'exit' }] });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  await frame.locator(`[data-workflow="${workflow.id}"]`).click();
  await frame.locator('#run').click();
  const dialog = frame.locator('dialog[aria-labelledby="user-input-title"]');
  const body = '# 已选需求\n<script>window.previewUnsafe = true</script>\n' + '必须保留原始内容。\n'.repeat(100);
  await dialog.locator('input[type="file"]').setInputFiles({ name: '需求<&>.md', mimeType: 'text/markdown', buffer: Buffer.from(body) });
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const result = frame.locator('[data-result-node="file"]');
  await result.locator(':scope > summary').click();
  const resultPreview = result.locator('[data-file-preview="file"]');
  await resultPreview.locator('summary').waitFor({ timeout: 5000 });
  assert.match(await resultPreview.locator('summary').innerText(), /需求<&>\.md/);
  await resultPreview.locator('summary').click();
  assert.equal(await resultPreview.locator('pre').textContent(), body);
  await resultPreview.locator('pre').evaluate(element => { element.scrollTop = 100; });
  const run = (await invoke('runs.list', workflow.id)).at(-1);
  assert.equal(run.pending.kind, 'loop');
  await invoke('runs.loop', { runId: run.id, decision: 'continue' });
  await page.waitForFunction(async id => (await workDesk.plugins.invoke('work-flow', 'runs.get', [id])).iterations.loop === 2, run.id);
  assert.equal(await resultPreview.getAttribute('open'), '');
  assert.ok(await resultPreview.locator('pre').evaluate(element => element.scrollTop) > 0);
  await frame.locator('[data-node="file"] .title').click();
  const selected = frame.locator('#properties [data-file-preview="file"]');
  await selected.locator('summary').click();
  assert.equal(await selected.locator('pre').textContent(), body);
  await selected.locator('pre').evaluate(element => { element.scrollTop = 100; });
  await invoke('runs.loop', { runId: run.id, decision: 'continue' });
  await page.waitForFunction(async id => (await workDesk.plugins.invoke('work-flow', 'runs.get', [id])).iterations.loop === 3, run.id);
  assert.equal(await selected.getAttribute('open'), '');
  assert.ok(await selected.locator('pre').evaluate(element => element.scrollTop) > 0);
  assert.equal(await selected.locator('script').count(), 0);
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  for (let index = 0; index < 2; index += 1) {
    if (index) { await toggleTheme(page); }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720));
    const bounds = await selected.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= await page.evaluate(() => innerWidth));
    await page.screenshot({ path: join(output, `file-preview-${index}.png`) });
  }
  await invoke('runs.loop', { runId: run.id, decision: 'exit' });
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  assert.equal(await selected.locator('pre').textContent(), body);
  await frame.locator('#run').click();
  assert.equal(await frame.locator('[data-file-preview]').count(), 0);
  const url = 'http://127.0.0.1:1/private?doc=需求&version=1#章节';
  await dialog.getByLabel('文件来源', { exact: true }).selectOption('link');
  await dialog.getByLabel('网页链接', { exact: true }).fill(url);
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await frame.locator('[data-node="file"] .title').click();
  await selected.locator('summary').click();
  assert.equal(await selected.locator('pre').textContent(), url);
  assert.match(await selected.locator('summary').innerText(), /127\.0\.0\.1/);
  assert.deepEqual(errors, []);
});
