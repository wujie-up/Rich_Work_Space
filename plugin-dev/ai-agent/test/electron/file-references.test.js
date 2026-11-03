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

test('pasted file references stay compact, removable and ordered with native terminal input', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-file-paste-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import '@xterm/xterm/css/xterm.css';
    import { api } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
    window.postMessage = () => {};
    window.inputs = [];
    api.sessions.attach = async () => ({ data: '\\x1b[?2004h', sequence: 0 });
    api.sessions.resize = async () => {};
    api.sessions.write = async (owner, id, data) => { window.inputs.push(data); };
    api.sessions.fileReferences = async (owner, id, paths) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return paths.some(path => path.includes('missing')) ? [] : paths.map(path => ({ path, name: path.split('/').at(-1) }));
    };
    api.sessions.saveImage = async () => '/tmp/clipboard.png';
    api.events.output = () => () => {};
    const session = { pluginId: 'ai-agent-sessions', id: 'paste-fixture', adapterId: 'codex', cwd: '/project' };
    window.view = mountTerminal(document.querySelector('.terminal-mount'), { session, protocol: 'codex' });
    window.pasteText = text => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    };`, resolveDir: repository, sourcefile: 'file-paste-fixture.js' },
  bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main class="windows arranged" style="height:100vh"><article class="session maximized"><div class="session-content"><div class="terminal-mount"></div></div></article></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.view && !window.view.terminal.options.disableStdin);
  await page.locator('.xterm-helper-textarea').focus();
  const path = "/project/需求 'v2'.md";
  await page.evaluate(path => window.pasteText(path), path);
  await page.waitForFunction(() => document.querySelectorAll('.file-reference').length === 1);
  assert.equal(await page.locator('.file-reference>span').textContent(), "[!需求 'v2'.md]");
  assert.equal(await page.locator('.file-reference').getAttribute('title'), path);
  assert.deepEqual(await page.evaluate(() => window.inputs), []);
  await page.evaluate(path => window.pasteText(path), path);
  await page.keyboard.type('review');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.inputs.some(input => input.endsWith('\r')));
  assert.equal(await page.evaluate(() => window.inputs.join('')), "review\x1b[200~ '/project/需求 '\\''v2'\\''.md' \x1b[201~\r");
  assert.equal(await page.locator('.session-file-references').isVisible(), false);
  // A later keystroke and submit cannot overtake asynchronous path resolution.
  await page.evaluate(() => { window.inputs = []; window.pasteText('/project/second.md'); });
  await page.keyboard.press('Enter');
  await page.keyboard.type('next');
  await page.waitForFunction(() => window.inputs.join('').endsWith('next'));
  assert.equal(await page.evaluate(() => window.inputs.join('')), "\x1b[200~ '/project/second.md' \x1b[201~\rnext");
  await page.evaluate(() => { window.inputs = []; window.pasteText('/project/remove.md'); });
  await page.getByRole('button', { name: '移除 remove.md', exact: true }).click();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.inputs.length === 1);
  assert.deepEqual(await page.evaluate(() => window.inputs), ['\r']);
  await page.evaluate(() => { window.inputs = []; window.pasteText('/project/missing.md'); });
  await page.waitForFunction(() => window.inputs.length === 1);
  assert.deepEqual(await page.evaluate(() => window.inputs), ['\x1b[200~/project/missing.md\x1b[201~']);
  await page.evaluate(() => { window.inputs = []; window.pasteText('普通粘贴 中文'); });
  await page.waitForFunction(() => window.inputs.length === 1);
  assert.deepEqual(await page.evaluate(() => window.inputs), ['\x1b[200~普通粘贴 中文\x1b[201~']);
  // Images retain the native CLI attachment path rather than becoming generic file chips.
  await page.evaluate(() => {
    window.inputs = [];
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }));
    document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.inputs.length === 2);
  assert.deepEqual(await page.evaluate(() => window.inputs), ["\x1b[200~'/tmp/clipboard.png'\x1b[201~", '\r']);
  // Both themes and narrow sessions reserve room for the chips and keep focus on removal/clear.
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.view.setTheme(theme); window.pasteText('/project/very-long-file-name.md'); }, theme);
    await page.waitForFunction(() => document.querySelectorAll('.file-reference').length === 1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(420, 400));
    assert.equal(await page.evaluate(() => {
      const tray = document.querySelector('.session-file-references').getBoundingClientRect();
      const screen = document.querySelector('.terminal-screen').getBoundingClientRect();
      return screen.bottom <= tray.top && tray.right <= window.innerWidth;
    }), true);
    for (const layout of ['normal', 'tiled']) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 720));
      await page.evaluate(layout => {
        const card = document.querySelector('.session');
        card.classList.remove('maximized');
        card.style.setProperty('--session-width', layout === 'tiled' ? '440px' : '700px');
        card.style.left = layout === 'tiled' ? '480px' : '0';
      }, layout);
      assert.equal(await page.evaluate(() => {
        const card = document.querySelector('.session').getBoundingClientRect();
        const tray = document.querySelector('.session-file-references').getBoundingClientRect();
        const screen = document.querySelector('.terminal-screen').getBoundingClientRect();
        return screen.height > 100 && screen.bottom <= tray.top && tray.right <= card.right && tray.bottom <= card.bottom;
      }), true);
    }
    if (process.env.AGENT_FILE_PREVIEW) {
      await page.screenshot({ path: `${process.env.AGENT_FILE_PREVIEW}-${theme}.png` });
    }
    await page.evaluate(() => window.view.clear());
    await page.waitForFunction(() => document.querySelector('.session-file-references').hidden);
    await page.evaluate(() => document.querySelector('.session').classList.add('maximized'));
  }
  await page.evaluate(() => window.view.dispose());
  assert.deepEqual(errors, []);
});
