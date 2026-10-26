import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, access, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

test('startup: duplicate launch restores the existing workbench and isolated tests retain saved data', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'deckpg-startup-'));
  const other = await mkdtemp(join(tmpdir(), 'deckpg-startup-other-'));
  const preferences = JSON.stringify({ theme: 'light', language: 'en', gridSize: 24 });
  for (const directory of [data, other]) {
    await writeFile(join(directory, 'plugins.json'), '[]');
    await writeFile(join(directory, 'preferences.json'), preferences);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [resolve('.'), '--desk-test', `--desk-data=${data}`];
  const app = await electron.launch({ executablePath: require('electron'), args, env });
  t.after(async () => {
    await app.close();
    await Promise.all([data, other].map(directory => rm(directory, { recursive: true, force: true })));
  });
  const page = await app.firstWindow();
  await page.locator('.workspace-label').waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.shelf-app').count(), 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  const second = spawn(require('electron'), args, { env, stdio: 'ignore' });
  t.after(() => { if (second.exitCode === null) { second.kill('SIGKILL'); } });
  const exit = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(Error('duplicate process did not exit')), 10000);
    second.once('error', error => { clearTimeout(timer); reject(error); });
    second.once('exit', code => { clearTimeout(timer); resolveExit(code); });
  });
  assert.equal(exit, 0);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return { count: windows.length, visible: windows[0].isVisible(), minimized: windows[0].isMinimized() };
  }), { count: 1, visible: true, minimized: false });
  const isolated = await electron.launch({ executablePath: require('electron'),
    args: [resolve('.'), '--desk-test', `--desk-data=${other}`], env });
  try {
    await (await isolated.firstWindow()).locator('.workspace-label').waitFor();
    assert.equal(await isolated.evaluate(({ app }) => app.getPath('userData')), other);
  } finally {
    await isolated.close();
  }
  assert.equal(await readFile(join(data, 'preferences.json'), 'utf8'), preferences);
  assert.equal(await readFile(join(data, 'plugins.json'), 'utf8'), '[]');
});

// Hold a real worker activation open to reproduce macOS activation during asynchronous startup.
test('startup: activation events wait for desktop protocol and IPC readiness', { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'deckpg-startup-activation-'));
  const directory = join(data, 'plugins/startup-probe');
  await mkdir(directory, { recursive: true });
  await writeFile(join(data, 'plugins.json'), '[]');
  await writeFile(join(directory, 'plugin.json'), JSON.stringify({ id: 'startup-probe', name: 'Startup probe',
    version: '1.0.0', apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: true,
    background: 'service', main: 'main.mjs' }));
  await writeFile(join(directory, 'main.mjs'), `import { access, writeFile } from 'node:fs/promises';
    export async function activate() {
      await writeFile(${JSON.stringify(join(data, 'activating'))}, 'ready');
      while (!await access(${JSON.stringify(join(data, 'release'))}).then(() => true, () => false)) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    export function deactivate() {}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.DESK_STARTUP_EXECUTABLE || require('electron');
  const app = await electron.launch({ executablePath,
    args: [...(process.env.DESK_STARTUP_EXECUTABLE ? [] : [resolve('.')]), '--desk-test', `--desk-data=${data}`], env });
  t.after(async () => {
    await writeFile(join(data, 'release'), 'continue');
    const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 3000);
    await app.evaluate(({ app }) => { setImmediate(() => app.exit(0)); }).catch(() => {});
    await app.close().catch(() => {});
    clearTimeout(watchdog);
    await rm(data, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!await access(join(data, 'activating')).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline, 'startup probe did not activate');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const count = await app.evaluate(({ app, BrowserWindow }) => {
    app.emit('activate');
    app.emit('second-instance');
    return BrowserWindow.getAllWindows().length;
  });
  assert.equal(count, 0, 'native activation must not create a window before the host is ready');
  await writeFile(join(data, 'release'), 'continue');
  const page = await app.firstWindow();
  await page.locator('.workspace-label').waitFor();
  assert.equal((await page.evaluate(() => workDesk.plugins.list())).find(plugin => plugin.id === 'startup-probe').running, true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
});
