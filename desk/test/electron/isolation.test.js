import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, configure, create, output, owner, alive, openWorkspace, openConfiguration, toggleTheme } from './helpers.js';

test('isolation: backend SIGKILL and renderer SIGKILL leave desktop and another plugin usable', { timeout: 60000 }, async (t) => {
  const { app, page, data } = await launch(t);
  await configure(page);
  const healthy = await create(page, '保持运行的另一个插件');
  await output(page, healthy.id, 'READY 中文');
  const id = 'isolation-probe';
  const source = join(data, '隔离验证插件');
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, name: '隔离验证', version: '1.0.0', apiVersion: 2,
    dataVersion: 1, main: 'index.mjs' }));
  await writeFile(join(source, 'index.mjs'), `export function activate(c) {
    c.methods.register('probe.ping',()=>({pid:process.pid,value:'pong'}));
    c.views.register({id:'probe',title:'隔离验证',entry:'index.html'});
  } export function deactivate() {}`);
  await writeFile(join(source, 'index.html'), '<!doctype html><meta charset="UTF-8"><h1>隔离验证视图</h1>');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, source);
  await page.evaluate(() => workDesk.plugins.install());
  const first = await page.evaluate((id) => workDesk.plugins.invoke(id, 'probe.ping', []), id);
  process.kill(first.pid, 'SIGKILL');
  await page.waitForFunction(async (id) => {
    const record = (await workDesk.plugins.list()).find((entry) => entry.id === id);
    return record.state === 'disabled' && !record.operation;
  }, id);
  assert.equal(alive(healthy.pid), true);
  await output(page, healthy.id, 'READY 中文');
  const beforeTheme = await page.locator('html').getAttribute('data-theme');
  await toggleTheme(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), beforeTheme === 'dark' ? 'light' : 'dark');
  await page.evaluate((id) => workDesk.plugins.enable(id), id);
  await openWorkspace(page, id);
  await page.frameLocator('iframe:visible').getByRole('heading', { name: '隔离验证视图' }).waitFor();
  const processes = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0].webContents.mainFrame;
    return { host: main.osProcessId, plugin: main.frames.find((frame) => frame.url.startsWith('desk-plugin://isolation-probe/')).osProcessId };
  });
  assert.notEqual(processes.host, processes.plugin);
  process.kill(processes.plugin, 'SIGKILL');
  // Playwright marks an OOPIF crash as a page crash. Inspect the surviving host directly through Electron.
  const host = (source) => app.evaluate(({ BrowserWindow }, source) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), source);
  const state = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return { crashed: contents.isCrashed(), pid: contents.getOSProcessId() };
  });
  assert.deepEqual(state, { crashed: false, pid: processes.host });
  for (let n = 0; n < 100 && !await host("document.querySelector('#toast').textContent.includes('isolation-probe')"); n++) {
    await delay(20);
  }
  assert.match(await host("document.querySelector('#toast').textContent"), /isolation-probe.*界面已退出/);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('configuration').click());
  for (let n = 0; n < 100 && !await host("Boolean(document.querySelector('#settings-panel h1'))"); n++) {
    await delay(20);
  }
  assert.equal(await host("document.querySelector('#settings-panel h1').textContent"), '插件中心');
  assert.equal((await host(`workDesk.plugins.invoke('${id}', 'probe.ping', [])`)).value, 'pong');
  await host(`workDesk.plugins.invoke('${owner}', 'sessions.write', ['${healthy.id}', 'after-crash'])`);
  for (let n = 0; n < 100; n++) {
    const snapshot = await host(`workDesk.plugins.invoke('${owner}', 'sessions.attach', ['${healthy.id}'])`);
    if (snapshot.data.includes('after-crash')) {
      break;
    }
    await delay(20);
  }
  assert.match((await host(`workDesk.plugins.invoke('${owner}', 'sessions.attach', ['${healthy.id}'])`)).data, /after-crash/);
  await host(`document.querySelector('#desktop').click();
    document.querySelector('.shelf-app[data-plugin="${id}"]').click()`);
  let recovered;
  for (let n = 0; n < 100; n++) {
    recovered = await app.evaluate(async ({ BrowserWindow }) => {
      const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.frames
        .find((frame) => frame.url.startsWith('desk-plugin://isolation-probe/'));
      return frame?.executeJavaScript('document.querySelector("h1")?.textContent');
    }).catch(() => null);
    if (recovered === '隔离验证视图') {
      break;
    }
    await delay(20);
  }
  assert.equal(recovered, '隔离验证视图');
  await mkdir(resolve('.test-results'), { recursive: true });
  await writeFile(resolve('docs/superpowers/execution/domain-isolation.json'), JSON.stringify({ backendPid: first.pid,
    rendererProcesses: processes, healthyPty: healthy.pid, backendCrashContained: true, rendererCrashContained: true,
    recoveredView: true, testedAt: new Date().toISOString() }, null, 2));
});

test('empty desktop remains usable after all plugins are disabled', { timeout: 60000 }, async (t) => {
  const { page } = await launch(t);
  await page.evaluate(async () => {
    for (const plugin of await workDesk.plugins.list()) {
      if (plugin.state === 'enabled') {
        const preview = await workDesk.plugins.preview(plugin.id, 'disable');
        await workDesk.plugins.disable(plugin.id, preview.confirmationToken);
      }
    }
  });
  if (await page.locator('#desktop').isVisible()) {
    await page.locator('#desktop').click();
  }
  await page.locator('.desktop-surface').waitFor();
  assert.equal(await page.locator('.desktop-surface .application-window, .desktop-surface .session-bubble').count(), 0);
  assert.ok((await page.evaluate(() => workDesk.plugins.list())).every((plugin) => plugin.state !== 'enabled'));
  assert.equal(await page.locator('iframe').count(), 0);
  const beforeTheme = await page.locator('html').getAttribute('data-theme');
  await toggleTheme(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), beforeTheme === 'dark' ? 'light' : 'dark');
  await openConfiguration(page);
  await page.getByRole('heading', { name: '插件中心', exact: true }).waitFor();
});
