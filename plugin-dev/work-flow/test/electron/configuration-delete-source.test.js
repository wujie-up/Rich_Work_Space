import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const base = '/plugin-dev/work-flow/src/renderer/';
const source = await readFile(resolve(`.${base}app.js`), 'utf8');
const credentialsSource = source.slice(source.indexOf('function renderCredentials()'), source.indexOf('function renderCanvas()'));

test('configuration deletion: shared side popup preserves canceled accounts, connections and resource drafts', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://configuration.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<link rel="stylesheet" href="/desk/src/resource/controls.css">
        <link rel="stylesheet" href="${base}style.css"><button id="outside">Outside</button>
        <div id="credentials"></div><div id="messages"></div><div id="menu"></div>` });
    }
    if (path === '/desk/src/resource/page-lifecycle.js') {
      return route.fulfill({ contentType: 'text/javascript', body: `export const pageLifecycle = () => ({ visible: () => true, subscribe() {} });` });
    }
    if (path === `${base}api.js`) {
      return route.fulfill({ contentType: 'text/javascript', body: `export const invoke = (...args) => window.fixtureInvoke(...args);
        export const chooseDirectory = async () => null; export const chooseDesktopFile = async () => null;
        export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));` });
    }
    return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(resolve(`.${path}`)) });
  });
  await page.goto('http://configuration.test/');
  await page.evaluate(async ({ base, credentialsSource }) => {
    const { confirmConfigurationDelete } = await import(`${base}configuration-delete.js`);
    const { escape } = await import(`${base}api.js`);
    window.calls = [];
    window.accounts = [{ id: 'account', name: '<邮件账号>', username: 'fixture', host: 'localhost', port: 993, security: 'tls' }];
    window.connections = [{ id: 'connection', name: '<消息连接>', channel: 'feishu' }];
    window.session = { revision: 1, catalog: [], drafts: [{ key: 'd:new', kind: 'MENU', name: '<新增资源>', code: 'new' }] };
    window.fixtureInvoke = async (method, ...args) => {
      window.calls.push([method, ...args]);
      if (method === 'credentials.remove') { window.accounts = []; }
      if (method === 'credentials.list') { return window.accounts; }
      if (method === 'messages.connections.remove') { window.connections = []; }
      if (method === 'messages.connections.list') { return window.connections; }
      if (method === 'menu.read') { return window.session; }
      if (method === 'menu.edit') { window.session.drafts = args[0].drafts; return window.session; }
      return [];
    };
    const state = { credentials: window.accounts };
    const renderCredentials = new Function('state', 'invoke', 'confirmConfigurationDelete', 'escape', 'act', 'renderProperties',
      `${credentialsSource}; return renderCredentials;`)(state, window.fixtureInvoke, confirmConfigurationDelete, escape,
        work => work(), () => {});
    renderCredentials();
    const { createMessagePanel } = await import(`${base}message-panel.js`);
    await createMessagePanel(document.querySelector('#messages'), { invoke: window.fixtureInvoke,
      subscribe: () => () => () => {}, onConnectionsChanged() {}, setStatus() {} }).load();
    const { createMenuPanel } = await import(`${base}menu-panel.js`);
    await createMenuPanel(document.querySelector('#menu'), () => {}, () => {}).show({ id: 'run', status: 'waiting',
      pending: { kind: 'manual', stage: 'tree' } }, true);
  }, { base, credentialsSource });
  await page.locator('[data-tree="d:new"]').click();
  for (const [selector, title, method] of [
    ['[data-remove-credential]', '删除邮件账号', 'credentials.remove'],
    ['[data-message-remove]', '删除消息连接', 'messages.connections.remove'],
    ['[data-action="remove-draft"]', '移除新增资源', 'menu.edit']
  ]) {
    const trigger = page.locator(selector);
    const popup = page.getByRole('dialog', { name: title, exact: true });
    for (const cancel of ['取消', 'Escape', 'outside']) {
      await trigger.click();
      await popup.waitFor();
      assert.equal(await popup.locator('p').evaluate(node => node.children.length), 0);
      assert.equal(await popup.getByRole('button', { name: '取消', exact: true }).evaluate(node => node === document.activeElement), true);
      if (cancel === 'Escape') { await page.keyboard.press('Escape'); }
      else if (cancel === 'outside') { await page.locator('#outside').click(); }
      else { await popup.getByRole('button', { name: '取消', exact: true }).click(); }
      await popup.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(method => window.calls.filter(call => call[0] === method).length, method), 0);
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    }
    await trigger.click();
    await popup.getByRole('button', { name: '确认删除', exact: true }).click();
    await popup.waitFor({ state: 'detached' });
    await page.waitForFunction(method => window.calls.some(call => call[0] === method), method);
    assert.equal(await page.evaluate(method => window.calls.filter(call => call[0] === method).length, method), 1);
  }
  // Exercise the same shared control in both themes and a narrow window without a plugin build.
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(async ({ base, theme }) => {
      document.documentElement.dataset.theme = theme;
      const { confirmConfigurationDelete } = await import(`${base}configuration-delete.js`);
      window.result = confirmConfigurationDelete('删除配置', '完整说明'.repeat(100), document.querySelector('#outside'));
    }, { base, theme });
    const popup = page.getByRole('dialog', { name: '删除配置', exact: true });
    await popup.waitFor();
    const bounds = await popup.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.result), false);
  }
});
