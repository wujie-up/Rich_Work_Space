import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, alive } from './helpers.js';

async function assertExited(pid) {
  // Closing removes the shell before the OS necessarily reports the worker's exit.
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++) {
    await delay(20);
  }
  assert.equal(alive(pid), false);
}

async function installProbe(app, page, data, id, { hangSnapshot = false } = {}) {
  const source = join(data, id);
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 2,
    dataVersion: 1, main: 'index.mjs', closeDescription: '停止验证任务，保留已保存数据。' }));
  await writeFile(join(source, 'index.mjs'), `export function activate(c) {
    const key = 'plugin-data/' + c.pluginId + '/saved.json';
    c.methods.register('probe.ping', async () => ({ pid: process.pid, saved: await c.storage.readJson(key, {}) }));
    c.methods.register('probe.save', value => c.storage.writeJson(key, value));
    c.lifecycle.register({ snapshot: () => ${hangSnapshot ? 'new Promise(() => {})' : "[{ id: 'running-probe', name: '窗口验证任务' }]"},
      stop: () => c.storage.writeJson('plugin-data/' + c.pluginId + '/stopped.json', { stopped: true }) });
    c.views.register({ id: 'probe', title: c.pluginId, entry: 'index.html' });
  } export function deactivate() {}`);
  await writeFile(join(source, 'index.html'), '<!doctype html><meta charset="UTF-8"><input aria-label="窗口草稿">');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, source);
  await page.evaluate(() => workDesk.plugins.install());
  return page.evaluate(id => workDesk.plugins.invoke(id, 'probe.ping', []), id);
}

async function launchProbes(t) {
  const { app, page, data } = await launch(t, { openPlugin: false });
  // Keep lifecycle probes isolated from bundled plugins and their desktop overlays.
  await page.evaluate(async () => {
    for (const plugin of await workDesk.plugins.list()) {
      if (plugin.state === 'enabled') {
        const snapshot = await workDesk.plugins.preview(plugin.id, 'disable');
        await workDesk.plugins.disable(plugin.id, snapshot.confirmationToken);
      }
    }
  });
  return { app, page, data };
}

test('window close preserves sibling frames and backend; last window confirms and stops only its plugin', { timeout: 60000 }, async (t) => {
  const { app, page, data } = await launchProbes(t);
  const id = 'window-close-probe';
  const target = await installProbe(app, page, data, id);
  const other = await installProbe(app, page, data, 'window-close-other');
  const ping = () => page.evaluate(id => workDesk.plugins.invoke(id, 'probe.ping', []), id);
  await page.evaluate(id => workDesk.plugins.invoke(id, 'probe.save', [{ value: '保留的数据' }]), id);
  const open = async pluginId => {
    await page.locator(`.shelf-app[data-plugin="${pluginId}"]`).click();
    const shell = page.locator('.application-window[data-phase="open"]');
    await shell.frameLocator('iframe').getByRole('textbox', { name: '窗口草稿' }).waitFor();
    return shell.getAttribute('data-window');
  };
  const first = await open(id);
  const firstShell = page.locator(`.application-window[data-window="${first}"]`);
  await firstShell.frameLocator('iframe').getByRole('textbox').fill('第一个窗口的草稿');
  await firstShell.getByRole('button', { name: '新建窗口', exact: true }).click();
  const second = await page.locator('.application-window').last().getAttribute('data-window');
  await open('window-close-other');
  const secondShell = page.locator(`.application-window[data-window="${second}"]`);
  await page.locator(`.window-tab[data-window="${second}"] .tab-close`).evaluate(node => node.click());
  await secondShell.waitFor({ state: 'detached', timeout: 3000 });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('.application-window').count(), 2);
  assert.equal(await firstShell.frameLocator('iframe').getByRole('textbox').inputValue(), '第一个窗口的草稿');
  assert.equal((await ping()).pid, target.pid);
  assert.equal(alive(other.pid), true);

  await open(id);
  await firstShell.getByRole('button', { name: '新建窗口', exact: true }).click();
  const third = await page.locator('.application-window').last().getAttribute('data-window');
  const thirdShell = page.locator(`.application-window[data-window="${third}"]`);
  await thirdShell.frameLocator('iframe').getByRole('textbox').fill('最后窗口的草稿');
  await page.locator(`.window-tab[data-window="${first}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭窗口', exact: true }).click();
  await firstShell.waitFor({ state: 'detached' });
  assert.equal(await page.locator(`.window-tab[data-window="${first}"]`).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal((await ping()).pid, target.pid);

  await page.locator(`.window-tab[data-window="${third}"]`).hover();
  await page.locator(`.window-tab[data-window="${third}"] .tab-close`).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await thirdShell.frameLocator('iframe').getByRole('textbox').inputValue(), '最后窗口的草稿');
  assert.equal((await ping()).pid, target.pid);
  await page.locator(`.window-tab[data-window="${third}"]`).hover();
  await page.locator(`.window-tab[data-window="${third}"] .tab-close`).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true });
  await page.waitForFunction(() => document.querySelector('dialog button[aria-label="关闭"]')?.title === '关闭');
  await confirm.click();
  await thirdShell.waitFor({ state: 'detached' });
  await assertExited(target.pid);
  assert.equal(alive(other.pid), true);
  assert.equal(await page.locator('.application-window').count(), 1);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-data', id, 'stopped.json'), 'utf8')), { stopped: true });
  await open(id);
  const restarted = await ping();
  assert.notEqual(restarted.pid, target.pid);
  assert.deepEqual(restarted.saved, { value: '保留的数据' });
});

test('last window can cancel or force close when its plugin snapshot hangs', { timeout: 60000 }, async (t) => {
  const { app, page, data } = await launchProbes(t);
  const id = 'window-close-hanging';
  const target = await installProbe(app, page, data, id, { hangSnapshot: true });
  const other = await installProbe(app, page, data, 'window-close-healthy');
  const launcher = page.locator(`.shelf-app[data-plugin="${id}"]`);
  await launcher.click();
  await page.getByRole('button', { name: '新建窗口', exact: true }).click();
  await page.locator('.window-tab').first().locator('.tab-close').evaluate(node => node.click());
  await page.waitForFunction(() => document.querySelectorAll('.application-window').length === 1);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(alive(target.pid), true);
  const close = page.locator('.window-tab .tab-close');
  await page.locator('.window-tab').hover();
  await close.click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(alive(target.pid), true);
  assert.equal(await page.locator('.application-window').count(), 1);
  await page.mouse.move(400, 200);
  await page.locator('.window-tab').hover();
  await close.click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true });
  assert.match(await confirm.getAttribute('title'), /强制关闭/);
  await confirm.click();
  await page.locator('.application-window').waitFor({ state: 'detached' });
  await assertExited(target.pid);
  assert.equal(alive(other.pid), true);
});
