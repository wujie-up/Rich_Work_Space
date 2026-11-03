// Run explicitly against the latest packaged desktop with disposable plugin data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, toggleTheme } from '../../../desk/test/electron/helpers.js';
import computer from '../src/main/os/mac/computer.js';

async function install(app, page, source) {
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(async () => {
    for (const plugin of await workDesk.plugins.list()) {
      if (plugin.state === 'disabled') { await workDesk.plugins.enable(plugin.id); }
    }
  });
}
const invoke = (page, id, method, ...args) => page.evaluate(({ id, method, args }) => workDesk.plugins.invoke(id, method, args),
  { id, method, args });

async function completed(page, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = await invoke(page, 'builtin-caller', 'get', id);
    if (['succeeded', 'failed', 'cancelled'].includes(task.state)) { return task; }
    await delay(100);
  }
  throw Error(`电脑工具调用未完成：${id}`);
}

test('packaged built-ins: owner settings, required authorization popup and native computer actions', { timeout: 120000 }, async t => {
  const { app, page, data, logs } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  t.after(() => writeFile('/tmp/deckpg-builtin-desktop.log', logs.join('')));
  page.on('pageerror', error => console.error('desktop page:', error.message));
  await install(app, page, resolve('plugin-dev/dist/mcp-services-0.4.21.plg'));
  await install(app, page, resolve('plugin-dev/dist/ai-agent-sessions-0.6.51.plg'));
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  const frame = page.frameLocator('iframe[title="MCP 服务"]');
  await frame.locator('#builtin-settings').click();
  await frame.locator('#builtin-config').waitFor();
  assert.equal(await frame.locator('[name="appSecret"]').getAttribute('type'), 'password');
  assert.equal(await frame.locator('[name="userAccessToken"]').getAttribute('type'), 'password');
  await frame.locator('[name="appId"]').fill('test-app');
  await frame.locator('[name="appSecret"]').fill('test-secret');
  await frame.locator('[name="computerEnabled"]').uncheck();
  await frame.locator('#save-builtin').click();
  try {
    await frame.locator('#builtin-status').getByText('已保存', { exact: true }).waitFor({ timeout: 5000 });
  } catch (error) {
    console.error('Builtin save status:', await frame.locator('#status').textContent());
    await page.screenshot({ path: '/tmp/deckpg-builtin-save.png' });
    throw error;
  }
  let config = await invoke(page, 'mcp-services', 'mcp.builtin.read');
  assert.equal(config.computerEnabled, false);
  assert.equal(config.appId, 'test-app');
  await mkdir('.test-results/builtin-tools', { recursive: true });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) { await toggleTheme(page); }
    await frame.locator('[aria-describedby="feishu-credentials"]').focus();
    await frame.locator('#feishu-credentials').waitFor({ state: 'visible' });
    await page.screenshot({ path: `.test-results/builtin-tools/settings-${theme}.png` });
    assert.equal(await frame.locator('#builtin-config').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  }
  config = { ...config, computerEnabled: true, appId: '', appSecret: '' };
  await invoke(page, 'mcp-services', 'mcp.builtin.save', config);
  const caller = join(data, 'builtin-caller');
  await mkdir(caller);
  await writeFile(join(caller, 'plugin.json'), JSON.stringify({ id: 'builtin-caller', name: 'Builtin caller',
    version: '1.0.0', apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: false,
    background: 'service', main: 'index.mjs' }));
  await writeFile(join(caller, 'index.mjs'), `export function activate(c) {
    c.methods.register('call',async({id,input})=> {
      const catalog = await c.capabilities.discover({id});
      return c.capabilities.invoke(catalog.providers[0].handle,input);
    });
    c.methods.register('get',id=>c.capabilities.getInvocation(id));
  } export function deactivate() {}`);
  await install(app, page, caller);
  const task = await invoke(page, 'builtin-caller', 'call', {
    id: 'mcp.feishu.document.read', input: { url: 'https://test.feishu.cn/docx/document' }
  });
  const cancel = page.getByRole('button', { name: '取消本次操作', exact: true });
  await cancel.waitFor();
  const dialog = page.getByRole('dialog').filter({ has: cancel });
  const box = await dialog.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2);
  assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2);
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true);
  await dialog.screenshot({ path: '.test-results/builtin-tools/authorization.png' });
  await cancel.click();
  assert.equal((await completed(page, task.invocationId)).state, 'failed');
  const shot = await invoke(page, 'builtin-caller', 'call', { id: 'mcp.computer.control', input: { action: 'screenshot' } });
  await page.getByRole('button', { name: '允许', exact: true }).click();
  const result = await completed(page, shot.invocationId);
  assert.equal(result.state, 'succeeded', JSON.stringify(result.error));
  assert.equal(result.result.content[1].type, 'image');

  // Native input stays inside a dedicated frontmost fixture; never type into an existing user window.
  await app.evaluate(async ({ BrowserWindow, app }) => {
    const fixture = new BrowserWindow({ x: 250, y: 180, width: 600, height: 500, alwaysOnTop: true, title: 'DeskPG native fixture' });
    await fixture.loadURL('data:text/html,' + encodeURIComponent('<textarea id="input" style="width:400px;height:90px"></textarea><button id="hit" onclick="this.textContent=\'clicked\'">click</button><div id="scroll" style="height:200px;overflow:auto"><div style="height:3000px">scroll</div></div>'));
    fixture.show(); fixture.focus(); app.focus({ steal: true });
  });
  const fixture = app.windows().find(window => window !== page && window.url().startsWith('data:text/html'));
  assert.ok(fixture);
  await fixture.waitForFunction(() => document.hasFocus());
  // AppKit may still animate a newly shown window after Electron reports its final bounds.
  await delay(500);
  const frontmost = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    "ObjC.import('AppKit'); JSON.stringify(Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier))"], { encoding: 'utf8' }));
  assert.equal(frontmost, app.process().pid);
  const scale = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    "ObjC.import('AppKit'); JSON.stringify(Math.min(1,1280/$.NSScreen.screens.objectAtIndex(0).frame.size.width))"], { encoding: 'utf8' }));
  const click = async selector => {
    const rect = await fixture.locator(selector).boundingBox();
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'DeskPG native fixture').getContentBounds());
    await computer.execute({ action: 'click', x: (bounds.x + rect.x + rect.width / 2) * scale,
      y: (bounds.y + rect.y + rect.height / 2) * scale });
  };
  await click('#input');
  await fixture.waitForFunction(() => document.activeElement.id === 'input');
  await computer.execute({ action: 'type', text: '中文 input 😀 ' + '连续输入'.repeat(15) });
  await fixture.waitForFunction(() => document.querySelector('#input').value === '中文 input 😀 ' + '连续输入'.repeat(15));
  await computer.execute({ action: 'key', key: 'CMD+A' });
  await fixture.waitForFunction(() => {
    const input = document.querySelector('#input');
    return input.selectionStart === 0 && input.selectionEnd === input.value.length;
  });
  await computer.execute({ action: 'type', text: '替换成功' });
  await fixture.waitForFunction(() => document.querySelector('#input').value === '替换成功');
  await click('#hit');
  await fixture.getByText('clicked', { exact: true }).waitFor();
  await click('#scroll');
  await computer.execute({ action: 'scroll', amount: -300 });
  await fixture.waitForFunction(() => document.querySelector('#scroll').scrollTop > 0);
});
