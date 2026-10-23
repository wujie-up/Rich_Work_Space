import test from 'node:test';
import assert from 'node:assert/strict';
import { access, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listPackage } from '@electron/asar';
import { launch, configure, create, output, owner, alive, openConfiguration } from './helpers.js';

test('package: independent app resources, Finder PATH, native PTY, archive and cleanup', { timeout: 120000 }, async (t) => {
  const bundle = resolve('desk/dist/releases/mac-arm64/Work Desk.app');
  const executablePath = `${bundle}/Contents/MacOS/Work Desk`;
  await access(executablePath);
  const {version} = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  for (const ext of ['dmg', 'zip']) {
    assert.ok((await stat(resolve(`desk/dist/releases/Work Desk-${version}-arm64.${ext}`))).size > 1000000);
  }
  const entries = listPackage(`${bundle}/Contents/Resources/app.asar`);
  assert.ok(entries.includes('/plugins/plugins/ai-agent/plugin.json'));
  assert.ok(entries.includes('/desk/dist/renderer/app.js'));
  assert.ok(entries.includes('/desk/dist/renderer/app.css'));
  assert.ok(!entries.some((path) => path.includes('codex-terminals')));
  await access(`${bundle}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node`);
  await access(`${bundle}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`);
  const { page } = await launch(t, { executablePath, reducedPath: true });
  assert.equal((await page.evaluate(() => workDesk.host.info())).packaged, true);
  await configure(page, { child: true });
  const session = await create(page, '安装包真实 PTY');
  const snapshot = await output(page, session.id, /CHILD=\d+\r?\n/);
  const child = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'packaged-input'), { owner, id: session.id });
  await output(page, session.id, 'packaged-input');
  await page.evaluate(async (owner) => {
    let preview = await workDesk.plugins.preview(owner, 'remove');
    await workDesk.plugins.remove(owner, 'clear', preview.confirmationToken);
  }, owner);
  assert.equal(alive(session.pid), false);
  assert.equal(alive(child), false);
  const record = (await page.evaluate(() => workDesk.plugins.list())).find((plugin) => plugin.id === owner);
  assert.equal(record.state, 'uninstalled');
  assert.equal(record.cleanupPending, false);
  await openConfiguration(page);
  assert.equal(await page.locator(`.plugin-card[data-plugin="${owner}"]`).count(), 0);
});

test('package: force close reaps owned PTY processes, keeps configuration and follows native system appearance', { timeout: 60000 }, async (t) => {
  const executablePath = resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk');
  const { app, page, data } = await launch(t, { executablePath });
  // Playwright defaults to emulated light appearance; let Chromium observe nativeTheme in this regression.
  await page.emulateMedia({ colorScheme: null });
  assert.equal((await page.evaluate(() => workDesk.storage.getPreferences())).theme, 'system');
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.frameLocator('iframe').locator('html[data-theme="light"]').waitFor();
  await configure(page, { child: true });
  const configPath = resolve(data, 'plugin-data', owner, 'config.json');
  const config = await readFile(configPath, 'utf8');
  const session = await create(page, '强制关闭的真实 PTY');
  const snapshot = await output(page, session.id, /CHILD=\d+\r?\n/);
  const child = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('button', { name: '强制关闭', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.application-window').length === 0);
  assert.equal(alive(session.pid), false);
  assert.equal(alive(child), false);
  assert.equal(await readFile(configPath, 'utf8'), config);
  assert.equal((await page.evaluate(() => workDesk.plugins.list())).find(record => record.id === owner).state, 'disabled');
  await page.evaluate(owner => workDesk.plugins.enable(owner), owner);
  assert.deepEqual(await page.evaluate(owner => agentDesk.storage.getAdapterConfig(owner), owner), JSON.parse(config));
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
});
