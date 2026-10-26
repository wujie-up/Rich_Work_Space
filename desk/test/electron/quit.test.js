import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from './helpers.js';

// Isolated lifecycle snapshots exercise the host exit flow without starting business tasks.
async function installQuitProbe(app, page, data, exited) {
  const source = join(data, 'quit-probe-source');
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'quit-probe', name: 'Quit probe', version: '1.0.0',
    apiVersion: 2, dataVersion: 1, main: 'index.mjs', type: 'service', showIcon: false, background: 'service' }));
  await writeFile(join(source, 'index.mjs'), `export function activate(c) {
    c.lifecycle.register({ snapshot: () => [{ id: 'probe', name: 'private task text', exited: ${exited} }],
      stop: () => c.storage.writeJson('plugin-data/quit-probe/stopped.json', { preserved: true }) });
  } export function deactivate() {}`);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    globalThis.quitPrompts = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.quitPrompts.push(options);
      return { response: 0 };
    };
  }, source);
  await page.evaluate(() => workDesk.plugins.install());
}

test('quit: stopped tasks archive without a confirmation', { timeout: 30000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false });
  await installQuitProbe(app, page, data, true);
  const closed = app.waitForEvent('close');
  await page.evaluate(() => workDesk.host.quit()).catch(() => {});
  await closed;
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-data/quit-probe/stopped.json'), 'utf8')), { preserved: true });
});

test('quit: running tasks use a concise confirmation and cancellation keeps the host available', { timeout: 30000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false });
  await installQuitProbe(app, page, data, false);
  await page.evaluate(() => workDesk.host.quit());
  await page.waitForFunction(() => workDesk.host.info().then(info => info.packaged));
  const prompts = await app.evaluate(() => globalThis.quitPrompts);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].message, '存在运行中的插件，是否确认关闭所有任务并退出');
  assert.ok(!prompts[0].detail);
  assert.deepEqual(prompts[0].buttons, ['取消', '关闭任务并退出']);
  assert.equal((await page.evaluate(() => workDesk.plugins.list())).find(plugin => plugin.id === 'quit-probe').state, 'enabled');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  const closed = app.waitForEvent('close');
  await page.evaluate(() => workDesk.host.quit()).catch(() => {});
  await closed;
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-data/quit-probe/stopped.json'), 'utf8')), { preserved: true });
});
