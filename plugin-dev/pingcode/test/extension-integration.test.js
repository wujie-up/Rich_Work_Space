import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ExtensionSession } from '../src/main/common/extension-session.js';
import { WebClient } from '../src/main/common/web-client.js';

async function until(condition, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) {
    if (Date.now() >= deadline) { throw Error('condition timed out'); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test('real MV3 extension pairs, reuses user tabs, survives idle and reconnects without owning Chrome', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-extension-live-'));
  const profile = join(root, 'chrome');
  const extensionPath = resolve('plugin-dev/pingcode/dist/pingcode-browser-extension');
  let bridge = new ExtensionSession({ root: join(root, 'bridge') });
  const site = 'https://fixture.pingcode.com';
  const pairing = await bridge.open(site);
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  let context = await launch();
  t.after(async () => { await context.close(); await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  await context.addCookies([{ name: 'fixture-login', value: 'owned-test-account', domain: 'fixture.pingcode.com', path: '/', secure: true,
    expires: Date.now() / 1000 + 3600 }]);
  let authenticatedReads = 0;
  const monthStart = new Date(2026, 9, 1).getTime() / 1000;
  const workItems = Array.from({ length: 8 }, (_, index) => ({ _id: String(index), assignee: 'one', project_id: 'p',
    created_at: monthStart + 10, completed_at: monthStart + 20, properties: {} }));
  let queryPosts = 0;
  const serveSite = async route => {
    if (route.request().url().includes('/api/')) {
      assert.match((await route.request().allHeaders()).cookie, /fixture-login=owned-test-account/);
      authenticatedReads++;
      const url = new URL(route.request().url());
      let data = { me: { uid: 'one' } };
      if (url.pathname === '/api/agile/work-items') {
        const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
        if (body) {
          queryPosts++;
          assert.equal(body.criteria.conditions[0].property_key, 'completed_at');
          assert.equal(body.criteria.conditions[0].value, monthStart);
        }
        const page = body ? body.pi : Number(url.searchParams.get('pi') || 0);
        data = { value: workItems.slice(page * 2, (page + 1) * 2), count: 8, page_index: page, page_size: 2 };
      } else if (url.pathname.startsWith('/api/agile/work-items/')) {
        data = { value: { ...workItems[Number(url.pathname.split('/').at(-1))], properties: { renwujiazhifen: 5 } } };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200, data }) });
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PingCode test</title><p>已有登录</p>' });
    }
  };
  await context.route(site + '/**', serveSite);
  const existing = await context.newPage();
  await existing.goto(site + '/pjm/workitems/example');
  const pair = await context.newPage();
  await pair.goto(pairing.pairingUrl);
  await pair.getByRole('button', { name: '确认连接此工作台', exact: true }).waitFor();
  await pair.getByRole('button', { name: '确认连接此工作台', exact: true }).evaluate(node => node.click());
  await pair.waitForTimeout(250);
  assert.equal(bridge.status().extensionConnected, false, 'scripted clicks cannot approve a connection');
  assert.equal(new URL(pair.url()).protocol, 'http:', 'scripted clicks cannot open the approval page');
  await pair.getByRole('button', { name: '确认连接此工作台', exact: true }).click();
  await pair.getByRole('button', { name: '允许工作台连接', exact: true }).click();
  await until(() => bridge.status().extensionConnected);
  await bridge.check();
  assert.equal(bridge.status().state, 'connected');
  assert.equal(context.pages().filter(page => page.url().startsWith(site)).length, 1, 'check must reuse existing tab');
  await pair.close();
  await bridge.read(site, '/api/agile/work-items');
  const client = new WebClient({ site, valueKey: 'renwujiazhifen' }, bridge);
  const parallelRows = await client.tasks({ assigneeId: 'one', projectId: 'p' });
  assert.deepEqual(parallelRows.map(row => row.id), workItems.map(row => row._id));
  assert.equal(parallelRows.reduce((sum, row) => sum + row.score, 0), 40);
  const monthlyRows = await client.tasks({ assigneeId: 'one', projectId: 'p', month: '2026-10' });
  assert.equal(monthlyRows.length, 8);
  assert.equal(queryPosts, 4, 'every monthly page must use filtered POST instead of full-history GET');
  await existing.close();
  await bridge.read(site, '/api/agile/work-items');
  assert.equal(context.pages().filter(page => page.url().startsWith(site)).length, 1, 'closed site tab is recreated');
  const tab = context.pages().find(page => page.url().startsWith(site));
  await bridge.stop();
  assert.equal(tab.isClosed(), false, 'plugin stop cannot close user tabs');
  bridge = new ExtensionSession({ root: join(root, 'bridge') });
  await bridge.start(site);
  await until(() => bridge.status().extensionConnected);
  await bridge.check();
  assert.equal(bridge.status().state, 'connected');
  await new Promise(resolve => setTimeout(resolve, 34000));
  assert.equal(bridge.status().extensionConnected, true);
  await bridge.read(site, '/api/agile/work-items');
  assert.ok(authenticatedReads >= 5);
  await context.close();
  await until(() => !bridge.status().extensionConnected);
  context = await launch();
  await context.route(site + '/**', serveSite);
  await until(() => bridge.status().extensionConnected);
  await bridge.check();
  assert.equal(bridge.status().state, 'connected', 'browser restart restores paired extension and retained login');
  const restoredTab = context.pages().find(page => page.url().startsWith(site));
  await bridge.disconnect();
  assert.equal(restoredTab.isClosed(), false);
  const worker = context.serviceWorkers()[0];
  await until(async () => !(await worker.evaluate(() => chrome.storage.local.get('pingcodePairing'))).pingcodePairing);
});
