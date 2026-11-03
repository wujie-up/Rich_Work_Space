import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, output, owner, openWorkspace } from '../../../../desk/test/electron/helpers.js';

test('history restores windows without native IDs for both Codex and custom CLI, retaining replay', { timeout: 90000 }, async t => {
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
  const fixture = join(data, 'recoverable-terminal.cjs');
  await writeFile(fixture, "console.log('READY'); process.stdin.resume(); process.stdin.on('data', data => console.log('INPUT=' + data.toString().trim()));");
  const config = { command: process.execPath, args: [fixture] };
  await invoke('storage.saveAdapterConfig', { codex: { ...config, mode: 'legacy' }, custom: config });
  const view = await openWorkspace(page);
  const windowId = await view.locator('body').evaluate(() => window.name.slice(13));
  for (const adapterId of ['codex', 'custom']) {
    const name = `${adapterId} 无 ID 窗口`;
    const original = await invoke('sessions.create', { adapterId, name, cwd: data, windowId });
    await output(page, original.id, 'READY');
    await invoke('sessions.write', original.id, 'before-close\r');
    await output(page, original.id, 'INPUT=before-close');
    await invoke('sessions.archive', original.id);
    assert.equal((await invoke('sessions.readArchive', original.id)).contextId, undefined);
    await view.getByRole('button', { name: '工作台操作', exact: true }).press('Enter');
    await view.locator('.workspace-menu').getByRole('menuitem', { name: '历史', exact: true }).press('Enter');
    const row = view.locator('.history-row').filter({ hasText: name });
    assert.equal(await row.getByRole('button', { name: '恢复窗口', exact: true }).isEnabled(), true);
    await row.getByRole('button', { name: '恢复窗口', exact: true }).click();
    await view.locator('.history-dialog').waitFor({ state: 'detached' });
    const restored = (await invoke('sessions.list')).sessions.find(session => session.restoredFrom === original.id);
    assert.ok(restored);
    assert.equal(restored.windowId, windowId);
    assert.equal(restored.name, name);
    await view.locator(`[data-session="${restored.id}"]`).waitFor();
    const replay = await output(page, restored.id, 'READY');
    assert.match(replay.data, /INPUT=before-close/);
    await invoke('sessions.write', restored.id, 'after-restore\r');
    await output(page, restored.id, 'INPUT=after-restore');
    const shots = resolve('.test-results');
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `agent-${adapterId}-window-restored.png`) });
    await invoke('sessions.archive', restored.id);
  }
});
