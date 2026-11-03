import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, chromium, webkit } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, readFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

test('native settings gate two authenticated browser clients and preserve shared plugin data on local close', { timeout: 90000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'deckpg-web-browser-'));
  await mkdir(join(data, 'plugins'), { recursive: true });
  await cp('desk/dist/plugins/text-editor', join(data, 'plugins/text-editor'), { recursive: true });
  const manifest = JSON.parse(await readFile('desk/dist/plugins/text-editor/plugin.json', 'utf8'));
  await writeFile(join(data, 'plugins.json'), JSON.stringify([{ ...manifest, state: 'enabled' }]));
  const preferences = { theme: 'dark', themePreferenceVersion: 1, language: 'zh-CN', gridSize: 24 };
  await writeFile(join(data, 'preferences.json'), JSON.stringify(preferences));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let browser;
  let mobileBrowser;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [resolve('.'), '--desk-test', `--desk-data=${data}`], env });
    const desktop = await app.firstWindow();
    await desktop.locator('.workspace-label').waitFor();
    assert.equal((await desktop.evaluate(() => workDesk.web.status())).enabled, false);
    await desktop.getByRole('button', { name: '用户菜单', exact: true }).click();
    await desktop.getByRole('menuitem', { name: '设置', exact: true }).click();
    await desktop.getByRole('button', { name: '桌面', exact: true }).click();
    await desktop.getByRole('button', { name: '网页访问设置', exact: true }).click();
    await desktop.getByLabel('网页账号', { exact: true }).fill('tester');
    await desktop.getByLabel('网页密码', { exact: true }).fill('testing-password');
    await desktop.getByRole('button', { name: '保存网页账号', exact: true }).click();
    await desktop.locator('.web-account-settings').getByText('tester', { exact: true }).waitFor();
    const panel = await desktop.locator('.web-account-settings').boundingBox();
    assert.ok(panel.width > 0);
    await desktop.keyboard.press('Escape');
    await desktop.getByRole('button', { name: '关闭配置', exact: true }).click();
    const status = await desktop.evaluate(() => workDesk.web.configure({ enabled: true, port: 0 }));
    const origin = `https://localhost:${status.port}`;
    browser = await chromium.launch({ headless: true });
    const first = await browser.newContext({ ignoreHTTPSErrors: true });
    const second = await browser.newContext({ ignoreHTTPSErrors: true });
    const one = await first.newPage();
    const errors = [];
    one.on('pageerror', error => errors.push(error.message));
    const login = async page => {
      await page.goto(origin);
      await page.getByLabel('账号', { exact: true }).fill('tester');
      await page.getByLabel('密码', { exact: true }).fill('testing-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.locator('.workspace-label').waitFor({ state: 'attached' });
    };
    const delayStartup = async (page, { autoStart = false } = {}) => {
      let release;
      let entered;
      let delivered;
      let delayed = false;
      const gate = new Promise(resolve => { release = resolve; });
      const request = new Promise(resolve => { entered = resolve; });
      const completed = new Promise(resolve => { delivered = resolve; });
      // Delay delivery of an authorized initialization response, including across access revocation.
      const route = async route => {
        if (!delayed && route.request().postDataJSON().method === 'storage.getPreferences') {
          delayed = true;
          const response = await route.fetch();
          entered();
          await gate;
          await route.fulfill({ response });
          delivered();
          return;
        }
        if (autoStart && route.request().postDataJSON().method === 'plugins.list') {
          const response = await route.fetch();
          const body = await response.json();
          body.value = body.value.map(plugin => ({ ...plugin, autoStart: plugin.id === 'text-editor' }));
          await route.fulfill({ response, json: body });
          return;
        }
        await route.continue();
      };
      await page.route('**/api/rpc', route);
      return { request, release, remove: async () => { await completed; await page.unroute('**/api/rpc', route); } };
    };
    await login(one);
    const two = await second.newPage();
    await login(two);
    assert.equal(await one.evaluate(() => workDesk.host.browser), true);
    assert.equal(await one.evaluate(() => Boolean(workDesk.web)), false);
    const csrf = await one.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
    const uploaded = await first.request.post(`${origin}/api/upload?name=browser-check.txt&purpose=desktop`, {
      headers: { origin, 'x-deckpg-csrf': csrf }, data: Buffer.from('shared browser file')
    });
    assert.equal(uploaded.status(), 200);
    const downloaded = await first.request.get(`${origin}/api/download?name=browser-check.txt`);
    assert.equal((await downloaded.body()).toString(), 'shared browser file');
    assert.equal((await second.request.get(`${origin}/api/download?name=../preferences.json`)).status(), 400);
    await two.reload();
    await two.getByText('browser-check.txt', { exact: true }).waitFor();
    await one.reload();
    await one.getByText('browser-check.txt', { exact: true }).dblclick();
    await one.locator('iframe').waitFor();
    const frame = one.frames().find(frame => frame !== one.mainFrame());
    await frame.locator('textarea').first().waitFor();
    assert.match(frame.url(), /https:\/\/localhost:\d+\/__assets\/[a-f0-9]{64}\/dist\/renderer/);
    assert.notEqual(new URL(frame.url()).port, String(status.port));
    await one.getByRole('button', { name: '关闭窗口', exact: true }).first().click();
    assert.equal(await one.locator('iframe').count(), 0);
    assert.equal((await desktop.evaluate(() => workDesk.plugins.list())).find(record => record.id === 'text-editor').running, true);
    mobileBrowser = await webkit.launch({ headless: true });
    const mobilePages = [];
    for (const engine of [mobileBrowser, browser]) {
      const mobileContext = await engine.newContext({ ignoreHTTPSErrors: true, viewport: { width: 393, height: 852 },
        isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      const phone = await mobileContext.newPage();
      mobilePages.push(phone);
      phone.setDefaultTimeout(8000);
      phone.on('pageerror', error => errors.push(error.message));
      await phone.goto(origin);
      await phone.setViewportSize({ width: 393, height: 320 });
      await phone.getByLabel('密码', { exact: true }).fill('keyboard-probe');
      await phone.getByRole('button', { name: '登录', exact: true }).scrollIntoViewIfNeeded();
      const loginControl = await phone.getByRole('button', { name: '登录', exact: true }).boundingBox();
      assert.ok(loginControl.height >= 44 && loginControl.width >= 44);
      await phone.screenshot({ path: `/tmp/work-desk-mobile-login-${engine.browserType().name()}-20261031.png` });
      await phone.setViewportSize({ width: 393, height: 852 });
      const startup = await delayStartup(phone, { autoStart: true });
      try {
        await login(phone);
        await startup.request;
        await phone.getByRole('status').filter({ hasText: '正在载入工作台' }).waitFor();
        assert.equal(await phone.locator('.app').isVisible(), false);
        await phone.screenshot({ path: `/tmp/work-desk-mobile-startup-${engine.browserType().name()}-20261031.png` });
      } finally {
        startup.release();
      }
      await phone.locator('.web-mobile-bar').waitFor({ timeout: 5000 });
      await startup.remove();
      assert.equal(await phone.locator('.web-opening').count(), 0);
      assert.equal(await phone.locator('.app').isVisible(), true);
      assert.equal(await phone.locator('.desktop-surface').isVisible(), true, 'mobile login must land on home despite auto-start');
      assert.equal(await phone.locator('.application-window[data-phase=open]').count(), 0, 'auto-started frames must not cover mobile home');
      assert.equal(await phone.locator('iframe.plugin-view').count(), 1, 'auto-started plugin frame remains available');
      await phone.evaluate(() => {
        const shelf = document.querySelector('.plugin-shelf');
        for (let index = 0; index < 30; index++) {
          const clone = shelf.firstElementChild.cloneNode(true);
          clone.dataset.layoutProbe = 'true';
          clone.querySelector('.shelf-name').textContent = `长名称手机布局夹具 ${index}`;
          shelf.append(clone);
        }
      });
      const lastLauncher = phone.locator('[data-layout-probe]').last();
      await lastLauncher.scrollIntoViewIfNeeded();
      assert.equal(await lastLauncher.isVisible(), true);
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await phone.evaluate(() => { document.querySelectorAll('[data-layout-probe]').forEach(node => node.remove()); });
      await phone.screenshot({ path: `/tmp/work-desk-mobile-home-${engine.browserType().name()}-20261031.png` });
      for (const control of await phone.locator('.web-mobile-bar button').all()) {
        const bounds = await control.boundingBox();
        assert.ok(bounds.width >= 44 && bounds.height >= 44);
      }
      await phone.locator('.shelf-app[data-plugin=text-editor]').tap();
      await phone.locator('.application-window.focused iframe').waitFor();
      const phoneFrame = phone.frames().find(frame => frame !== phone.mainFrame());
      await phoneFrame.locator('textarea').first().waitFor({ state: 'attached' });
      const windowId = await phone.locator('.application-window').getAttribute('data-window');
      await phoneFrame.evaluate(() => { window.mobileRetainedProbe = 'retained'; });
      await phone.locator('.web-mobile-bar #desktop').tap();
      await phone.locator('.shelf-app[data-plugin=text-editor]').tap();
      assert.equal(await phoneFrame.evaluate(() => window.mobileRetainedProbe), 'retained');
      assert.equal(await phone.locator('.application-window').getAttribute('data-window'), windowId);
      await phone.getByRole('button', { name: '切换窗口', exact: true }).tap();
      await phone.getByRole('button', { name: '切换窗口', exact: true }).tap();
      assert.equal(await phone.locator('.window-tabs').isVisible(), false);
      await phone.getByRole('button', { name: '切换窗口', exact: true }).tap();
      await phone.getByRole('button', { name: '最小化窗口', exact: true }).tap();
      await phone.locator('.window-tab').tap();
      await phone.locator('.application-window.focused').waitFor();
      assert.equal(await phone.locator('.window-tabs').isVisible(), false);
      assert.equal(await phoneFrame.evaluate(() => window.mobileRetainedProbe), 'retained');
      const visibleBounds = async locator => {
        const bounds = await locator.boundingBox();
        const viewport = phone.viewportSize();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1
          && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify(bounds));
      };
      await phone.getByRole('button', { name: '用户菜单', exact: true }).tap();
      await visibleBounds(phone.locator('#account-menu'));
      await phone.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await phone.screenshot({ path: `/tmp/work-desk-mobile-dark-${engine.browserType().name()}-20261031.png` });
      await phone.getByRole('menuitem', { name: '语言', exact: true }).tap();
      await visibleBounds(phone.locator('#language-menu'));
      await phone.getByRole('menuitem', { name: '语言', exact: true }).tap();
      assert.equal(await phone.locator('#language-menu').isVisible(), false);
      await phone.getByRole('menuitem', { name: '语言', exact: true }).tap();
      await phone.keyboard.press('Escape');
      assert.equal(await phone.locator('#language-menu').isVisible(), false);
      assert.equal(await phone.locator('#account-menu').isVisible(), true);
      await phone.keyboard.press('Escape');
      await phone.getByRole('button', { name: '用户菜单', exact: true }).tap();
      await phone.getByRole('menuitem', { name: '语言', exact: true }).tap();
      await phone.getByRole('menuitemradio', { name: '简体中文', exact: true }).tap();
      await phone.locator('#account-menu').waitFor({ state: 'hidden' });
      await phone.locator('#language-menu').waitFor({ state: 'hidden' });
      await phone.getByRole('button', { name: '用户菜单', exact: true }).tap();
      await phone.getByRole('button', { name: '用户菜单', exact: true }).tap();
      assert.equal(await phone.locator('#account-menu').isVisible(), false);
      await phone.getByRole('button', { name: '用户菜单', exact: true }).tap();
      await phone.getByRole('menuitem', { name: '设置', exact: true }).tap();
      await visibleBounds(phone.locator('#settings-panel'));
      await phone.getByRole('button', { name: '关闭配置', exact: true }).tap();
      await phone.setViewportSize({ width: 852, height: 393 });
      assert.equal(await phone.locator('.application-window[data-phase=open]').count(), 1, 'rotation must retain the active plugin');
      assert.equal(await phone.locator('.web-mobile-bar').isVisible(), true);
      await phone.getByRole('button', { name: '切换窗口', exact: true }).tap();
      await visibleBounds(phone.locator('.window-tabs'));
      await phone.keyboard.press('Escape');
      await phone.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await phone.locator('.web-mobile-bar #desktop').tap();
      await phone.screenshot({ path: `/tmp/work-desk-mobile-landscape-${engine.browserType().name()}-20261031.png` });
      await phone.setViewportSize({ width: 1200, height: 800 });
      await phone.locator('.web-mobile-bar').waitFor({ state: 'hidden' });
      assert.equal(await phone.locator('.web-mobile-bar').isVisible(), false);
      assert.equal(await phone.locator('.titlebar #desktop').count(), 1);
      assert.equal(await phone.locator('.window-tabs').getAttribute('popover'), null);
      assert.equal(await phoneFrame.evaluate(() => window.mobileRetainedProbe), 'retained');
      await phone.setViewportSize({ width: 393, height: 852 });
      await phone.locator('.web-mobile-bar').waitFor();
      await phone.getByRole('button', { name: '切换窗口', exact: true }).tap();
      await phone.getByRole('button', { name: '关闭窗口', exact: true }).tap();
      assert.equal(await phone.locator('iframe').count(), 0);
      await phone.keyboard.press('Escape');
      await phone.locator('.desktop-file').tap();
      await phone.locator('.application-window.focused iframe').waitFor();
      await phone.locator('.application-window.focused iframe').contentFrame().locator('textarea').first().waitFor();
      const fileFrame = phone.frames().find(frame => frame !== phone.mainFrame());
      await fileFrame.locator('textarea').first().waitFor();
      await fileFrame.locator('textarea').first().fill('mobile draft retained');
      await phone.locator('.web-mobile-bar #desktop').tap();
      await phone.locator('.shelf-app[data-plugin=text-editor]').tap();
      assert.equal(await fileFrame.locator('textarea').first().inputValue(), 'mobile draft retained');
    }
    const wideContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 852 } });
    const wide = await wideContext.newPage();
    const wideStartup = await delayStartup(wide, { autoStart: true });
    try {
      await login(wide);
      await wideStartup.request;
    } finally {
      wideStartup.release();
    }
    await wide.locator('.application-window[data-phase=open]').waitFor();
    await wide.locator('.web-mobile-bar').waitFor({ state: 'attached' });
    await wideStartup.remove();
    assert.equal(await wide.locator('.web-mobile-bar').isVisible(), false, 'desktop auto-start behavior remains unchanged');
    await wideContext.close();
    const openingContext = await mobileBrowser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 393, height: 852 } });
    const openingPhone = await openingContext.newPage();
    const startup = await delayStartup(openingPhone);
    await login(openingPhone);
    await startup.request;
    await openingPhone.locator('.web-opening').waitFor();
    await desktop.getByRole('button', { name: '用户菜单', exact: true }).click();
    await desktop.getByRole('menuitem', { name: '设置', exact: true }).click();
    await desktop.getByRole('button', { name: '桌面', exact: true }).click();
    await desktop.getByRole('switch', { name: '开启网页端', exact: true }).click();
    await openingPhone.locator('.web-stopped').waitFor();
    startup.release();
    await startup.remove();
    // An initialization that finishes after revocation must not restore the authenticated shell.
    await openingPhone.waitForFunction(() => !document.documentElement.hasAttribute('data-web-opening'));
    assert.equal(await openingPhone.locator('.app, .web-mobile-bar, .web-opening').count(), 0);
    await one.locator('.web-stopped').waitFor();
    await two.locator('.web-stopped').waitFor();
    for (const phone of mobilePages) {
      await phone.locator('.web-stopped').waitFor();
      assert.equal(await phone.locator('.web-mobile-bar').count(), 0);
      assert.equal(await phone.locator('iframe').count(), 0);
    }
    assert.equal(await one.locator('iframe').count(), 0);
    assert.deepEqual(JSON.parse(await readFile(join(data, 'preferences.json'), 'utf8')).theme, preferences.theme);
    assert.deepEqual(errors, []);
  } finally {
    await mobileBrowser?.close();
    await browser?.close();
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    await rm(data, { recursive: true, force: true });
  }
});
