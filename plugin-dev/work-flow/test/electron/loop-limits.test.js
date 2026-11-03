import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('最新安装包：循环暂停原因、总上限按钮和旧批次继续兼容', { timeout: 120000 }, async t => {
  const { app, page, logs } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const output = resolve('.test-results/work-flow');
  await mkdir(output, { recursive: true });
  t.after(() => writeFile(join(output, 'loop-limits.log'), logs.join('')));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const manifest = JSON.parse(await readFile(resolve('plugin-dev/work-flow/plugin.json'), 'utf8'));
  // Install only into the helper's temporary desktop data; the user's running DeskPG stays untouched.
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('work-flow', 'remove');
    await workDesk.plugins.remove('work-flow', 'keep', preview.confirmationToken);
  });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/${manifest.id}-${manifest.version}.plg`));
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(async () => {
    const plugin = (await workDesk.plugins.list()).find(item => item.id === 'work-flow');
    if (plugin.state !== 'enabled') {
      await workDesk.plugins.enable('work-flow');
    }
  });
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const node = (id, type, params = {}) => ({ id, title: id, type, params, x: 50, y: 50 });
  const save = (name, params) => invoke('workflows.save', { name, nodes: [
    node('source', 'text.input', { content: '[]', format: 'json' }),
    node('body', 'result.collect', { input: '需要修改' }),
    node('loop', 'flow.loop', { input: 'true', operator: 'not-empty', maxIterations: 5, ...params }),
    node('end', 'flow.end', { input: '{{body.text}}' })
  ], edges: [{ from: 'source', to: 'body' }, { from: 'body', to: 'loop' },
    { from: 'loop', to: 'body', branch: 'continue' }, { from: 'loop', to: 'end', branch: 'exit' }] });
  const hard = await save('总轮数限制', { maxTotalIterations: 1 });
  const stagnant = await save('无进展暂停', { maxTotalIterations: 5, maxStagnantIterations: 2, progressInput: '{{source.value}}' });
  const legacy = await save('原有批次确认', { maxIterations: 1 });
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible[src^="desk-plugin://work-flow/"]');
  // Wait for boot to finish selecting the default workflow before switching fixtures.
  await frame.locator(`[data-workflow="${legacy.id}"].selected`).waitFor();
  await frame.locator(`[data-workflow="${hard.id}"]`).click();
  await frame.locator(`[data-workflow="${hard.id}"].selected`).waitFor();
  await frame.locator('#run').click();
  await frame.locator('[data-loop="exit"]').waitFor();
  assert.equal((await invoke('runs.list', hard.id)).at(-1).pending.reason, 'total-limit');
  assert.equal(await frame.locator('[data-loop="continue"]').count(), 0);
  await frame.getByText(/已达到总轮次上限 1 轮/).first().waitFor();
  await page.screenshot({ path: join(output, 'loop-total-limit.png') });
  await frame.locator('[data-loop="exit"]').click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  await toggleTheme(page);
  await frame.locator(`[data-workflow="${stagnant.id}"]`).click();
  await frame.locator(`[data-workflow="${stagnant.id}"].selected`).waitFor();
  await frame.locator('#run').click();
  await frame.getByRole('button', { name: '已调整，继续下一轮', exact: true }).waitFor();
  await frame.getByText(/连续 2 轮没有新增已验证关闭的问题/).first().waitFor();
  assert.equal((await invoke('runs.list', stagnant.id)).at(-1).iterations.loop, 3);
  await page.screenshot({ path: join(output, 'loop-no-progress.png') });
  await frame.locator('[data-loop="continue"]').click();
  await frame.getByText(/已达到总轮次上限 5 轮/).first().waitFor();
  assert.equal(await frame.locator('[data-loop="continue"]').count(), 0);
  assert.equal((await invoke('runs.list', stagnant.id)).at(-1).iterations.loop, 5);
  await frame.locator('[data-loop="exit"]').click();
  await frame.locator('#status-text').filter({ hasText: '运行完成' }).waitFor();
  await frame.locator(`[data-workflow="${legacy.id}"]`).click();
  await frame.locator(`[data-workflow="${legacy.id}"].selected`).waitFor();
  await frame.locator('#run').click();
  await frame.getByRole('button', { name: '继续下一组循环', exact: true }).click();
  await frame.locator('[data-loop="continue"]').waitFor();
  assert.equal((await invoke('runs.list', legacy.id)).at(-1).iterations.loop, 2);
  await frame.locator('[data-loop="exit"]').click();
  assert.deepEqual(errors, []);
});
