import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('plugin list restores enable switches and persists drag order across layouts', async () => {
  const bundle = await build({ stdin: {
    contents: "import { mountPlugins } from './desk/src/renderer/plugins.js'; window.mountPlugins = mountPlugins;",
    resolveDir: process.cwd()
  }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://fixture.test/**', route => route.fulfill({
      body: '<html lang="zh-CN"><body><main></main><div id="toast" hidden></div></body></html>', contentType: 'text/html'
    }));
    await page.goto('http://fixture.test/');
    await page.addStyleTag({ content: await readFile('desk/src/resource/controls.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('desk/src/renderer/desk.css', 'utf8') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      window.records = ['a', 'b'].map((id, index) => ({ id, name: id, version: '1.0.0',
        state: index ? 'disabled' : 'enabled', views: [{ id: 'main' }] }));
      window.calls = [];
      window.tasks = [];
      const change = async (id, state, token) => {
        window.calls.push([id, state, token]);
        window.records.find(record => record.id === id).state = state;
        await window.refreshPlugins();
      };
      window.workDesk = {
        host: { browser: true },
        events: { pluginsChanged: callback => { window.refreshPlugins = callback; return () => {}; } },
        plugins: {
          list: async () => window.records,
          checkUpdates: async () => ({ directory: '', updates: [], errors: [] }),
          preview: async () => ({ runningTasks: window.tasks, confirmationToken: 'token' }),
          enable: id => change(id, 'enabled'),
          disable: (id, token) => change(id, 'disabled', token)
        }
      };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => window.mountPlugins(document.querySelector('main'), () => {}, document.createElement('div')));
    assert.equal(await page.locator('.plugin-card button[title="打开"]').count(), 0);
    const enabled = page.locator('[data-plugin="a"] [role="switch"]');
    const disabled = page.locator('[data-plugin="b"] [role="switch"]');
    await enabled.waitFor({ timeout: 1000 });
    assert.equal(await enabled.getAttribute('aria-checked'), 'true');
    assert.equal(await disabled.getAttribute('aria-checked'), 'false');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await enabled.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(0, 185, 107)');
      assert.equal(await disabled.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(120, 124, 132)');
    }
    await disabled.click();
    await page.waitForFunction(() => document.querySelector('[data-plugin="b"] [role="switch"]').ariaChecked === 'true');
    await enabled.click();
    await page.waitForFunction(() => document.querySelector('[data-plugin="a"] [role="switch"]').ariaChecked === 'false');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(() => { window.tasks = [{ name: 'Running task', exited: false }]; });
    await disabled.click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await disabled.getAttribute('aria-checked'), 'true');
    assert.deepEqual(await page.evaluate(() => window.calls), [['b', 'enabled', undefined], ['a', 'disabled', 'token']]);
    const order = () => page.locator('.plugin-card').evaluateAll(nodes => nodes.map(node => node.dataset.plugin));
    const handle = page.locator('[data-plugin="b"] [title="拖动排序"]');
    await handle.dragTo(page.locator('[data-plugin="a"]'), { targetPosition: { x: 20, y: 2 } });
    assert.deepEqual(await order(), ['b', 'a']);
    await page.evaluate(() => window.refreshPlugins());
    assert.deepEqual(await order(), ['b', 'a']);
    await page.evaluate(() => window.mountPlugins(document.querySelector('main'), () => {}, document.createElement('div')));
    assert.deepEqual(await order(), ['b', 'a']);
    await page.evaluate(() => localStorage.setItem('plugin-layout', 'list'));
    await page.evaluate(() => window.refreshPlugins());
    assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'list');
    const target = await page.locator('[data-plugin="a"]').boundingBox();
    await page.locator('[data-plugin="b"] [title="拖动排序"]').dragTo(page.locator('[data-plugin="a"]'),
      { targetPosition: { x: 20, y: target.height - 5 } });
    assert.deepEqual(await order(), ['a', 'b']);
    await page.evaluate(() => {
      window.records.push({ id: 'c', name: 'c', version: '1.0.0', state: 'disabled', views: [] });
      return window.refreshPlugins();
    });
    assert.deepEqual(await order(), ['a', 'b', 'c']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('plugin-order'))), ['a', 'b']);
  } finally {
    await browser.close();
  }
});
