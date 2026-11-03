import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('session maximizes within the plugin and restores its layout without reconnecting the terminal', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-maximize-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './plugin-dev/ai-agent/src/renderer/session-status.css';
    import '@xterm/xterm/css/xterm.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    // Keep real workspace/terminal rendering; replace only the host RPC boundary.
    window.postMessage = () => {};
    const pluginId = 'ai-agent-sessions';
    const generation = Number(localStorage.getItem('generation') || 0);
    window.sessions = ['first', 'second', 'third'].map(id => ({ id: generation ? id + '-' + generation : id, restoredFrom: generation ? id : undefined, pluginId, adapterId: 'custom', name: id,
      cwd: '/project/repository', activity: 'idle', git: { branch: 'feature/maximize' } }));
    window.layout = JSON.parse(localStorage.getItem('layout')) || { order: ['first', 'second', 'third'], collapsed: ['third'], maximized: [],
      sizes: { first: { width: 480, height: 320 }, second: { width: 450, height: 290 }, third: { width: 480, height: 405 } },
      positions: { first: { col: 0, row: 0 }, second: { col: 0, row: 14 }, third: { col: 0, row: 27 } } };
    window.attached = [];
    window.writes = [];
    window.resizes = [];
    api.host.getWindowContext = async () => ({ id: 'fixture-window' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => window.layout;
    api.storage.getAdapterConfig = async () => ({});
    api.storage.saveLayout = async (owner, layout) => { window.savedLayout = JSON.parse(JSON.stringify(layout)); localStorage.setItem('layout', JSON.stringify(layout)); };
    api.sessions.recover = async () => ({ sessions: [], archives: [] });
    api.sessions.list = async () => ({ sessions: window.sessions });
    api.sessions.attachWindow = async () => {};
    api.sessions.attach = async (owner, id) => { window.attached.push(id); return { data: id + ' existing output', sequence: 0 }; };
    api.sessions.resize = async (owner, id, cols, rows) => { window.resizes.push({ id, cols, rows }); };
    api.sessions.write = async (owner, id, data) => { window.writes.push({ id, data }); };
    api.events.sessionsChanged = callback => { window.refreshSessions = callback; return () => {}; };
    await mountWorkspace(document.querySelector('main'), { pluginId, adapters: [{ id: 'custom', capabilities: {} }] });
    window.ready = true;`, resolveDir: repository, sourcefile: 'session-maximize-fixture.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main id="workspace"></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready && window.resizes.some(item => item.id === 'second'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(880, 720));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('button', { name: '最大化', exact: true }).count(), 3);
  const card = id => page.locator(`[data-session="${id}"]`);
  const geometry = () => page.locator('.session').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.session,
    left: node.style.left, top: node.style.top, width: node.style.width, height: node.style.height,
    actualWidth: node.offsetWidth, actualHeight: node.offsetHeight, collapsed: node.classList.contains('collapsed') })));
  // Long names and exit actions must leave the status centered and unobstructed.
  const assertStatusLayout = async () => {
    const bounds = await page.locator('.session:visible').evaluateAll(nodes => nodes.map(node => {
      const header = node.querySelector('.session-header').getBoundingClientRect();
      const icon = node.querySelector('.session-status').getBoundingClientRect();
      const name = node.querySelector('.session-name').getBoundingClientRect();
      const actions = node.querySelector('.card-actions').getBoundingClientRect();
      return { gap: Math.abs((icon.left + icon.right - header.left - header.right) / 2),
        clear: name.right <= icon.left && actions.left >= icon.right && actions.right <= header.right,
        header: header.width, icon: [icon.left, icon.right], name: name.right, actions: [actions.left, actions.right] };
    }));
    assert.ok(bounds.every(item => item.gap < 1 && item.clear), JSON.stringify(bounds));
  };
  await assertStatusLayout();
  const original = await geometry();
  const thirdHeight = await card('third').evaluate(node => node.style.getPropertyValue('--session-height'));
  const originalLayout = await page.evaluate(() => JSON.stringify({ ...window.savedLayout, maximized: [] }));
  await card('second').locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('draft');
  await page.waitForFunction(() => window.writes.filter(item => item.id === 'second').map(item => item.data).join('').includes('draft'));
  await page.evaluate(() => { window.retainedTerminal = document.querySelector('[data-session="second"] .xterm'); });
  const shots = resolve('plugin-dev/dist/verification/session-maximize');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(880, 720));
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      window.dispatchEvent(new CustomEvent('desk-theme', { detail: theme }));
    }, theme);
    await card('second').getByRole('button', { name: '最大化', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-session="second"]').classList.contains('maximized'));
    const restore = card('second').getByRole('button', { name: '恢复原大小', exact: true });
    assert.equal(await restore.getAttribute('title'), '恢复原大小');
    assert.equal(await restore.locator('svg').count(), 1);
    assert.equal(await card('second').getByRole('button', { name: '折叠', exact: true }).isDisabled(), true);
    assert.equal(await card('first').isVisible(), false);
    assert.equal(await card('third').isVisible(), false);
    for (const width of [880, 360]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width);
      await page.waitForFunction(() => {
        const node = document.querySelector('.session.maximized');
        const rect = node.getBoundingClientRect();
        return rect.x === 0 && rect.y === 0 && rect.width === innerWidth && rect.height === innerHeight;
      });
      await assertStatusLayout();
      assert.equal(await card('second').evaluate(node => getComputedStyle(node).resize), 'none');
      assert.equal(await card('second').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      await restore.focus();
      assert.equal(await restore.evaluate(node => node.matches(':focus-visible')), true);
      await page.screenshot({ path: join(shots, `${theme}-${width}.png`) });
    }
    // Status updates and browser resizing must not overwrite the stored normal geometry.
    await page.evaluate(() => {
      window.sessions[1].activity = 'working';
      window.refreshSessions({ sessions: window.sessions });
    });
    assert.equal(await page.evaluate(() => JSON.stringify({ ...window.savedLayout, maximized: [] })), originalLayout);
    assert.equal(await page.evaluate(() => window.retainedTerminal === document.querySelector('[data-session="second"] .xterm')), true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(880, 720));
    await restore.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.session.maximized'));
    assert.deepEqual(await geometry(), original);
    assert.equal(await card('first').isVisible(), true);
    assert.equal(await card('second').getByRole('button', { name: '折叠', exact: true }).isDisabled(), false);
  }
  assert.deepEqual(await page.evaluate(() => window.attached), ['first', 'second', 'third']);
  await card('third').getByRole('button', { name: '最大化', exact: true }).click();
  assert.equal(await card('third').locator('.terminal-mount').isVisible(), true);
  await card('third').getByRole('button', { name: '恢复原大小', exact: true }).click();
  assert.deepEqual(await geometry(), original);
  // Removing the maximized session releases the workspace and keeps surviving sessions in place.
  await card('second').getByRole('button', { name: '最大化', exact: true }).click();
  await page.evaluate(() => {
    window.sessions = window.sessions.filter(session => session.id !== 'second');
    window.refreshSessions({ sessions: window.sessions });
  });
  assert.equal(await page.locator('.session.maximized').count(), 0);
  assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).overflow), 'auto');
  assert.equal(await card('first').isVisible(), true);
  assert.equal(await card('third').isVisible(), true);
  const remaining = await geometry();
  assert.deepEqual(remaining.map(({ top, ...item }) => item), original.filter(item => item.id !== 'second').map(({ top, ...item }) => item));
  assert.ok(parseFloat(remaining[1].top) >= remaining[0].actualHeight);
  assert.ok(parseFloat(remaining[1].top) <= parseFloat(original[2].top));
  assert.equal(await page.evaluate(() => window.savedLayout.sizes.second.height), 290);
  // Reopening creates new runtime IDs, while the normal geometry and both presentation states must survive.
  await card('first').getByRole('button', { name: '折叠', exact: true }).click();
  await page.evaluate(() => {
    document.querySelector('[data-session="third"] button[aria-label="最大化"]').click();
    localStorage.setItem('generation', '1');
  });
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await card('first-1').evaluate(node => node.classList.contains('collapsed')), true);
  assert.equal(await card('third-1').evaluate(node => node.classList.contains('maximized')), true);
  assert.equal(await card('third-1').getByRole('button', { name: '恢复原大小', exact: true }).count(), 1);
  await card('third-1').getByRole('button', { name: '恢复原大小', exact: true }).click();
  assert.equal(await card('third-1').evaluate(node => node.classList.contains('collapsed')), true);
  assert.equal(await card('third-1').evaluate(node => node.style.getPropertyValue('--session-height')), thirdHeight);
  assert.equal(await card('second-1').evaluate(node => node.offsetHeight), original[1].actualHeight);
  assert.equal(await card('first-1').evaluate(node => node.style.top), '0px');
  // A second restart must use the same stable history identity, including a maximized expanded card.
  await card('third-1').getByRole('button', { name: '展开', exact: true }).click();
  await card('third-1').getByRole('button', { name: '最大化', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('generation', '2'));
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await card('third-2').evaluate(node => node.classList.contains('maximized')), true);
  await card('third-2').getByRole('button', { name: '恢复原大小', exact: true }).click();
  assert.equal(await card('third-2').evaluate(node => node.classList.contains('collapsed')), false);
  assert.equal(await card('third-2').evaluate(node => node.style.getPropertyValue('--session-height')), thirdHeight);
  assert.equal(await card('first-2').evaluate(node => node.classList.contains('collapsed')), true);
  assert.equal(await card('second-2').evaluate(node => node.offsetWidth), original[1].actualWidth);
  await page.evaluate(() => {
    Object.assign(window.sessions[0], { name: '很长的会话名称用于验证水壶居中以及按钮不重叠', exited: true });
    window.refreshSessions({ sessions: window.sessions });
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(320, 720));
  await assertStatusLayout();

});
