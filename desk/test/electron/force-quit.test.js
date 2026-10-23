import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, configure, create, output, owner, alive } from './helpers.js';

for (const stalledCleanup of [false, true]) {
  test(`native force quit exits with frozen plugin/renderer and pending quit; stalled cleanup=${stalledCleanup}`, { timeout: 20000 }, async (t) => {
    const { app, page, data } = await launch(t, process.env.DESK_EXECUTABLE ? { executablePath: process.env.DESK_EXECUTABLE } : {});
    const hostPid = app.process().pid;
    await configure(page, { child: true });
    const session = await create(page, 'force quit retained data');
    const snapshot = await output(page, session.id, /CHILD=\d+\r?\n/);
    const child = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
    const configPath = join(data, 'plugin-data', owner, 'config.json');
    const config = await readFile(configPath, 'utf8');
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n')
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/));
    const workers = processes.filter(row => Number(row[2]) === hostPid && row[3].includes('plugin-worker.js'))
      .map(row => Number(row[1]));
    assert.ok(workers.length > 0);
    const renderer = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
    for (const pid of [...workers, renderer]) {
      process.kill(pid, 'SIGSTOP');
    }
    t.after(() => {
      for (const pid of [...workers, renderer, session.pid, child]) {
        if (alive(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
    });
    await app.evaluate(({ app }) => app.quit());
    if (stalledCleanup) {
      await app.evaluate(async ({ app }) => {
        const vm = process.getBuiltinModule('node:vm');
        const { pathToFileURL } = process.getBuiltinModule('node:url');
        const url = pathToFileURL(`${app.getAppPath()}/desk/src/main/common/plugin-runtime.js`).href;
        const { PluginRuntime } = await vm.runInThisContext(`import(${JSON.stringify(url)})`,
          { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
        const close = PluginRuntime.prototype.close;
        PluginRuntime.prototype.close = function () {
          close.call(this);
          return new Promise(() => {});
        };
      });
    }
    await app.evaluate(({ dialog, Menu }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
      Menu.getApplicationMenu().getMenuItemById('force-quit').click();
    });
    await delay(100);
    assert.equal(alive(hostPid), true);
    const closed = app.waitForEvent('close', { timeout: 5000 });
    await app.evaluate(({ dialog, Menu }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
      Menu.getApplicationMenu().getMenuItemById('force-quit').click();
    });
    await closed;
    const pids = [hostPid, ...workers, renderer, session.pid, child];
    const deadline = Date.now() + 2000;
    while (pids.some(alive) && Date.now() < deadline) {
      await delay(25);
    }
    for (const pid of pids) {
      assert.equal(alive(pid), false, `process ${pid} must be gone`);
    }
    assert.equal(await readFile(configPath, 'utf8'), config);
  });
}
