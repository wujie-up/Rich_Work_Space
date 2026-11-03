import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('idle terminal remains painted after resizing and restoring its session card', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-resize-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './plugin-dev/ai-agent/src/renderer/session-status.css';
    import '@xterm/xterm/css/xterm.css';
    import { Terminal } from '@xterm/xterm';
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (...args) { window.nativeTerminal = this; return open.apply(this, args); };
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    window.postMessage = () => {};
    const pluginId = 'ai-agent-sessions';
    window.sessions = [{ id: 'resizing', pluginId, adapterId: 'custom', name: 'resize', cwd: '/project', activity: 'idle' }];
    api.host.getWindowContext = async () => ({ id: 'fixture-window' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => ({ order: ['resizing'], collapsed: [], maximized: [],
      sizes: { resizing: { width: 600, height: 405 } }, positions: { resizing: { col: 0, row: 0 } } });
    api.storage.getAdapterConfig = async () => ({});
    api.storage.saveLayout = async (owner, layout) => { window.savedLayout = structuredClone(layout); };
    api.sessions.recover = async () => ({ sessions: [], archives: [] });
    api.sessions.list = async () => ({ sessions: window.sessions });
    api.sessions.attachWindow = async () => {};
    window.attaches = 0;
    api.sessions.attach = async () => { window.attaches++; return { data: '\\x1b[?1049h', sequence: 0 }; };
    let output;
    let sequence = 0;
    let remoteSize = '';
    api.events.output = callback => { output = callback; return () => {}; };
    window.resizes = [];
    api.sessions.resize = async (owner, id, cols, rows) => {
      if (cols !== window.nativeTerminal.cols || rows !== window.nativeTerminal.rows) { throw Error('Local and PTY sizes differ'); }
      window.resizes.push({ cols, rows });
      const size = cols + ':' + rows;
      if (size !== remoteSize) {
        remoteSize = size;
        output({ pluginId, sessionId: id, sequence: ++sequence,
          data: '\\x1b[H\\x1b[2J' + Array.from({ length: rows - 1 }, () => 'RESIZE CONTENT MUST REMAIN').join('\\r\\n') + '\\r\\n' });
      }
    };
    api.sessions.write = async () => {};
    api.sessions.composer = async () => {};
    api.events.sessionsChanged = () => () => {};
    await mountWorkspace(document.querySelector('main'), { pluginId, adapters: [{ id: 'custom', capabilities: {} }] });
    window.ready = true;`, resolveDir: repository, sourcefile: 'terminal-resize-fixture.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 950));
  await page.waitForFunction(() => window.ready && window.resizes.length);
  const card = page.locator('.session');
  await page.evaluate(() => { window.retainedTerminal = document.querySelector('.xterm'); });
  const painted = async () => {
    // Buffer text alone cannot catch a cleared GPU canvas; inspect the displayed pixels as well.
    const image = await page.locator('.terminal-screen').screenshot();
    return app.evaluate(({ nativeImage }, data) => {
      const pixels = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getBitmap();
      let foreground = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 130 && pixels[i + 1] > 130 && pixels[i + 2] > 130) { foreground++; }
      }
      return foreground;
    }, image.toString('base64'));
  };
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new CustomEvent('desk-theme', { detail: 'dark' })); });
  assert.ok(await painted() > 100);
  for (const [width, height] of [[960, 650], [380, 220], [1150, 740], [600, 405]]) {
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
    await page.mouse.down();
    await page.mouse.move(box.x + width - 3, box.y + height - 3, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const pixels = await painted();
    assert.ok(pixels > 100, 'idle transcript must remain visible after resizing');
  }
  // A vertical-only resize must persist and give the extra space to the terminal.
  const initialRows = await page.evaluate(() => window.nativeTerminal.rows);
  const initialHeight = await card.evaluate(node => node.getBoundingClientRect().height);
  await card.evaluate(node => { node.style.height = '605px'; });
  await page.waitForFunction(() => window.savedLayout?.sizes?.resizing?.height >= 600);
  await page.waitForFunction(rows => window.nativeTerminal.rows > rows, initialRows);
  assert.equal(await card.locator('.session-header').evaluate(node => node.getBoundingClientRect().height), 34);
  assert.ok(await painted() > 100, 'vertical-only resizing must preserve the transcript');
  // Native dragging can finish on another grid row; restore the actual starting size.
  await card.evaluate((node, height) => { node.style.height = `${height}px`; }, initialHeight);
  await page.waitForFunction(() => window.savedLayout?.sizes?.resizing?.height <= 410);
  await page.waitForFunction(rows => window.nativeTerminal.rows <= rows, initialRows);
  await card.locator('.session-model').evaluate(node => { node.hidden = false; node.textContent = 'GPT-6.1-Sol medium'; });
  assert.equal(await card.locator('.session-header').evaluate(node => node.firstElementChild.classList.contains('session-status')), true);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value;
      window.dispatchEvent(new CustomEvent('desk-theme', { detail: value })); }, theme);
    await page.waitForTimeout(150);
    await card.screenshot({ path: `/tmp/agent-header-${theme}.png` });
    assert.equal(await card.locator('.session-header').evaluate(node => node.getBoundingClientRect().height), 34);
    await card.evaluate(node => { node.style.width = '360px'; });
    await page.waitForTimeout(250);
    assert.ok(await card.locator('.session-header').evaluate(node => node.scrollWidth <= node.clientWidth), 'narrow header must not overflow');
    await card.screenshot({ path: `/tmp/agent-header-narrow-${theme}.png` });
    await card.evaluate(node => { node.style.width = '600px'; });
    await page.waitForTimeout(250);
  }
  const transcript = () => page.evaluate(() => {
    const buffer = window.nativeTerminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true)).filter(Boolean).join('\n');
  });
  const beforeResize = await transcript();
  assert.match(beforeResize, /RESIZE CONTENT MUST REMAIN/);
  // A brief intermediate layout must not shrink only the local alternate screen and discard its contents.
  await page.evaluate(async () => {
    const screen = document.querySelector('.terminal-screen');
    screen.style.flex = 'none';
    screen.style.height = '20px';
    await new Promise(resolve => setTimeout(resolve, 35));
    screen.style.flex = '';
    screen.style.height = '';
  });
  await page.waitForTimeout(250);
  assert.equal(await transcript(), beforeResize, 'an intermediate layout must preserve the complete idle screen');
  assert.ok(await painted() > 100, 'an intermediate resize must not leave the idle alternate screen blank');
  // A GPU context can be discarded during a native window resize.
  await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('.xterm-screen canvas')].find(node => node.getContext('webgl2'));
    const gl = canvas?.getContext('webgl2');
    if (!gl) { throw Error('The test requires the GPU renderer'); }
    window.gpu = gl.getExtension('WEBGL_lose_context');
    window.gpu.loseContext();
  });
  await page.evaluate(() => { document.querySelector('.session').style.width = '900px'; document.querySelector('.session').style.height = '600px'; });
  await page.waitForTimeout(150);
  await page.evaluate(() => window.gpu.restoreContext());
  await page.waitForTimeout(250);
  assert.ok(await painted() > 100, 'a restored context must repaint the idle transcript');
  for (let i = 0; i < 3; i++) {
    await card.getByRole('button', { name: '折叠', exact: true }).click();
    await card.getByRole('button', { name: '展开', exact: true }).click();
    assert.ok(await painted() > 100);
    await card.getByRole('button', { name: '最大化', exact: true }).click();
    assert.ok(await painted() > 100);
    await card.getByRole('button', { name: '恢复原大小', exact: true }).click();
    assert.ok(await painted() > 100);
  }
  assert.equal(await page.evaluate(() => document.querySelector('.xterm') === window.retainedTerminal && window.attaches === 1), true);
  assert.equal(await page.evaluate(() => window.resizes.every(({ cols, rows }) => cols >= 2 && cols <= 500 && rows >= 2 && rows <= 200)), true);
  assert.deepEqual(errors, []);
});
