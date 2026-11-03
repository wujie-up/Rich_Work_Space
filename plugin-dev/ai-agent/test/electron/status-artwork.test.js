import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

test('status kettles distinguish calm, heating and boiling without restarting on repeated updates', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-status-artwork-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './plugin-dev/ai-agent/src/renderer/session-status.css';
    import { sessionStatus } from './plugin-dev/ai-agent/src/renderer/session-status.js';
    window.sessionStatus = sessionStatus;
    for (const [state, label] of [['working', '工作中'], ['idle', '等待用户输入'], ['blocked', '等待用户确认'], ['offline', '连接不可用']]) {
      const card = document.createElement('section');
      card.innerHTML = '<header><strong></strong><span class="session-status" role="img"></span></header><div class="artwork"></div>';
      card.querySelector('strong').textContent = label;
      sessionStatus(card.querySelector('.session-status'), state, label);
      const preview = card.querySelector('.session-status').cloneNode(true);
      preview.style.width = '256px';
      preview.style.height = '192px';
      card.querySelector('.artwork').append(preview);
      document.body.append(card);
    }`, resolveDir: fileURLToPath(new URL('../../../../', import.meta.url)), sourcefile: 'status-artwork.js' },
  bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), `<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css">
    <style>body{padding:24px;display:flex;flex-wrap:wrap;gap:18px}section{background:var(--panel);padding:16px;min-width:0}
    header{display:flex;align-items:center;gap:8px}strong{font-size:12px;min-width:0}.artwork{margin-top:24px}
    body.tiled section{width:100%;padding:8px}body.tiled .artwork{display:none}</style>
    <script type="module" src="app.js"></script>`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/status-artwork.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const icons = page.locator('header .session-status');
  await icons.nth(3).waitFor();
  assert.deepEqual(await icons.locator('svg').evaluateAll(nodes => nodes.map(node => node.getAttribute('viewBox'))),
    ['0 0 64 48', '0 0 64 48', '0 0 64 48', '0 0 64 48']);
  assert.equal(await icons.locator('.kettle-body').count(), 4);
  assert.equal(await icons.nth(0).locator('.kettle-heat').count(), 1);
  assert.equal(await icons.nth(2).locator('.kettle-steam').count(), 3);
  assert.equal(await icons.nth(1).evaluate(node => node.getAnimations({ subtree: true }).length), 0);
  assert.equal(await icons.nth(0).locator('.kettle-water').evaluate(node => node.getAnimations().length), 1);
  assert.equal(await icons.nth(3).locator('.kettle-plug').count(), 1);
  assert.equal(await icons.nth(3).evaluate(node => node.getAnimations({ subtree: true }).length), 0);
  const moving = page.locator('header .kettle-heat, header .kettle-steam, header .kettle-lid');
  const first = await moving.evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).transform, getComputedStyle(node).opacity]));
  await page.waitForTimeout(350);
  assert.notDeepEqual(await moving.evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).transform, getComputedStyle(node).opacity])), first);
  await icons.nth(1).locator('svg').evaluate(node => { node.dataset.retained = 'yes'; });
  await icons.nth(1).evaluate(node => window.sessionStatus(node, 'done', '等待用户输入'));
  assert.equal(await icons.nth(1).locator('svg').getAttribute('data-retained'), 'yes');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    // Seek every part to the same point so screenshots show coherent poses.
    for (const phase of [0, 400, 900]) {
      await page.evaluate(phase => document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = phase; }), phase);
      if (process.env.STATUS_ARTWORK_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.STATUS_ARTWORK_SCREENSHOTS, `${theme}-${phase}.png`) });
        await page.locator('section').nth(1).screenshot({
          path: join(process.env.STATUS_ARTWORK_SCREENSHOTS, `waiting-${theme}-${phase}.png`)
        });
      }
    }
    assert.equal(await icons.nth(0).evaluate(node => getComputedStyle(node).color), theme === 'light' ? 'rgb(116, 86, 184)' : 'rgb(188, 171, 248)');
  }
  if (process.env.STATUS_ARTWORK_ANIMATION) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 340));
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    for (let frame = 0; frame < 48; frame++) {
      await page.evaluate(time => document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = time; }),
        frame * 4000 / 48);
      await page.screenshot({ path: join(process.env.STATUS_ARTWORK_ANIMATION, `${String(frame).padStart(2, '0')}.png`) });
    }
  }
  await page.evaluate(() => { document.body.className = 'tiled'; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(320, 500));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok((await icons.evaluateAll(nodes => nodes.map(node => {
    const icon = node.getBoundingClientRect();
    const header = node.parentElement.getBoundingClientRect();
    return icon.left >= header.left && icon.right <= header.right;
  }))).every(Boolean));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok((await moving.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName))).every(name => name === 'none'));
  assert.deepEqual(await icons.evaluateAll(nodes => nodes.map(node => node.getAnimations({ subtree: true }).length)), [0, 0, 0, 0]);
  assert.equal(await icons.nth(2).getAttribute('aria-label'), '等待用户确认');
});
