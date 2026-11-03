import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('context reset requires confirmation, preserves layout and uses the shared side popup', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-context-ui-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import '@xterm/xterm/css/xterm.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    window.postMessage = () => {};
    const pluginId = 'ai-agent-sessions';
    window.calls = [];
    window.session = { id: 'original', pluginId, adapterId: 'codex', name: '上下文验证', cwd: '/project',
      activity: 'idle', protocol: 'managed-terminal', runtimeId: 'isolated' };
    api.host.getWindowContext = async () => ({ id: 'fixture' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => ({ sizes: { original: { width: 520, height: 480 } } });
    api.storage.getAdapterConfig = async () => ({});
    api.storage.saveLayout = async () => {};
    api.sessions.recover = async () => ({ sessions: [], archives: [] });
    api.sessions.list = async () => ({ sessions: [window.session] });
    api.sessions.attachWindow = async () => {};
    api.sessions.attach = async () => ({ data: window.session.id === 'original' ? 'old transcript' : '', sequence: 0 });
    api.sessions.resize = async () => {};
    api.events.sessionsChanged = callback => { window.refresh = callback; return () => {}; };
    api.sessions.resetContext = async (owner, id) => {
      window.calls.push([owner, id]);
      if (window.failReset) { throw Error('SDK 清理失败'); }
      if (window.holdReset) { await new Promise(resolve => { window.release = resolve; }); }
      window.session = { ...window.session, id: 'replacement', restoredFrom: 'original' };
      return window.session;
    };
    await mountWorkspace(document.querySelector('main'), { pluginId,
      adapters: [{ id: 'codex', capabilities: {} }] });
    window.ready = true;`, resolveDir: repository, sourcefile: 'context-fixture.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main id="workspace"></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready);
  const trigger = page.getByRole('button', { name: '清理会话上下文', exact: true });
  const popup = page.locator('dialog.desk-popup');
  assert.equal(await trigger.locator('svg').count(), 1);
  assert.equal(await trigger.getAttribute('title'), '清理会话上下文');
  for (const dismiss of ['取消', 'Escape', 'outside']) {
    await trigger.click();
    await popup.waitFor();
    if (dismiss === '取消') {
      await popup.getByRole('button', { name: dismiss, exact: true }).click();
    } else if (dismiss === 'Escape') {
      await page.keyboard.press('Escape');
    } else {
      await page.locator('.session-name').click();
    }
    await popup.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  }
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '清理会话上下文');
  await trigger.click();
  await popup.waitFor();
  assert.equal(await popup.evaluate(node => node.matches(':popover-open') && !node.matches(':modal')), true);
  assert.equal(await popup.evaluate(node => getComputedStyle(node, '::backdrop').backdropFilter), 'none');
  assert.equal(await popup.evaluate(node => getComputedStyle(node).borderRadius), '12px');
  assert.match(await popup.innerText(), /无法恢复/);
  const shots = join(repository, 'plugin-dev/dist/verification/session-context');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [320, 1000]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width);
      await page.waitForFunction(width => innerWidth === width, width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await popup.evaluate(node => {
        const box = node.getBoundingClientRect();
        return box.left >= 8 && box.right <= innerWidth - 7 && box.bottom <= innerHeight - 7
          && node.scrollWidth <= node.clientWidth;
      }), true);
      await popup.getByRole('button', { name: '确认清理', exact: true }).focus();
      await page.keyboard.press('Tab');
      await popup.getByRole('button', { name: '确认清理', exact: true }).focus();
      assert.equal(await popup.getByRole('button', { name: '确认清理', exact: true }).evaluate(node => node.matches(':focus-visible')), true);
      await page.screenshot({ path: join(shots, `${theme}-${width}.png`), animations: 'disabled' });
    }
  }
  await page.evaluate(() => { window.failReset = true; });
  await popup.getByRole('button', { name: '确认清理', exact: true }).click();
  await page.getByText('SDK 清理失败', { exact: true }).waitFor();
  assert.equal(await trigger.isEnabled(), true);
  for (const state of [{ activity: 'working' }, { activity: 'idle', blocked: { kind: 'question' } },
    { blocked: null, protocol: 'legacy' }]) {
    await page.evaluate(state => { Object.assign(window.session, state); window.refresh({ sessions: [window.session] }); }, state);
    assert.equal(await trigger.isDisabled(), true);
  }
  await page.evaluate(() => {
    Object.assign(window.session, { protocol: 'managed-terminal', activity: 'idle', blocked: null });
    window.refresh({ sessions: [window.session] });
    window.failReset = false; window.holdReset = true;
  });
  await page.getByRole('button', { name: '最大化', exact: true }).click();
  await trigger.click();
  await popup.getByRole('button', { name: '确认清理', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.release));
  assert.equal(await trigger.isDisabled(), true);
  await page.evaluate(() => window.release());
  await page.getByText('上下文已清理，已启动空白会话', { exact: true }).waitFor();
  assert.equal(await page.locator('.session.maximized').count(), 1);
  assert.equal(await page.locator('.session-name').innerText(), '上下文验证');
  assert.equal(await page.locator('.xterm').innerText().then(text => text.includes('old transcript')), false);
  assert.deepEqual(await page.evaluate(() => window.calls), [
    ['ai-agent-sessions', 'original'], ['ai-agent-sessions', 'original']
  ]);
});
