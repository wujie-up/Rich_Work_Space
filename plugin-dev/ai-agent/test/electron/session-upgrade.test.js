import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, output, owner, openWorkspace } from '../../../../desk/test/electron/helpers.js';

test('upgrading restores previously force-closed and running sessions while manual archives stay closed', { timeout: 90000 }, async t => {
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json'), 'utf8'));
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('plugin-dev/dist/ai-agent-sessions-0.6.37.plg'));
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(owner => workDesk.plugins.enable(owner), owner);
  const invoke = (method, ...args) => page.evaluate(({ owner, method, args }) => workDesk.plugins.invoke(owner, method, args),
    { owner, method, args });
  await invoke('storage.saveAdapterConfig', { custom: {
    command: process.execPath, args: [resolve('desk/test/fixtures/pty-cli.cjs')]
  } });
  let view = await openWorkspace(page);
  let windowId = await view.locator('html').evaluate(() => window.name.slice(13));
  const original = await invoke('sessions.create', { adapterId: 'custom', cwd: data, windowId, name: '强制关闭后升级恢复' });
  await output(page, original.id, 'READY 中文');
  await invoke('sessions.write', original.id, 'before-force-close\r');
  await output(page, original.id, 'before-force-close');
  await page.evaluate(owner => workDesk.plugins.forceClose(owner), owner);
  view = await openWorkspace(page);
  await view.locator('.session').filter({ hasText: original.name }).waitFor();
  windowId = await view.locator('html').evaluate(() => window.name.slice(13));
  const running = await invoke('sessions.create', { adapterId: 'custom', cwd: data, windowId, name: '升级时运行的会话' });
  const manual = await invoke('sessions.create', { adapterId: 'custom', cwd: data, windowId, name: '手动归档保持关闭' });
  await invoke('sessions.archive', manual.id);
  const preview = await page.evaluate(owner => workDesk.plugins.preview(owner, 'upgrade'), owner);
  await page.evaluate(({ owner, path, token }) => workDesk.plugins.upgrade(owner, path, token),
    { owner, path: resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`), token: preview.confirmationToken });
  view = await openWorkspace(page);
  await view.locator('.session').filter({ hasText: original.name }).waitFor();
  await view.locator('.session').filter({ hasText: running.name }).waitFor();
  const { sessions, archives } = await invoke('sessions.list');
  assert.equal(sessions.length, 2);
  assert.deepEqual(new Set(sessions.map(session => session.restoredFrom)), new Set([original.id, running.id]));
  assert.ok(archives.some(record => record.id === manual.id));
  const restored = sessions.find(session => session.restoredFrom === original.id);
  assert.match((await invoke('sessions.attach', restored.id)).data, /before-force-close/);
  await invoke('sessions.write', restored.id, 'after-upgrade\r');
  await output(page, restored.id, 'after-upgrade');
  const config = await invoke('storage.getAdapterConfig');
  assert.equal(config.custom.command, process.execPath);
});
