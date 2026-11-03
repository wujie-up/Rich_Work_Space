import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, output, owner, openWorkspace } from '../../../../desk/test/electron/helpers.js';

test('closing and reopening the plugin twice restores history, collapsed cards and the maximized card', { timeout: 90000 }, async t => {
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json')));
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`));
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(owner => workDesk.plugins.enable(owner), owner);
  const invoke = (method, ...args) => page.evaluate(({ owner, method, args }) => workDesk.plugins.invoke(owner, method, args),
    { owner, method, args });
  await invoke('storage.saveAdapterConfig', { custom: { command: process.execPath, args: [resolve('desk/test/fixtures/pty-cli.cjs')] } });
  const originals = [];
  for (const name of ['正常窗口', '折叠窗口', '最大化窗口', '手动归档']) {
    originals.push(await invoke('sessions.create', { adapterId: 'custom', cwd: data, name }));
  }
  const [normal, collapsed, maximized, manual] = originals;
  await invoke('sessions.archive', manual.id);
  await output(page, normal.id, 'READY 中文');
  await invoke('sessions.write', normal.id, 'before-close\r');
  await output(page, normal.id, 'before-close');
  await invoke('storage.saveLayout', {
    order: [normal.id, collapsed.id, maximized.id], collapsed: [collapsed.id, maximized.id], maximized: [],
    sizes: { [normal.id]: { width: 480, height: 320 }, [collapsed.id]: { width: 450, height: 290 },
      [maximized.id]: { width: 480, height: 405 } },
    positions: { [normal.id]: { col: 0, row: 0 }, [collapsed.id]: { col: 0, row: 14 }, [maximized.id]: { col: 0, row: 27 } }
  });
  let view = await openWorkspace(page);
  await view.locator(`[data-session="${maximized.id}"]`).getByRole('button', { name: '最大化', exact: true }).click();
  await view.locator('.session.maximized').waitFor();
  await page.waitForFunction(async owner => (await workDesk.plugins.invoke(owner, 'storage.getLayout', [])).maximized?.length === 1, owner);
  let previousIds = originals.slice(0, 3).map(session => session.id);
  for (let iteration = 0; iteration < 2; iteration++) {
    // Use the public lifecycle operation, which tears down both the view and its background worker.
    const preview = await page.evaluate(owner => workDesk.plugins.preview(owner, 'close'), owner);
    await page.evaluate(({ owner, token }) => workDesk.plugins.close(owner, token), { owner, token: preview.confirmationToken });
    await page.locator('iframe.plugin-view').waitFor({ state: 'detached' });
    await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
    // A restored maximized card intentionally hides the workspace toolbar awaited by the shared helper.
    view = page.frameLocator(`iframe.plugin-view:visible[src^="desk-plugin://${owner}/"]`);
    await view.locator('.session.maximized').waitFor();
    // A visible first card does not imply the serial recovery queue has finished.
    await view.getByRole('progressbar', { name: '会话恢复进度' }).waitFor({ state: 'detached' });
    await page.waitForFunction(async owner => (await workDesk.plugins.invoke(owner, 'sessions.list', [])).sessions.length === 3, owner);
    const active = (await invoke('sessions.list')).sessions;
    assert.equal(active.length, 3);
    assert.deepEqual(new Set(active.map(session => session.restoredFrom)), new Set([normal.id, collapsed.id, maximized.id]));
    assert.ok(active.every(session => !previousIds.includes(session.id)), 'each reopening starts a new runtime for the same history');
    previousIds = active.map(session => session.id);
    const card = id => view.locator(`[data-layout="${id}"]`);
    assert.equal(await card(collapsed.id).evaluate(node => node.classList.contains('collapsed')), true);
    assert.equal(await card(maximized.id).evaluate(node => node.classList.contains('maximized')), true);
    const saved = await invoke('storage.getLayout');
    assert.equal(saved.sizes[normal.id].height, 320);
    assert.deepEqual(saved.collapsed, [collapsed.id, maximized.id]);
    assert.deepEqual(saved.maximized, [maximized.id]);
    const resumed = active.find(session => session.restoredFrom === normal.id);
    await output(page, resumed.id, 'before-close');
    await invoke('sessions.write', resumed.id, `after-reopen-${iteration}\r`);
    await output(page, resumed.id, `after-reopen-${iteration}`);
  }
  const restored = view.locator(`[data-layout="${maximized.id}"]`);
  await restored.getByRole('button', { name: '恢复原大小', exact: true }).click();
  assert.equal(await restored.evaluate(node => node.classList.contains('collapsed')), true);
  assert.equal((await invoke('storage.getLayout')).sizes[maximized.id].height, 405);
  assert.equal(await view.locator('.session.maximized').count(), 0);
  assert.equal(await view.locator(`[data-layout="${normal.id}"]`).isVisible(), true);
});
