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

test('footer shows the branch and opens an anchored popup with grouped refs in both themes', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-branches-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import '@xterm/xterm/css/xterm.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    import { showGitBranches } from './plugin-dev/ai-agent/src/renderer/git-branches.js';
    window.switched = [];
    window.info = { root: '/project/repository', branch: 'wj/channel/ve-prod', detached: false,
      branches: ['dev', 'feature/one', 'feature/two', 've-prod', 'wj/channel/ar-prod', 'wj/channel/ve-prod',
        'wj/channel/a-very-long-branch-name-to-check-the-narrow-window-layout', 'wj/other/test', 'wj-other'] };
    // Exercise the real workspace and terminal; only the host RPC boundary is replaced.
    window.postMessage = () => {};
    const pluginId = 'ai-agent-sessions';
    window.session = { id: 'branch-session', pluginId, adapterId: 'custom', name: '分支验证', cwd: window.info.root,
      activity: 'idle', git: { branch: window.info.branch } };
    api.host.getWindowContext = async () => ({ id: 'fixture-window' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => ({});
    api.storage.getAdapterConfig = async () => ({});
    api.storage.saveLayout = async () => {};
    api.sessions.recover = async () => ({ sessions: [], archives: [] });
    api.sessions.list = async () => ({ sessions: [window.session] });
    api.sessions.attachWindow = async () => {};
    api.sessions.attach = async () => ({ data: '分支入口验证', sequence: 0 });
    api.sessions.resize = async () => {};
    api.sessions.gitInfo = async () => {
      document.querySelector('.xterm-helper-textarea').focus();
      return window.info;
    };
    api.sessions.refreshGit = async () => {
      if (window.failRefresh) { throw Error('刷新失败：无法连接远端'); }
      if (window.holdRefresh) { await new Promise(resolve => { window.releaseRefresh = resolve; }); }
      return { ...window.info, branches: [...window.info.branches, 'new-remote-branch'] };
    };
    api.events.sessionsChanged = callback => { window.refreshSessions = callback; return () => {}; };
    api.sessions.switchBranch = async (owner, id, branch) => {
      if (window.failSwitch) { throw Error('切换失败：存在本地修改'); }
      if (window.holdSwitch) { await new Promise(resolve => { window.releaseSwitch = resolve; }); }
      window.switched.push(branch);
    };
    await mountWorkspace(document.querySelector('main'), { pluginId, adapters: [{ id: 'custom', capabilities: {} }] });
    window.openGit = info => showGitBranches(info || window.info,
      { switchBranch: branch => api.sessions.switchBranch(pluginId, window.session.id, branch),
        refresh: () => api.sessions.refreshGit(pluginId, window.session.id) }, document.querySelector('.branch'));
    window.ready = true;`, resolveDir: repository, sourcefile: 'git-branches-fixture.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main id="workspace"></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready);
  const resize = async (width, height = 720) => {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
    // Native resize and popup placement are delivered on renderer frames after setContentSize returns.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const trigger = page.locator('.session-footer .branch');
  assert.equal(await trigger.innerText(), 'wj/channel/ve-prod');
  assert.equal(await trigger.locator('svg').count(), 1);
  assert.equal(await trigger.evaluate(node => node.clientWidth > 50 && node.scrollWidth <= node.clientWidth), true);
  // The active terminal may reclaim focus during async Git discovery; placement still follows the clicked name.
  await trigger.getByText('wj/channel/ve-prod', { exact: true }).click();
  await page.getByRole('group', { name: 'Git 分支', exact: true }).waitFor();
  const panel = page.locator('dialog.desk-popup').first();
  assert.equal(await panel.evaluate(node => node.matches(':popover-open') && !node.matches(':modal')), true);
  assert.equal(await panel.evaluate(node => getComputedStyle(node, '::backdrop').backdropFilter), 'none');
  const anchor = await trigger.boundingBox();
  const popup = await panel.boundingBox();
  assert.ok(popup.x >= anchor.x + anchor.width + 7);
  assert.equal(await panel.evaluate(node => getComputedStyle(node).borderRadius), '12px');
  const folder = name => page.locator('summary').filter({ hasText: new RegExp(`^${name}$`) });
  assert.equal(await folder('wj').evaluate(node => node.parentElement.open), true);
  assert.equal(await folder('channel').evaluate(node => node.parentElement.open), true);
  assert.equal(await folder('feature').evaluate(node => node.parentElement.open), false);
  assert.equal(await page.getByRole('button', { name: 'wj-other', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'wj/channel/ve-prod（当前分支）', exact: true }).getAttribute('aria-pressed'), 'true');
  await folder('feature').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'feature/two', exact: true }).waitFor();
  const refresh = panel.getByRole('button', { name: '刷新分支', exact: true });
  assert.equal(await refresh.count(), 1);
  assert.equal(await refresh.locator('svg').count(), 1);
  assert.equal(await refresh.getAttribute('title'), '刷新分支');
  const refreshBounds = await refresh.boundingBox();
  const closeBounds = await panel.getByRole('button', { name: '关闭', exact: true }).boundingBox();
  assert.ok(refreshBounds.x + refreshBounds.width <= closeBounds.x);
  assert.ok(closeBounds.x - refreshBounds.x - refreshBounds.width <= 9, 'refresh stays next to close');
  await page.evaluate(() => { window.holdRefresh = true; });
  await refresh.click();
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await refresh.getAttribute('aria-busy'), 'true');
  assert.equal(await page.getByRole('button', { name: 'new-remote-branch', exact: true }).count(), 0);
  await page.evaluate(() => { window.releaseRefresh(); window.holdRefresh = false; });
  await page.getByRole('button', { name: 'new-remote-branch', exact: true }).waitFor();
  assert.equal(await refresh.isEnabled(), true);
  assert.equal(await folder('feature').evaluate(node => node.parentElement.open), true);
  assert.equal(await folder('wj').evaluate(node => node.parentElement.open), true);
  await page.evaluate(() => { window.failRefresh = true; });
  await refresh.click();
  await page.getByText('刷新失败：无法连接远端', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'new-remote-branch', exact: true }).isVisible(), true);
  assert.equal(await refresh.isEnabled(), true);
  await page.evaluate(() => { window.failRefresh = false; document.querySelector('#toast').hidden = true; });
  await resize(1100);
  await page.getByRole('button', { name: 'feature/two', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'feature/two', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.evaluate(() => window.switched), []);
  const branchAction = page.locator('.git-branch-action');
  assert.equal(await branchAction.count(), 1, 'selecting a branch opens its own compact action popup');
  const selectedRow = await page.getByRole('button', { name: 'feature/two', exact: true }).boundingBox();
  const actionBounds = await branchAction.boundingBox();
  assert.ok(actionBounds.x >= selectedRow.x + selectedRow.width + 7, 'actions open to the selected row’s right');
  assert.ok(actionBounds.height < 340);
  assert.equal(await branchAction.evaluate(node => getComputedStyle(node, '::backdrop').backdropFilter), 'none');
  await page.keyboard.press('Escape');
  await branchAction.waitFor({ state: 'detached' });
  assert.equal(await panel.isVisible(), true);
  await folder('feature').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'feature/two', exact: true }).isVisible(), false);
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'feature/two', exact: true }).getAttribute('aria-pressed'), 'true');
  const shots = join(repository, 'plugin-dev/dist/verification/git-branches');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [320, 640]) {
      await resize(width);
      assert.equal(await page.locator('.git-branches-dialog').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return node.scrollWidth <= node.clientWidth && bounds.left >= 8 && bounds.right <= innerWidth - 7;
      }), true);
      assert.equal(await page.locator('.git-branches').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      await folder('wj').focus();
      assert.equal(await folder('wj').evaluate(node => node.matches(':focus-visible')), true);
      await page.screenshot({ animations: 'disabled', path: join(shots, `${theme}-${width}.png`) });
    }
  }
  // At the right edge, the same public popup moves to the left of the trigger.
  await resize(1000);
  await page.keyboard.press('Escape');
  await page.locator('.git-branches-dialog').waitFor({ state: 'detached' });
  await trigger.evaluate(node => { node.style.position = 'fixed'; node.style.right = '8px'; node.style.top = '100px'; });
  await trigger.click();
  await panel.waitFor();
  const rightAnchor = await trigger.boundingBox();
  const leftPopup = await panel.boundingBox();
  assert.ok(leftPopup.x + leftPopup.width <= rightAnchor.x - 7);
  await page.getByRole('button', { name: 'wj/channel/ar-prod', exact: true }).click();
  const edgeRow = await page.getByRole('button', { name: 'wj/channel/ar-prod', exact: true }).boundingBox();
  const edgeAction = await branchAction.boundingBox();
  assert.ok(edgeAction.x + edgeAction.width <= edgeRow.x - 7, 'actions flip left near the right edge');
  await page.getByRole('button', { name: 'wj/channel/ve-prod（当前分支）', exact: true }).click();
  assert.equal(await branchAction.count(), 1);
  assert.equal(await branchAction.getByText('切换到 wj/channel/ve-prod？', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'wj/channel/ar-prod', exact: true }).click();
  await page.evaluate(() => { window.failSwitch = true; });
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await page.getByText('切换失败：存在本地修改', { exact: true }).waitFor();
  assert.equal(await page.locator('.git-branches-dialog').isVisible(), true);
  await page.evaluate(() => { window.failSwitch = false; window.holdSwitch = true; });
  await page.getByRole('button', { name: '切换', exact: true }).click();
  assert.equal(await branchAction.getByRole('button', { name: '切换', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.releaseSwitch(); window.holdSwitch = false; });
  await page.locator('.git-branches-dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.switched), ['wj/channel/ar-prod']);
  await page.evaluate(() => { window.openGit({ ...window.info, branch: '', detached: true }); });
  assert.equal(await page.getByRole('button', { name: 'dev', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  await page.locator('.git-branches-dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement === document.querySelector('.branch'));
  await page.evaluate(() => { window.openGit({ ...window.info, branch: '', detached: true, branches: [] }); });
  assert.equal(await page.getByText('暂无可切换的分支', { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '切换', exact: true }).count(), 0);
  await page.locator('.session-name').click();
  await page.locator('.git-branches-dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.switched), ['wj/channel/ar-prod']);
  // A long tree scrolls without moving the heading or hiding branch actions below the viewport.
  await resize(1100, 480);
  await trigger.evaluate(node => { node.style.position = ''; node.style.right = ''; node.style.top = ''; });
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; window.openGit({ ...window.info, branches: Array.from({ length: 100 }, (_, i) => `branch-${i}`) }); });
  const lastBranch = page.getByRole('button', { name: 'branch-99', exact: true });
  await lastBranch.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.git-branches').evaluate(node => node.scrollTop > 0 && node.scrollHeight > node.clientHeight), true);
  await lastBranch.click();
  assert.equal(await branchAction.getByRole('button', { name: '切换', exact: true }).isVisible(), true);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1100, 320]) {
      await resize(width, 480);
      assert.equal(await branchAction.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.left >= 8 && bounds.right <= innerWidth - 7 && bounds.top >= 8 && bounds.bottom <= innerHeight - 7
          && node.scrollWidth <= node.clientWidth;
      }), true);
      await page.keyboard.press('Tab');
      await branchAction.getByRole('button', { name: '切换', exact: true }).focus();
      assert.equal(await branchAction.getByRole('button', { name: '切换', exact: true }).evaluate(node => node.matches(':focus-visible')), true);
      await page.screenshot({ animations: 'disabled', path: join(shots, `branch-action-${theme}-${width}.png`) });
    }
  }
  // Clicking the parent only dismisses the child; another outside click dismisses the parent.
  await panel.locator(':scope > form > .dialog-heading h2').click();
  await branchAction.waitFor({ state: 'detached' });
  assert.equal(await panel.isVisible(), true);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.switched), ['wj/channel/ar-prod']);
  await page.evaluate(() => {
    window.session.git = { branch: '', commit: '1234567890abcdef' };
    window.refreshSessions({ sessions: [window.session] });
  });
  assert.equal(await trigger.innerText(), '1234567');
  await page.evaluate(() => {
    window.session.git = { branch: 'wj/channel/a-very-long-branch-name-to-check-the-narrow-window-layout' };
    window.refreshSessions({ sessions: [window.session] });
  });
  assert.equal(await trigger.getAttribute('title'), 'Git · wj/channel/a-very-long-branch-name-to-check-the-narrow-window-layout');
  assert.equal(await trigger.locator('.branch-name').evaluate(node => node.scrollWidth > node.clientWidth), true);
  await page.evaluate(() => {
    window.session.git = null;
    window.refreshSessions({ sessions: [window.session] });
  });
  assert.equal(await trigger.innerText(), 'Git');
});
