import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Use the real plugin list and confirmation flow without starting any plugin or touching saved data.
test('plugin upgrades block pointer and keyboard actions until success or failure', async () => {
  const bundle = await build({ stdin: {
    contents: "import { mountPlugins } from './desk/src/renderer/plugins.js'; window.mountPlugins = mountPlugins;",
    resolveDir: process.cwd()
  }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://fixture.test/**', route => route.fulfill({ body: '<html lang="zh-CN"><body><button id="outside">Outside</button><main></main><div id="toast" hidden></div></body></html>', contentType: 'text/html' }));
    await page.goto('http://fixture.test/');
    await page.addStyleTag({ content: await readFile('desk/src/renderer/desk.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('desk/src/resource/controls.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('desk/src/renderer/upgrade-progress.css', 'utf8') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      window.actions = 0;
      document.querySelector('#outside').onclick = () => { window.actions++; };
      document.addEventListener('keydown', () => { window.actions++; });
      const snapshot = { directory: '/packages', updates: [{ id: 'test-agent', version: '2.0.0' }], errors: [] };
      window.workDesk = {
        host: { browser: true },
        events: { pluginsChanged: () => () => {} },
        plugins: {
          list: async () => [{ id: 'test-agent', name: 'Test Agent', version: '1.0.0', state: 'disabled', type: 'application' }],
          checkUpdates: async () => snapshot,
          preview: async () => ({ confirmationToken: 'token' }),
          upgradeLatest: (...args) => {
            window.upgradeArgs = args;
            return new Promise((resolve, reject) => { window.completeUpgrade = resolve; window.failUpgrade = reject; });
          }
        }
      };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => window.mountPlugins(document.querySelector('main'), () => {}, document.createElement('div')));
    for (const outcome of ['success', 'failure']) {
      await page.getByRole('button', { name: '升级到 v2.0.0', exact: true }).click();
      await page.getByRole('button', { name: '确认', exact: true }).click();
      const progress = page.getByRole('dialog', { name: '正在升级插件', exact: true });
      await progress.waitFor({ timeout: 1500 });
      assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null);
      assert.match(await page.getByRole('progressbar').getAttribute('aria-label'), /test-agent.*2\.0\.0/);
      assert.deepEqual(await page.evaluate(() => window.upgradeArgs), ['test-agent', '2.0.0', 'token']);
      await page.evaluate(outcome => { document.documentElement.dataset.theme = outcome === 'success' ? 'dark' : 'light'; }, outcome);
      const appearance = await progress.evaluate(node => {
        const style = getComputedStyle(node);
        const bounds = node.getBoundingClientRect();
        return { border: style.borderTopWidth, shadow: style.boxShadow, background: style.backgroundColor, outline: style.outlineStyle,
          x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
          width: innerWidth, height: innerHeight, circleBackground: getComputedStyle(node.querySelector('.upgrade-track')).fill,
          animation: getComputedStyle(node.querySelector('.upgrade-fill')).animationName };
      });
      assert.equal(appearance.border, '0px');
      assert.equal(appearance.outline, 'none');
      assert.equal(appearance.shadow, 'none');
      assert.equal(appearance.background, 'rgba(0, 0, 0, 0)');
      assert.equal(appearance.circleBackground, outcome === 'success' ? 'rgb(34, 34, 34)' : 'rgb(255, 255, 255)');
      assert.equal(appearance.animation, 'none');
      assert.ok(Math.abs(appearance.x - appearance.width / 2) < 1);
      assert.ok(Math.abs(appearance.y - appearance.height / 2) < 1);
      const before = await page.evaluate(() => window.actions);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+k');
      const position = await page.locator('#outside').boundingBox();
      await page.mouse.click(position.x + 5, position.y + 5);
      assert.equal(await progress.isVisible(), true);
      assert.equal(await page.evaluate(() => window.actions), before);
      await page.evaluate(outcome => outcome === 'success' ? window.completeUpgrade() : window.failUpgrade(new Error('升级包校验失败')), outcome);
      await progress.waitFor({ state: 'detached' });
      await page.locator('#outside').click();
      assert.equal(await page.evaluate(() => window.actions), before + 1);
      if (outcome === 'failure') {
        await page.getByText('升级包校验失败', { exact: true }).waitFor();
      }
    }
  } finally {
    await browser.close();
  }
});

// Batch operations use one confirmation and one modal lock across all individual installations.
test('upgrade all serializes available updates, supports cancellation and stops on failure', async () => {
  const bundle = await build({ stdin: {
    contents: "import { mountPlugins } from './desk/src/renderer/plugins.js'; import { setLanguage } from './desk/src/renderer/i18n.js'; window.mountPlugins = mountPlugins; window.setLanguage = setLanguage;",
    resolveDir: process.cwd()
  }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://fixture.test/**', route => route.fulfill({ body: '<html lang="zh-CN"><body><button id="outside">Outside</button><main></main><div id="toast" hidden></div></body></html>', contentType: 'text/html' }));
    await page.goto('http://fixture.test/');
    await page.addStyleTag({ content: await readFile('desk/src/renderer/desk.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('desk/src/resource/controls.css', 'utf8') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      window.calls = [];
      window.snapshot = { directory: '/packages', updates: [], errors: [] };
      window.workDesk = {
        host: { browser: true },
        events: { pluginsChanged: callback => { window.refreshPlugins = callback; return () => {}; } },
        plugins: {
          list: async () => ['a', 'b', 'c'].map(id => ({ id, name: id, version: '1.0.0', state: 'disabled' })),
          checkUpdates: async () => window.snapshot,
          preview: async id => ({ confirmationToken: `${id}-token` }),
          upgradeLatest: (...args) => {
            window.calls.push(args);
            return new Promise((resolve, reject) => {
              window.finish = () => { window.snapshot.updates = window.snapshot.updates.filter(update => update.id !== args[0]); resolve(); };
              window.fail = () => reject(new Error('升级包校验失败'));
            });
          }
        }
      };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => window.mountPlugins(document.querySelector('main'), () => {}, document.createElement('div')));
    const all = page.getByRole('button', { name: '一键升级全部插件', exact: true });
    assert.equal(await all.isDisabled(), true);
    await page.evaluate(async () => {
      window.snapshot.updates = ['a', 'b', 'c'].map(id => ({ id, version: '2.0.0' }));
      await window.refreshPlugins();
    });
    await all.click();
    await page.getByText('将升级 3 个插件，关闭相关窗口和任务，保留配置、历史数据和启用状态。', { exact: true }).waitFor();
    // Confirmation stays centered even when its trigger is in the settings toolbar.
    for (const viewport of [{ width: 1280, height: 720 }, { width: 900, height: 600 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => {
        const bounds = document.querySelector('dialog[aria-label="升级全部插件"]').getBoundingClientRect();
        return Math.abs(bounds.x + bounds.width / 2 - innerWidth / 2) < 1
          && Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2) < 1;
      }, null, { timeout: 1500 });
    }
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    for (const outcome of ['failure', 'success']) {
      await all.click();
      await page.getByRole('button', { name: '确认', exact: true }).click();
      const progress = page.getByRole('dialog', { name: '正在升级插件', exact: true });
      await progress.waitFor();
      await page.waitForFunction(() => window.calls.length > 0);
      await page.keyboard.press('Escape');
      assert.equal(await progress.isVisible(), true);
      await page.evaluate(() => window.finish());
      await page.waitForFunction(() => window.calls.length === 2);
      assert.equal(await progress.isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.calls), [['a', '2.0.0', 'a-token'], ['b', '2.0.0', 'b-token']]);
      if (outcome === 'failure') {
        await page.evaluate(() => window.fail());
        await progress.waitFor({ state: 'detached' });
        await page.getByText('升级包校验失败', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.calls.length), 2);
        await page.evaluate(async () => {
          window.calls = [];
          window.snapshot.updates = ['a', 'b', 'c'].map(id => ({ id, version: '2.0.0' }));
          await window.refreshPlugins();
        });
      } else {
        await page.evaluate(() => window.finish());
        await page.waitForFunction(() => window.calls.length === 3);
        assert.equal(await progress.isVisible(), true);
        await page.evaluate(() => window.finish());
        await progress.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.querySelector('button[title="一键升级全部插件"]').disabled);
      }
    }
    await page.evaluate(() => window.setLanguage('en'));
    assert.equal(await page.getByRole('button', { name: 'Upgrade all plugins', exact: true }).getAttribute('title'), 'Upgrade all plugins');
  } finally {
    await browser.close();
  }
});
