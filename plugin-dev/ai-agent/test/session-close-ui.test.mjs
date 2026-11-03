import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('delete confirmation is centered, fits narrow windows and only explicit confirmation deletes', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'session-close-ui-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './desk/src/resource/controls.css';
    import { api } from './plugin-dev/ai-agent/src/renderer/ui.js';
    import { closeSession } from './plugin-dev/ai-agent/src/renderer/session-close.js';
    window.calls = [];
    api.sessions.delete = async (...args) => window.calls.push(args);
    document.querySelector('#close-session').onclick = () => closeSession('fixture', { id: 'new', name: 'Agent 7' });
  `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), sourcefile: 'session-close-fixture.js' },
  bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><link rel="stylesheet" href="app.css">'
    + '<button id="close-session">关闭会话</button><script type="module" src="app.js"></script>');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.goto(`file://${join(fixture, 'index.html')}`);
  const dialog = page.locator('dialog:popover-open');
  for (const theme of ['light', 'dark']) {
    for (const width of [1000, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
      await page.locator('#close-session').click();
      await dialog.getByRole('button', { name: '删除', exact: true }).click();
      await dialog.getByRole('heading', { name: '确认永久删除？' }).waitFor();
      await page.waitForFunction(() => document.querySelector('dialog:popover-open').getAnimations().every(a => a.playState === 'finished'));
      const bounds = await dialog.boundingBox();
      assert.ok(Math.abs(bounds.x + bounds.width / 2 - width / 2) < 2, 'delete confirmation horizontally centered');
      assert.ok(Math.abs(bounds.y + bounds.height / 2 - 400) < 2, 'delete confirmation vertically centered');
      assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.calls), []);
      await page.waitForFunction(() => document.activeElement?.id === 'close-session');
    }
  }
  await page.locator('#close-session').click();
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(() => window.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.calls), [['fixture', 'new']]);
});
