import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, configure, create, output, owner, alive, openWorkspace, openConfiguration } from './helpers.js';

test('host: sandbox, unsubscribe, close/reopen and quit cancellation retain PTY', { timeout: 120000 }, async (t) => {
  const { app, page } = await launch(t);
  assert.deepEqual(await page.evaluate(() => [typeof require, typeof process, Object.keys(workDesk).sort()]),
    ['undefined', 'undefined', ['events', 'host', 'plugins', 'storage']]);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return [p.sandbox, p.contextIsolation, p.nodeIntegration];
  }), [true, true, false]);
  await configure(page);
  const session = await create(page);
  await output(page, session.id, 'READY 中文');
  assert.equal(await page.evaluate(async () => {
    let calls = 0;
    const off = workDesk.events.pluginEvent(() => calls++);
    off();
    await new Promise((r) => setTimeout(r, 700));
    return calls;
  }), 0);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.evaluate(() => workDesk.host.quit());
  await page.waitForTimeout(300);
  assert.equal(alive(session.pid), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(alive(session.pid), true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await app.evaluate(({ app }) => app.emit('activate'));
  const reopened = page;
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await reopened.frameLocator('iframe').locator('.workspace-tools').waitFor();
  const list = await reopened.evaluate((id) => agentDesk.sessions.list(id), owner);
  assert.equal(list.sessions[0].pid, session.pid);
  await reopened.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: session.id });
  assert.equal(alive(session.pid), false);
});

test('PTY: native input, resize, unicode output and descendant process group termination', { timeout: 120000 }, async (t) => {
  const { page, data } = await launch(t);
  assert.match(data, /中文 /);
  await configure(page, { child: true });
  const session = await create(page);
  const snapshot = await output(page, session.id, /CHILD=\d+\r?\n/);
  assert.match(snapshot.data, /CHILD=\d+/, JSON.stringify(snapshot.data));
  const child = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
  assert.equal(alive(child), true);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, '你好 PTY'), { owner, id: session.id });
  await output(page, session.id, '你好 PTY');
  // UI fitting also sends resize; set the observed size after the first layout settles.
  await page.waitForTimeout(500);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.resize(owner, id, 101, 31), { owner, id: session.id });
  await output(page, session.id, 'SIZE=101x31');
  await page.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: session.id });
  assert.equal(alive(session.pid), false);
  assert.equal(alive(child), false);
  const archive = await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id });
  assert.match(archive.output, /READY 中文/);
});

test('host: confirmed quit archives the session before exiting and stops its descendants', { timeout: 120000 }, async (t) => {
  const { app, page, data } = await launch(t);
  await configure(page, { child: true });
  const session = await create(page);
  const snapshot = await output(page, session.id, /CHILD=\d+\r?\n/);
  const child = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  const closed = app.waitForEvent('close');
  await page.evaluate(() => workDesk.host.quit());
  await closed;
  assert.equal(alive(session.pid), false);
  assert.equal(alive(child), false);
  const record = JSON.parse(await readFile(join(data, 'plugin-data', owner, 'sessions', `${session.id}.json`), 'utf8'));
  assert.equal(record.lifecycle, 'archived');
  assert.equal(record.reason, 'quit');
  assert.match(record.output, /READY 中文/);
});

test('host: a delayed plugin configuration cannot overwrite the newer theme tab', { timeout: 120000 }, async (t) => {
  const { app, page } = await launch(t);
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('work-desk:invoke');
    ipcMain._invokeHandlers.set('work-desk:invoke', async (event, method, args) => {
      if (method === 'plugins.list') {
        await new Promise((r) => setTimeout(r, 250));
      }
      return original(event, method, args);
    });
  });
  await openConfiguration(page);
  await page.locator('#theme-settings').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#settings-panel h1').innerText(), '主题');
  assert.match(await page.locator('#theme-settings').getAttribute('class'), /selected/);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 1);
});

test('PTY: historical terminal queries do not send input to the live CLI on reload', { timeout: 120000 }, async (t) => {
  const { page } = await launch(t);
  await configure(page);
  const session = await create(page);
  await output(page, session.id, 'READY 中文');
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'query-now'), { owner, id: session.id });
  const before = await output(page, session.id, /INPUT="\\u001b\[/);
  const replies = (text) => (text.match(/INPUT="\\u001b\[/g) || []).length;
  assert.ok(replies(before.data) > 0);
  await page.reload();
  await openWorkspace(page);
  await page.frameLocator('iframe').locator('.session .xterm').waitFor();
  await page.waitForTimeout(400);
  const after = await page.evaluate(({ owner, id }) => agentDesk.sessions.attach(owner, id), { owner, id: session.id });
  assert.equal(replies(after.data), replies(before.data));
});
