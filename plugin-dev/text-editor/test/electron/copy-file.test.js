import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { launch } from '../../../../desk/test/electron/helpers.js';
import { resolveFileReferences } from '../../../ai-agent/src/main/common/file-references.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('copying a listed file pastes its original reference into Agent without saving or sending', { timeout: 90000 }, async t => {
  let app;
  // Preserve all native clipboard formats before launch registers application cleanup.
  t.after(async () => {
    if (app) {
      await app.evaluate(async ({ clipboard }) => clipboard.write(globalThis.editorTestClipboard));
    }
  });
  const launched = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  const { page, data } = launched;
  app = launched.app;
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.editorTestClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(
      Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const root = join(await realpath(data), 'documents');
  const name = "需求 'v2' #100%.md";
  const path = join(root, name);
  await mkdir(root);
  await writeFile(path, 'original disk content');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: name }).waitFor();
  await frame.locator('#editor').fill('unsaved editor text');
  const file = frame.locator('#group-files').getByRole('button', { name, exact: true });
  await file.click({ button: 'right' });
  assert.equal(await frame.getByRole('menuitem', { name: '复制文件', exact: true }).count(), 1);
  await frame.getByRole('menuitem', { name: '复制文件', exact: true }).click();
  await frame.locator('#status').filter({ hasText: '已复制文件' }).waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), pathToFileURL(path).href);
  assert.equal(await readFile(path, 'utf8'), 'original disk content');
  assert.equal(await frame.locator('#editor').inputValue(), 'unsaved editor text');

  // Run the real Agent terminal and file resolver; only replace the external CLI transport.
  const fixture = join(data, 'agent-copy-fixture');
  await mkdir(fixture);
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import '@xterm/xterm/css/xterm.css';
    import { api } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
    window.postMessage = () => {};
    window.inputs = [];
    api.sessions.attach = async () => ({ data: '', sequence: 0 });
    api.sessions.resize = async () => {};
    api.sessions.write = async (owner, id, text) => { window.inputs.push(text); };
    api.sessions.fileReferences = (owner, id, paths) => window.resolveReferences(paths);
    api.events.output = () => () => {};
    const session = { pluginId: 'ai-agent-sessions', id: 'editor-copy', adapterId: 'codex', cwd: '/' };
    window.view = mountTerminal(document.querySelector('.terminal-mount'), { session, protocol: 'codex' });
  `, resolveDir: resolve('.'), sourcefile: 'editor-copy-fixture.js' },
  bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main class="windows arranged" style="height:100vh"><article class="session maximized"><div class="session-content"><div class="terminal-mount"></div></div></article></main><script type="module" src="app.js"></script>');
  const opened = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, path) => {
    const window = new BrowserWindow({ width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
    await window.loadFile(path);
  }, join(fixture, 'index.html'));
  const agent = await opened;
  await agent.exposeFunction('resolveReferences', paths => resolveFileReferences(paths, '/'));
  await agent.waitForFunction(() => window.view && !window.view.terminal.options.disableStdin);
  await agent.locator('.xterm-helper-textarea').press('Meta+v');
  await agent.locator('.file-reference').waitFor();
  assert.equal(await agent.locator('.file-reference').getAttribute('title'), path);
  assert.equal(await agent.locator('.file-reference>span').textContent(), `[!${name}]`);
  assert.deepEqual(await agent.evaluate(() => window.inputs), [], 'pasting must not submit to the CLI');
  await agent.close();

  await page.bringToFront();
  await app.evaluate(({ clipboard }) => clipboard.writeText('before group copy'));
  await file.press('Meta+c');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), pathToFileURL(path).href);
  await frame.locator('#history-toggle').click();
  await app.evaluate(({ clipboard }) => clipboard.writeText('before history copy'));
  await frame.locator('#history').getByRole('button', { name, exact: true }).press('Control+c');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), pathToFileURL(path).href);
  await frame.locator('#history-close').click();
  await frame.locator('#editor').evaluate(node => { node.focus(); node.setSelectionRange(0, 7); });
  await page.keyboard.press('Meta+c');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'unsaved', 'text selection retains native copy');
  assert.equal(await readFile(path, 'utf8'), 'original disk content');
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(0, 0);
    window.setSize(580, 720);
  });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    await file.press('Shift+F10');
    const copy = frame.getByRole('menuitem', { name: '复制文件', exact: true });
    await copy.focus();
    assert.equal(await copy.evaluate(node => node === document.activeElement), true);
    assert.equal(await frame.locator('#file-menu').evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight;
    }), true);
    await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/copy-file-${theme}.png`) });
    await copy.press('Escape');
    // Shared popup dismissal restores focus on its queued toggle event.
    await file.evaluate(node => new Promise(resolve => {
      if (node === document.activeElement) {
        resolve();
      } else {
        node.addEventListener('focus', () => resolve(), { once: true });
      }
    }));
    assert.equal(await file.evaluate(node => node === document.activeElement), true);
  }
});
