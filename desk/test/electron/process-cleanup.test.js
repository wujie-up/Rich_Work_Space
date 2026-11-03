import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, configure, create, output, owner } from './helpers.js';

for (const action of ['close', 'forceClose', 'forceDisable']) {
  test(`${action} stops terminal descendants and leaves another plugin and saved history intact`, { timeout: 30000 }, async t => {
    const { app, page, data } = await launch(t);
    await configure(page, { child: true });
    const session = await create(page, '关闭进程清理验证');
    const snapshot = await output(page, session.id, /CHILD=\d+\r?\n/);
    const childPid = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
    const workerPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(session.pid)], { encoding: 'utf8' }).trim());
    const configPath = join(data, 'plugin-data', owner, 'config.json');
    const config = await readFile(configPath, 'utf8');
    t.after(() => {
      for (const pid of [workerPid, session.pid, childPid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') {
            throw error;
          }
        }
      }
    });
    if (action !== 'close') {
      process.kill(workerPid, 'SIGSTOP');
    }
    if (action === 'close') {
      const tab = page.getByRole('tab', { name: 'AI Agent 会话', exact: true });
      await tab.hover();
      await tab.getByRole('button', { name: '关闭窗口', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(process.kill(session.pid, 0), true);
      await tab.hover();
      await tab.getByRole('button', { name: '关闭窗口', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('dialog button[aria-label="关闭"]')?.title === '关闭');
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await tab.waitFor({ state: 'detached' });
    } else {
      await page.evaluate(({ owner, action }) => workDesk.plugins[action](owner), { owner, action });
    }
    const remaining = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).trim().split('\n')
      .map(line => line.trim().split(/\s+/)).filter(([pid, state]) => [workerPid, session.pid, childPid].includes(Number(pid))
        && !state.startsWith('Z'));
    assert.deepEqual(remaining, []);
    assert.equal(await readFile(configPath, 'utf8'), config);
    assert.equal((await page.evaluate(() => workDesk.plugins.list())).find(plugin => plugin.id === 'code-browser').running, true);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed()), false);
    if (action === 'forceDisable') {
      await page.evaluate(owner => workDesk.plugins.enable(owner), owner);
    }
    const archives = await page.evaluate(owner => workDesk.plugins.invoke(owner, 'sessions.list', []), owner);
    assert.ok(archives.archives.some(record => record.id === session.id));
    assert.match((await page.evaluate(({ owner, id }) => workDesk.plugins.invoke(owner, 'sessions.readArchive', [id]),
      { owner, id: session.id })).output, /READY 中文/);
  });
}
