import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { launch, output, owner, openWorkspace } from '../../../../desk/test/electron/helpers.js';

for (const exit of ['desktop quit', 'abrupt desktop exit', 'worker SIGKILL then desktop quit']) {
  test(`terminal history survives ${exit} and restart`, { timeout: 90000 }, async t => {
    const { version } = JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json')));
    const first = await launch(t, { openPlugin: false, prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
    await first.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`));
    await first.page.evaluate(() => workDesk.plugins.install());
    const invoke = (page, method, ...args) => page.evaluate(({ owner, method, args }) => workDesk.plugins.invoke(owner, method, args),
      { owner, method, args });
    const fixture = join(first.data, 'persistent-cli.cjs');
    await writeFile(fixture, `const fs = require('node:fs');
const path = require('node:path');
const logDir = process.argv.find(arg => arg.startsWith('log_dir='));
if (logDir) {
  fs.writeFileSync(path.join(JSON.parse(logDir.slice(8)), 'codex-tui.log'),
    'INFO session_loop{thread_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}: codex_core::session: new\\n');
}
console.log('PERSISTENCE_READY');
process.stdin.resume();
process.stdin.on('data', data => console.log('INPUT=' + data.toString().trim()));
`);
    const config = { command: process.execPath, args: [fixture] };
    await invoke(first.page, 'storage.saveAdapterConfig', { codex: { ...config, mode: 'legacy' }, custom: config });
    const created = await invoke(first.page, 'sessions.create', { adapterId: 'codex', cwd: first.data, name: '退出后恢复上下文' });
    await output(first.page, created.id, 'PERSISTENCE_READY');
    await first.page.evaluate(({ owner, id }) => {
      window.persistedTerminalOutput = false;
      workDesk.events.pluginEvent(event => {
        if (event.pluginId === owner && event.channel === 'sessions.output' && event.value.sessionId === id
          && event.value.data.includes('INPUT=before-quit')) {
          window.persistedTerminalOutput = true;
        }
      });
    }, { owner, id: created.id });
    await invoke(first.page, 'sessions.write', created.id, 'before-quit\r');
    await output(first.page, created.id, 'INPUT=before-quit');
    await first.page.waitForFunction(() => window.persistedTerminalOutput);
    const empty = await invoke(first.page, 'sessions.create', { adapterId: 'custom', cwd: first.data, name: '创建后立即退出' });
    const manual = await invoke(first.page, 'sessions.create', { adapterId: 'custom', cwd: first.data, name: '手动归档不自动恢复' });
    await invoke(first.page, 'sessions.archive', manual.id);
    if (exit.startsWith('worker')) {
      const workerPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(created.pid)], { encoding: 'utf8' }).trim());
      process.kill(workerPid, 'SIGKILL');
      // waitForFunction treats a Promise as truthy; poll the resolved IPC result explicitly.
      for (let attempt = 0; attempt < 100; attempt++) {
        const record = await first.page.evaluate(async owner =>
          (await workDesk.plugins.list()).find(plugin => plugin.id === owner), owner);
        if (record.state === 'disabled' && !record.operation) {
          break;
        }
        await delay(25);
      }
      assert.doesNotMatch(first.logs.join('\n'), /kill EPERM|进程清理失败/);
      const remaining = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).trim().split('\n')
        .map(line => line.trim().split(/\s+/)).filter(([pid, state]) => [created.pid, empty.pid].includes(Number(pid))
          && !state.startsWith('Z'));
      assert.deepEqual(remaining, [], `worker=${workerPid}\n${first.logs.join('\n')}`);
    }
    const closed = once(first.app, 'close');
    await first.app.evaluate(({ app }, crash) => {
      // app.exit bypasses quit hooks, leaving active session records for startup recovery.
      setImmediate(() => crash ? app.exit(0) : app.quit());
    }, exit === 'abrupt desktop exit');
    await closed;
    const second = await launch(t, { openPlugin: false, prepareData: async data => {
      for (const name of ['plugins', 'plugin-data', 'plugins.json']) {
        await cp(join(first.data, name), join(data, name), { recursive: true });
      }
    } });
    // Explicit activation must recover persisted sessions even if the previous host left the plugin disabled.
    const plugin = (await second.page.evaluate(() => workDesk.plugins.list())).find(plugin => plugin.id === owner);
    if (plugin.state !== 'enabled') {
      await second.page.evaluate(owner => workDesk.plugins.enable(owner), owner);
    }
    const archives = (await invoke(second.page, 'sessions.list')).archives;
    assert.ok(archives.some(record => record.id === empty.id), 'a session is recoverable immediately after creation');
    assert.ok(archives.some(record => record.id === created.id), 'quit must retain the session in history');
    const saved = await invoke(second.page, 'sessions.readArchive', created.id);
    assert.equal(saved.contextId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.match(saved.output, /INPUT=before-quit/);
    const view = await openWorkspace(second.page);
    await view.locator('.session').filter({ hasText: '创建后立即退出' }).waitFor();
    await view.locator('.session').filter({ hasText: '退出后恢复上下文' }).waitFor();
    const active = (await invoke(second.page, 'sessions.list')).sessions;
    const restored = active.find(record => record.restoredFrom === created.id);
    assert.ok(restored);
    assert.equal(active.length, 2);
    assert.equal(active.some(record => record.restoredFrom === manual.id), false);
    assert.ok(active.every(record => record.windowId === restored.windowId), 'recovered cards must attach to the new visible window');
    await invoke(second.page, 'sessions.write', restored.id, 'after-restart\r');
    await output(second.page, restored.id, 'INPUT=after-restart');
    await invoke(second.page, 'sessions.archive', restored.id);
    assert.match((await invoke(second.page, 'sessions.readArchive', created.id)).output, /INPUT=before-quit[\s\S]*INPUT=after-restart/);
  });
}

test('reopening after a plugin view crash reattaches the running terminal', { timeout: 60000 }, async t => {
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json')));
  const { app, page } = await launch(t, { openPlugin: false, prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`));
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(({ owner, command, fixture }) => workDesk.plugins.invoke(owner, 'storage.saveAdapterConfig', [
    { custom: { command, args: [fixture] } }
  ]), { owner, command: process.execPath, fixture: resolve('desk/test/fixtures/pty-cli.cjs') });
  const view = await openWorkspace(page);
  const windowId = await view.locator('html').evaluate(() => window.name.slice(13));
  const created = await page.evaluate(({ owner, cwd, windowId }) => workDesk.plugins.invoke(owner, 'sessions.create', [
    { adapterId: 'custom', cwd, windowId, name: '界面崩溃后保留运行' }
  ]), { owner, cwd: resolve('.'), windowId });
  await view.locator(`.session[data-session="${created.id}"]`).waitFor();
  await output(page, created.id, 'READY 中文');
  const rendererPid = await app.evaluate(({ BrowserWindow }, owner) => BrowserWindow.getAllWindows()[0].webContents.mainFrame.frames
    .find(frame => frame.url.startsWith(`desk-plugin://${owner}/`)).osProcessId, owner);
  process.kill(rendererPid, 'SIGKILL');
  // Playwright treats an OOPIF crash as a page crash; use the surviving Electron host to reopen it.
  const host = source => app.evaluate(({ BrowserWindow }, source) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), source);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await host('document.querySelectorAll("iframe.plugin-view").length === 0')) {
      break;
    }
    await delay(25);
  }
  await host(`document.querySelector('.shelf-app[data-plugin="${owner}"]').click()`);
  let visible;
  for (let attempt = 0; attempt < 200; attempt++) {
    visible = await app.evaluate(async ({ BrowserWindow }, owner) => {
      const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.frames
        .find(frame => frame.url.startsWith(`desk-plugin://${owner}/`));
      return frame?.executeJavaScript('document.querySelector(".session")?.dataset.session');
    }, owner).catch(() => null);
    if (visible === created.id) {
      break;
    }
    await delay(25);
  }
  assert.equal(visible, created.id);
  const active = await host(`workDesk.plugins.invoke('${owner}', 'sessions.list', [])`);
  assert.equal(active.sessions.length, 1);
  assert.equal(active.sessions[0].pid, created.pid);
  assert.notEqual(active.sessions[0].windowId, windowId);
  await host(`workDesk.plugins.invoke('${owner}', 'sessions.write', ['${created.id}', 'after-view-crash'])`);
  let replay;
  for (let attempt = 0; attempt < 100; attempt++) {
    replay = await host(`workDesk.plugins.invoke('${owner}', 'sessions.attach', ['${created.id}'])`);
    if (replay.data.includes('after-view-crash')) {
      break;
    }
    await delay(25);
  }
  assert.match(replay.data, /after-view-crash/);
});
