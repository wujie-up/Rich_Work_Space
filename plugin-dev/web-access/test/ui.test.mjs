import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, request } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, readFile, cp, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const helper = 'dist/assistant/Work Desk Assistant.app/Contents/MacOS/DeskLinkMac';

async function helperPid(marker) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await readFile(marker, 'utf8').catch(error => {
      if (error.code === 'ENOENT') { return ''; }
      throw error;
    });
    if (value) { return Number(value.trim()); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('内置助手未从插件按钮启动');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') { return false; }
    throw error;
  }
}

test('native controls use shared themes in window/configuration; Web cannot manage access', { timeout: 60000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'wd-access-ui-'));
  await mkdir(join(data, 'plugins'), { recursive: true });
  await cp('desk/dist/plugins/web-access', join(data, 'plugins/web-access'), { recursive: true });
  // Replace only the isolated test installation so UI/lifecycle checks never read the user's Keychain.
  const marker = join(data, 'assistant.pid');
  const executable = join(data, 'plugins/web-access', helper);
  await writeFile(executable, `#!/bin/sh\necho $$ > '${marker.replaceAll("'", "'\\''")}'\nexec /bin/sleep 60\n`);
  await chmod(executable, 0o755);
  const integrityPath = join(data, 'plugins/web-access/integrity.json');
  const integrity = JSON.parse(await readFile(integrityPath, 'utf8'));
  integrity.files[helper] = createHash('sha256').update(await readFile(executable)).digest('hex');
  await writeFile(integrityPath, JSON.stringify(integrity));
  const manifest = JSON.parse(await readFile('desk/dist/plugins/web-access/plugin.json', 'utf8'));
  const peer = { id: 'assistant-test-peer', name: '隔离验证', version: '1.0.0', apiVersion: 2, dataVersion: 1,
    type: 'service', showIcon: false, singleInstance: true, loadOnStartup: true, background: 'service', main: 'main.js' };
  await mkdir(join(data, 'plugins', peer.id));
  await writeFile(join(data, 'plugins', peer.id, 'plugin.json'), JSON.stringify(peer));
  await writeFile(join(data, 'plugins', peer.id, 'package.json'), '{"type":"module"}');
  await writeFile(join(data, 'plugins', peer.id, 'main.js'),
    'export function activate(context) { context.methods.register("ping", () => "pong"); }\nexport async function deactivate() {}\n');
  await mkdir(join(data, 'plugin-data/web-access'), { recursive: true });
  const retained = join(data, 'plugin-data/web-access/retained.json');
  await writeFile(retained, '{"fixture":"retained"}');
  await writeFile(join(data, 'plugins.json'), JSON.stringify([{ ...manifest, state: 'enabled' }, { ...peer, state: 'enabled' }]));
  await writeFile(join(data, 'preferences.json'), JSON.stringify({ theme: 'dark', language: 'zh-CN', gridSize: 24 }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [resolve('.'), '--desk-test', `--desk-data=${data}`], env });
  const logs = [];
  app.process().stdout.on('data', chunk => logs.push(chunk.toString()));
  app.process().stderr.on('data', chunk => logs.push(chunk.toString()));
  t.after(async () => {
    await writeFile('/tmp/wd-access-assistant-ui-host.log', logs.join(''));
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(data, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await page.locator('.shelf-app[data-plugin="web-access"]').click();
  const frame = page.frameLocator('iframe').first();
  await frame.locator('#status').filter({ hasText: '远程访问已关闭' }).waitFor();
  assert.equal(await frame.locator('#invite').isDisabled(), true);
  assert.equal(await frame.locator('#error').textContent(), '');
  assert.equal(await frame.locator('#assistant').isEnabled(), true);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir('.test-results/web-access', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await frame.locator('html').evaluate((html, value) => { html.dataset.theme = value; }, theme);
    for (const selector of ['#toggle', '#assistant']) {
      await frame.locator(selector).focus();
      assert.equal(await frame.locator(selector).evaluate(button => document.activeElement === button), true);
      assert.equal(await frame.locator(selector).getAttribute('title'), await frame.locator(selector).getAttribute('aria-label'));
      assert.equal(await frame.locator(`${selector} svg[aria-hidden="true"]`).count(), 1);
    }
    assert.notEqual(await frame.locator('body').evaluate(body => getComputedStyle(body).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: `.test-results/web-access/${theme}.png` });
  }
  await page.setViewportSize({ width: 460, height: 640 });
  assert.equal(await frame.locator('html').evaluate(html => html.scrollWidth <= html.clientWidth), true);
  await page.screenshot({ path: '.test-results/web-access/narrow.png' });
  await frame.locator('#assistant').click();
  const firstPid = await helperPid(marker);
  assert.equal(alive(firstPid), true);
  await frame.locator('#assistant:disabled').waitFor();
  assert.equal(await frame.locator('#status').textContent(), '远程访问已关闭');
  process.kill(firstPid, 'SIGTERM');
  await frame.locator('#assistant:enabled').waitFor();
  // Call the actual host IPC, never set a forged trusted flag in an RPC argument.
  await page.evaluate(() => workDesk.web.saveAccount('tester', 'testing-password'));
  await page.evaluate(() => workDesk.web.configure({ enabled: true, port: 0 }));
  const status = await page.evaluate(() => workDesk.web.status());
  const http = await request.newContext({ ignoreHTTPSErrors: true, baseURL: `https://localhost:${status.port}` });
  t.after(() => http.dispose());
  const login = await http.post('/api/login', { headers: { origin: `https://localhost:${status.port}` }, data: { username: 'tester', password: 'testing-password' } });
  const { csrf } = await login.json();
  for (const method of ['pairing.create', 'assistant.open']) {
    const denied = await http.post('/api/rpc', { headers: { origin: `https://localhost:${status.port}`, 'x-deckpg-csrf': csrf },
      data: { method: 'plugins.invoke', args: ['web-access', method, [{ origin: 'native', executable: '/bin/sh' }]] } });
    assert.match((await denied.json()).error.message, /本机|原生/);
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '插件', exact: true }).click();
  await page.locator('.plugin-card[data-plugin="web-access"]').getByRole('button', { name: '插件配置', exact: true }).click();
  const dialog = page.locator('dialog.plugin-settings');
  const settings = dialog.frameLocator('iframe');
  await settings.locator('#status').filter({ hasText: '远程访问已关闭' }).waitFor();
  assert.equal(await settings.locator('#invite').isDisabled(), true);
  assert.equal(await settings.locator('#error').textContent(), '');
  assert.equal(await settings.locator('#assistant').isEnabled(), true);
  await dialog.screenshot({ path: '.test-results/web-access/configuration.png' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await rm(marker);
  await frame.locator('#assistant').click();
  const secondPid = await helperPid(marker);
  const workerPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(secondPid)], { encoding: 'utf8' }).trim());
  process.kill(workerPid, 'SIGKILL');
  for (let attempt = 0; alive(secondPid) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(alive(secondPid), false, 'host must reap the bundled helper when its plugin worker crashes');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed()), false);
  assert.equal(await page.evaluate(() => workDesk.plugins.invoke('assistant-test-peer', 'ping', [])), 'pong');
  assert.equal(await readFile(retained, 'utf8'), '{"fixture":"retained"}');
  // waitForFunction treats an async predicate's Promise as truthy; poll awaited IPC from Node instead.
  let recovered = false;
  for (let attempt = 0; attempt < 100 && !recovered; attempt++) {
    const plugin = (await page.evaluate(() => workDesk.plugins.list())).find(plugin => plugin.id === 'web-access');
    if (plugin.state === 'disabled' && !plugin.operation) {
      try {
        await page.evaluate(() => workDesk.plugins.enable('web-access'));
        recovered = true;
      } catch (error) {
        if (!/插件正在执行操作/.test(error.message)) { throw error; }
      }
    }
    if (!recovered) { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(recovered, true, 'plugin must finish crash recovery and allow re-enabling');
  await page.locator('.shelf-app[data-plugin="web-access"]').click();
  await frame.locator('#status').filter({ hasText: '远程访问已关闭' }).waitFor();
  await frame.locator('#assistant:enabled svg').waitFor();
  await rm(marker);
  await frame.locator('#assistant').click();
  const thirdPid = await helperPid(marker);
  await page.evaluate(() => workDesk.plugins.forceDisable('web-access'));
  assert.equal(alive(thirdPid), false, 'disabling the plugin must stop its helper');
  assert.deepEqual(errors, []);
});
