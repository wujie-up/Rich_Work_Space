import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { launch, openConfiguration, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('续跑检查点在后台崩溃后恢复；其他插件及空桌面仍可使用', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false });
  await page.evaluate(() => workDesk.plugins.enable('work-flow'));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) =>
    workDesk.plugins.invoke('work-flow', method, args), { method, args });
  const workflow = await invoke('workflows.save', { name: '崩溃续跑验证', nodes: [
    { id: 'start', type: 'flow.start', title: '开始', params: {}, x: 20, y: 20 },
    { id: 'human', type: 'flow.user-input', title: '待确认', params: {}, x: 20, y: 20 }
  ], edges: [{ from: 'start', to: 'human' }] });
  const started = await invoke('runs.start', workflow.id);
  let run;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    run = await invoke('runs.get', started.id);
    if (run.status === 'waiting') { break; }
    await setTimeout(25);
  }
  assert.equal(run.status, 'waiting');
  const source = join(data, '续跑隔离探针');
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'continuation-probe', name: '续跑隔离探针',
    version: '1.0.0', apiVersion: 2, dataVersion: 1, main: 'index.mjs' }));
  await writeFile(join(source, 'index.mjs'), `export function activate(context) {
    context.methods.register('probe.directory', () => context.host.runtimeDirectory());
    context.methods.register('probe.ping', () => 'pong');
  } export function deactivate() {}`);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, source);
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(() => workDesk.plugins.enable('continuation-probe'));
  const directory = await page.evaluate(() => workDesk.plugins.invoke('continuation-probe', 'probe.directory', []));
  process.kill(directory.plugins.find(plugin => plugin.pluginId === 'work-flow').pid, 'SIGKILL');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const plugins = await page.evaluate(() => workDesk.plugins.list());
    const workflowPlugin = plugins.find(plugin => plugin.id === 'work-flow');
    if (workflowPlugin.state === 'disabled' && !workflowPlugin.operation) {
      break;
    }
    await setTimeout(25);
  }
  assert.equal(await page.evaluate(() => workDesk.plugins.invoke('continuation-probe', 'probe.ping', [])), 'pong');
  await page.evaluate(() => workDesk.plugins.enable('work-flow'));
  const restored = await invoke('runs.get', started.id);
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.resumable, true);
  assert.equal(restored.pending.interaction.id, run.pending.interaction.id);
  assert.equal((await invoke('runs.continue', started.id)).status, 'waiting');
  await page.evaluate(async () => {
    for (const plugin of await workDesk.plugins.list()) {
      if (plugin.state === 'enabled') {
        const preview = await workDesk.plugins.preview(plugin.id, 'disable');
        await workDesk.plugins.disable(plugin.id, preview.confirmationToken);
      }
    }
  });
  assert.equal(await page.locator('iframe').count(), 0);
  assert.ok((await page.evaluate(() => workDesk.plugins.list())).every(plugin => plugin.state !== 'enabled'));
  const theme = await page.locator('html').getAttribute('data-theme');
  await toggleTheme(page);
  assert.notEqual(await page.locator('html').getAttribute('data-theme'), theme);
  await openConfiguration(page);
  await page.locator('#settings-panel .plugin-toolbar').waitFor();
});
