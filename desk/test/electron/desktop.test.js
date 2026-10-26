import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, owner, configure, create, output, alive, openConfiguration } from './helpers.js';

test('desktop: confirmed disable retries transient plugin busy and reports persistent contention', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { app, page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases.noindex/mac-arm64/DeckPg.app/Contents/MacOS/DeckPg'), reducedPath: true } : {}) });
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('work-desk:invoke');
    let busy = true;
    ipcMain._invokeHandlers.set('work-desk:invoke', async (event, method, args) => {
      // Reproduce the transient lock after the user has confirmed the snapshot.
      if (method === 'plugins.disable' && busy) {
        busy = false;
        return { ok: false, error: { code: 'PLUGIN_BUSY', message: '插件正在创建任务或执行操作' } };
      }
      return original(event, method, args);
    });
  });
  await configure(page);
  await create(page, '禁用确认测试');
  await openConfiguration(page);
  const card = page.locator(`.plugin-card[data-plugin="${owner}"]`);
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await card.getByRole('switch', { name: '启用', exact: true }).waitFor({ timeout: 5000 });
  const record = await page.evaluate((owner) => workDesk.plugins.list().then((records) => records.find((record) => record.id === owner)), owner);
  assert.equal(record.state, 'disabled');
  assert.equal(record.lastError, null);
  await card.getByRole('switch', { name: '启用', exact: true }).click();
  await card.getByRole('switch', { name: '禁用', exact: true }).waitFor();
  await create(page, '持续占用测试');
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('work-desk:invoke');
    ipcMain._invokeHandlers.set('work-desk:invoke', (event, method, args) => method === 'plugins.disable'
      ? { ok: false, error: { code: 'PLUGIN_BUSY', message: '插件正在创建任务或执行操作' } } : original(event, method, args));
  });
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await page.locator('#toast').filter({ hasText: '插件正在创建任务或执行操作' }).waitFor();
  assert.equal(await page.evaluate((owner) => workDesk.plugins.list().then((records) => records.find((record) => record.id === owner).state), owner), 'enabled');
});

test('desktop: blank desktop, shelf icons, context menus, configuration and drag to open preserve plugin data', { timeout: 120000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases.noindex/mac-arm64/DeckPg.app/Contents/MacOS/DeckPg'), reducedPath: true } : {}) });
  await page.locator('.desktop-surface').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('aside, #navigation').count(), 0);
  const icon = page.locator(`.shelf-app[data-plugin="${owner}"]`);
  await icon.waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.workspace-label').textContent(), '本地工作空间');
  await mkdir(resolve('.test-results'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/desktop-applications.png') });
  await page.locator('.desktop-surface').click({ button: 'right', position: { x: 600, y: 300 } });
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['添加插件']);
  await page.getByRole('menuitem', { name: '添加插件', exact: true }).click();
  await page.locator('#settings-panel .plugin-toolbar').waitFor();
  await page.screenshot({ path: resolve('.test-results/desktop-configuration.png') });
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await icon.click();
  await page.frameLocator('iframe:visible').locator('.workspace-tools').waitFor();
  await configure(page);
  const session = await create(page, '桌面切换保留任务');
  await output(page, session.id, 'READY 中文');
  await page.locator('#desktop').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.application-window')].every((node) => node.dataset.phase === 'inactive'));
  assert.equal(alive(session.pid), true);
  await openConfiguration(page);
  await page.locator('#theme-settings').click();
  await page.locator('#theme-mode').selectOption('light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('#plugin-center').click();
  const card = page.locator(`.plugin-card[data-plugin="${owner}"]`);
  await page.evaluate(() => {
    window.pluginDrop = null;
    window.dragTrace = [];
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
      document.addEventListener(type, (event) => window.dragTrace.push({ type, target: event.target.className, x: event.clientX, y: event.clientY }), { capture: true });
    }
    document.addEventListener('drop', (event) => {
      window.pluginDrop = event.dataTransfer.getData('application/x-work-desk-plugin');
    }, { capture: true, once: true });
  });
  await card.hover();
  await card.dragTo(page.locator('.desktop-surface'), { sourcePosition: { x: 20, y: 20 }, targetPosition: { x: 100, y: 320 } });
  assert.equal(await page.evaluate(() => window.pluginDrop), owner, JSON.stringify(await page.evaluate(() => window.dragTrace)));
  await page.frameLocator('iframe:visible').locator('.workspace-tools').waitFor();
  assert.equal(await page.locator('iframe').count(), 2);
  assert.equal(await page.locator('#settings-panel').count(), 0);
  assert.equal((await page.evaluate((id) => agentDesk.sessions.list(id), owner)).sessions[0].pid, session.pid);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: session.id });
  await page.locator('#desktop').click();
  await openConfiguration(page);
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await card.getByRole('switch', { name: '启用', exact: true }).waitFor().catch(async (error) => {
    console.log('DISABLE_STATE', await page.evaluate(async () => ({ plugins: await workDesk.plugins.list(), toast: document.querySelector('#toast').textContent, panel: document.querySelector('#settings-panel')?.textContent })));
    throw error;
  });
  assert.equal(await icon.getAttribute('data-enabled'), null);
  await card.getByRole('switch', { name: '启用', exact: true }).click();
  await card.getByRole('switch', { name: '禁用', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await icon.count(), 1);
  assert.match((await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id })).output, /READY 中文/);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.reload();
  await icon.waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
});


test('desktop: workspace pages and tabs retain live plugin views', { timeout: 120000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases.noindex/mac-arm64/DeckPg.app/Contents/MacOS/DeckPg'), reducedPath: true } : {}) });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const icon = page.locator(`.shelf-app[data-plugin="${owner}"]`);
  await icon.click();
  const first = page.locator('iframe').first();
  await first.contentFrame().locator('.workspace-tools').waitFor();
  await first.contentFrame().locator('.workspace-tools').evaluate((node) => { node.dataset.retained = 'first-window'; });
  await configure(page);
  const session = await create(page, '气泡窗口保留任务');
  await output(page, session.id, 'READY 中文');
  const win = page.locator('.application-window').first();
  assert.equal(await win.getAttribute('data-mode'), null);
  assert.equal(await page.locator('#dock').count(), 0);
  await openConfiguration(page);
  const bounds = await page.locator('#settings-panel').boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) < 2);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2);
  await page.getByRole('button', { name: '列表展示', exact: true }).click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'list');
  await page.locator('#desktop-settings').click();
  await page.getByLabel('网格大小').selectOption('32');
  await page.waitForFunction(() => document.querySelector('#content').style.getPropertyValue('--grid-size') === '32px');
  await page.locator('#theme-settings').click();
  await page.locator('#theme-mode').selectOption('light');
  assert.equal((await page.evaluate(() => workDesk.storage.getPreferences())).gridSize, 32);
  await page.locator('#plugin-center').click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'list');
  await page.getByRole('button', { name: '图框展示', exact: true }).click();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  const normal = await win.boundingBox();
  const stage = await page.locator('#content').boundingBox();
  const tabs = await page.getByRole('tablist').boundingBox();
  assert.deepEqual(normal, { x: stage.x, y: tabs.y + tabs.height, width: stage.width, height: stage.height - tabs.height });
  assert.equal(await win.locator('.window-resize').count(), 0);
  await page.locator('#desktop').click();
  assert.equal(await first.isVisible(), false);
  await page.getByRole('tab').first().click();
  assert.equal(await first.isVisible(), true);
  assert.deepEqual(await win.boundingBox(), normal);
  assert.equal(await first.contentFrame().locator('.workspace-tools').getAttribute('data-retained'), 'first-window');
  assert.equal(alive(session.pid), true);
  await page.screenshot({ path: resolve('.test-results/desktop-windows.png') });
  await page.getByRole('tab').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('dialog', { name: '确认关闭', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 1);
  assert.equal(alive(session.pid), true);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('iframe'));
  await openConfiguration(page);
  const card = page.locator(`.plugin-card[data-plugin="${owner}"]`);
  await card.getByRole('switch', { name: '禁用', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.window-tab').count(), 0);
  assert.equal(alive(session.pid), false);
  assert.match((await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id })).output, /READY 中文/);
  await page.reload();
  await icon.waitFor();
  assert.equal((await page.evaluate(() => workDesk.storage.getPreferences())).gridSize, 32);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.deepEqual(errors, []);
});


test('desktop: retained windows stay inside a resized desktop', { timeout: 60000 }, async (t) => {
  const { app, page } = await launch(t);
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(480, 420); win.setSize(520, 460); });
  await page.waitForFunction(() => {
    const window = document.querySelector('.application-window').getBoundingClientRect();
    const stage = document.querySelector('#content').getBoundingClientRect();
    return innerWidth === 520 && window.right <= stage.right && window.bottom <= stage.bottom;
  });
  const small = await page.locator('.application-window').boundingBox();
  const stage = await page.locator('#content').boundingBox();
  assert.ok(small.x >= stage.x && small.y >= stage.y);
  assert.ok(small.x + small.width <= stage.x + stage.width && small.y + small.height <= stage.y + stage.height);
  assert.equal(small.x, stage.x);
  assert.equal(small.width, stage.width);
  assert.equal(await page.locator('.window-resize').count(), 0);
  await page.screenshot({ path: resolve('.test-results/desktop-narrow.png') });
});


test('desktop: closing a plugin shell confirms before stopping its processes and all windows', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases.noindex/mac-arm64/DeckPg.app/Contents/MacOS/DeckPg') } : {}) });
  await configure(page, { child: true });
  const session = await create(page, '外壳关闭归档');
  const snapshot = await output(page, session.id, /CHILD=(\d+)/);
  const childPid = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
  const backendPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(session.pid)], { encoding: 'utf8' }).trim());
  assert.match(execFileSync('ps', ['-o', 'command=', '-p', String(backendPid)], { encoding: 'utf8' }), /plugin-worker\.js/);
  await page.locator('#desktop').click();
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  await page.getByRole('tab').hover();
  const close = page.locator('.window-tab .tab-close');
  await close.click();
  await page.getByRole('dialog', { name: '确认关闭', exact: true }).waitFor({ timeout: 4000 });
  assert.equal(alive(session.pid), true);
  assert.equal(alive(childPid), true);
  assert.equal(alive(backendPid), true);
  assert.equal(await page.locator('iframe').count(), 1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 1);
  assert.equal(alive(session.pid), true);
  await close.click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(async (owner) => {
    const plugin = (await workDesk.plugins.list()).find(plugin => plugin.id === owner);
    return plugin.state === 'enabled' && !plugin.operation && !document.querySelector('iframe');
  }, owner);
  // The lifecycle response can precede the OS child-process exit notification.
  for (let attempt = 0; attempt < 60 && [session.pid, childPid, backendPid].some(alive); attempt++) {
    await delay(50);
  }
  assert.equal(alive(session.pid), false);
  assert.equal(alive(childPid), false);
  assert.equal(alive(backendPid), false);
  assert.equal(await page.locator('.window-tab').count(), 0);
  assert.equal(await page.locator(`.shelf-app[data-plugin="${owner}"]`).count(), 1);
  const archived = await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id });
  assert.match(archived.output, /READY 中文/);
});

test('desktop: collapsible plugin shelf opens enabled apps and hides disabled entries', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases.noindex/mac-arm64/DeckPg.app/Contents/MacOS/DeckPg') } : {}) });
  const shelf = page.getByRole('navigation', { name: '已安装插件' });
  const entry = shelf.locator(`[data-plugin="${owner}"]`);
  await entry.waitFor({ timeout: 4000 });
  await entry.click();
  await page.locator('iframe').contentFrame().locator('.workspace-tools').waitFor();
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  assert.equal(await shelf.isVisible(), false);
  await page.getByRole('button', { name: '显示插件栏', exact: true }).click();
  await openConfiguration(page);
  await page.locator(`.plugin-card[data-plugin="${owner}"]`).getByRole('switch', { name: '禁用', exact: true }).click();
  await page.locator(`.plugin-card[data-plugin="${owner}"]`).getByRole('switch', { name: '启用', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await entry.count(), 0);
  assert.equal(await page.locator('iframe').count(), 0);
});


test('desktop: shelf edge reveals on hover and dragging preserves width without collapsing', { timeout: 60000 }, async (t) => {
  const { page } = await launch(t, { openPlugin: false });
  const toggle = page.getByRole('button', { name: '隐藏插件栏', exact: true });
  const shelf = page.locator('#plugin-shelf');
  const initial = await toggle.boundingBox();
  await page.mouse.move(initial.x + 7, initial.y + initial.height / 2);
  await page.mouse.down();
  await page.mouse.move(initial.x + 143, initial.y + initial.height / 2, { steps: 12 });
  await page.mouse.up();
  assert.equal(await shelf.isVisible(), true);
  assert.equal(Math.round((await shelf.boundingBox()).width), 200);
  assert.equal(await page.locator('#content').evaluate((node) => node.offsetLeft), 200);
  await toggle.click();
  const edge = page.getByRole('button', { name: '显示插件栏', exact: true });
  await page.mouse.move(400, 200);
  await page.waitForTimeout(200);
  assert.equal(await edge.evaluate((node) => getComputedStyle(node, '::after').opacity), '0');
  await edge.hover();
  await page.waitForTimeout(200);
  assert.equal(await edge.evaluate((node) => getComputedStyle(node, '::after').opacity), '1');
  await edge.click();
  assert.equal(Math.round((await shelf.boundingBox()).width), 200);
  await page.reload();
  await page.locator('.shelf-app').first().waitFor();
  assert.equal(Math.round((await shelf.boundingBox()).width), 200);
  const divider = page.getByRole('button', { name: '隐藏插件栏', exact: true });
  for (const [delta, expected] of [[500, 320], [-500, 64]]) {
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + 7, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 7 + delta, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(Math.round((await shelf.boundingBox()).width), expected);
    assert.equal(await shelf.isVisible(), true);
  }
  await divider.focus();
  await page.keyboard.press('Enter');
  assert.equal(await shelf.isVisible(), false);
});
