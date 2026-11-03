import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('engine removal requires explicit confirmation and preserves the originally selected target', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'engine-removal-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  await build({ stdin: { contents: `
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './plugin-dev/ai-agent/src/renderer/settings.css';
    import './desk/src/resource/controls.css';
    import { conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { engineSettings } from './plugin-dev/ai-agent/src/renderer/engine-settings.js';
    window.postMessage = () => {};
    window.calls = [];
    window.errors = [];
    window.installing = false;
    const engines = ['codex', 'claude'].map(id => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code',
      state: 'missing', pin: { version: 'fixture', platform: 'fixture', url: 'fixture', sha256: 'fixture' },
      installation: { state: 'idle' }, sources: { auth: 'fixture', skills: [], rules: [] } }));
    conversationApi.call = async (method, ...args) => {
      window.calls.push({ method, args });
      if (method === 'engines.list') {
        return engines.map(engine => ({ ...engine, installation: { state: window.installing ? 'installing' : 'idle' } }));
      }
      if (method === 'engines.config') { return { defaultEngine: 'codex', engines: {} }; }
    };
    window.controls = engineSettings({ onError: error => window.errors.push(error.message) });
    document.querySelectorAll('[data-panel]').forEach(node => { node.hidden = node.dataset.panel !== 'cli'; });
    document.querySelector('#remove-engine').closest('details').open = true;
    await window.controls.refresh();
    window.ready = true;
  `, resolveDir: repository, sourcefile: 'engine-removal-fixture.js' }, bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  const html = await readFile(join(repository, 'plugin-dev/ai-agent/src/resource/settings.html'), 'utf8');
  await writeFile(join(fixture, 'index.html'), html.replace('href="settings.css"', 'href="app.css"')
    .replace('</body>', '<script type="module" src="app.js"></script></body>'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(3000);
  await page.goto(`file://${join(fixture, 'index.html')}`);
  await page.waitForFunction(() => window.ready);
  const remove = page.getByRole('button', { name: '移除引擎', exact: true });
  const dialog = page.locator('dialog:popover-open');
  const removals = () => page.evaluate(() => window.calls.filter(call => call.method === 'engines.remove'));
  for (const theme of ['light', 'dark']) {
    for (const width of [1000, 600, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('html').evaluate((node, theme) => { node.dataset.theme = theme; }, theme);
      for (const dismiss of ['cancel', 'escape', 'outside']) {
        await remove.focus();
        await remove.press('Enter');
        await dialog.waitFor();
        assert.deepEqual(await removals(), [], 'opening never removes the engine');
        assert.match(await dialog.textContent(), /Codex/);
        assert.match(await dialog.textContent(), /安装登记/);
        assert.match(await dialog.textContent(), /保留.*程序文件.*配置.*授权.*历史/);
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'popup fits the viewport');
        assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
        for (const button of await dialog.getByRole('button').all()) {
          assert.equal(await button.locator('svg').count(), 1);
          assert.equal(await button.getAttribute('title'), await button.getAttribute('aria-label'));
        }
        if (dismiss === 'cancel') { await dialog.getByRole('button', { name: '取消', exact: true }).click(); }
        if (dismiss === 'escape') { await page.keyboard.press('Escape'); }
        if (dismiss === 'outside') { await page.mouse.click(width - 2, 798); }
        await dialog.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.id === 'remove-engine');
        assert.deepEqual(await removals(), [], 'dismissal never removes the engine');
      }
    }
  }
  await remove.click();
  await dialog.waitFor();
  await page.locator('#config-engine').evaluate(node => { node.value = 'claude'; });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'engines.remove'));
  assert.deepEqual(await removals(), [{ method: 'engines.remove', args: ['codex'] }]);
  await page.evaluate(async () => { window.installing = true; await window.controls.refresh(); });
  assert.equal(await remove.isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  await page.evaluate(() => window.controls.dispose());
});
