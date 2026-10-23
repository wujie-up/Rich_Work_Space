import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, owner, configure, create, output, alive, openConfiguration } from './helpers.js';

test('desktop: confirmed disable retries transient plugin busy and reports persistent contention', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { app, page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('work-desk:invoke');
    let busy = true;
    ipcMain._invokeHandlers.set('work-desk:invoke', async (event, method, args) => {
      // Reproduce the transient lock after the user has confirmed the snapshot.
      if (method === 'plugins.disable' && busy) {
        busy = false;
        return { ok: false, error: { code: 'PLUGIN_BUSY', message: '插件正在创建任务或执行操作' } };
      }
      return original(event, method, args);
    });
  });
  await openConfiguration(page);
  const card = page.locator(`.plugin-card[data-plugin="${owner}"]`);
  await card.getByRole('button', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await card.getByRole('button', { name: '启用', exact: true }).waitFor({ timeout: 5000 });
  const record = await page.evaluate((owner) => workDesk.plugins.list().then((records) => records.find((record) => record.id === owner)), owner);
  assert.equal(record.state, 'disabled');
  assert.equal(record.lastError, null);
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await card.getByRole('button', { name: '禁用', exact: true }).waitFor();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('work-desk:invoke');
    ipcMain._invokeHandlers.set('work-desk:invoke', (event, method, args) => method === 'plugins.disable'
      ? { ok: false, error: { code: 'PLUGIN_BUSY', message: '插件正在创建任务或执行操作' } } : original(event, method, args));
  });
  await card.getByRole('button', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await page.locator('#toast').filter({ hasText: '插件正在创建任务或执行操作' }).waitFor();
  assert.equal(await page.evaluate((owner) => workDesk.plugins.list().then((records) => records.find((record) => record.id === owner).state), owner), 'enabled');
});

test('desktop: blank desktop, shelf icons, context menus, configuration and drag to open preserve plugin data', { timeout: 120000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  await page.locator('.desktop-surface').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('aside, #navigation').count(), 0);
  const icon = page.locator(`.shelf-app[data-plugin="${owner}"]`);
  await icon.waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.workspace-label').textContent(), '本地工作空间');
  await mkdir(resolve('.test-results'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/desktop-applications.png') });
  await page.locator('.desktop-surface').click({ button: 'right', position: { x: 600, y: 300 } });
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['添加插件']);
  await page.getByRole('menuitem', { name: '添加插件', exact: true }).click();
  await page.getByRole('heading', { name: '插件中心', exact: true }).waitFor();
  await page.screenshot({ path: resolve('.test-results/desktop-configuration.png') });
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await icon.click();
  await page.frameLocator('iframe:visible').locator('.workspace-tools').waitFor();
  await configure(page);
  const session = await create(page, '桌面切换保留任务');
  await output(page, session.id, 'READY 中文');
  await page.locator('#desktop').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.application-window')].every((node) => node.dataset.phase === 'minimized'));
  assert.equal(alive(session.pid), true);
  await openConfiguration(page);
  await page.locator('#theme-settings').click();
  await page.locator('#theme').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('#plugin-center').click();
  const card = page.locator(`.plugin-card[data-plugin="${owner}"]`);
  await page.evaluate(() => {
    window.pluginDrop = null;
    window.dragTrace = [];
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
      document.addEventListener(type, (event) => window.dragTrace.push({ type, target: event.target.className, x: event.clientX, y: event.clientY }), { capture: true });
    }
    document.addEventListener('drop', (event) => {
      window.pluginDrop = event.dataTransfer.getData('application/x-work-desk-plugin');
    }, { capture: true, once: true });
  });
  await card.hover();
  await card.dragTo(page.locator('.desktop-surface'), { sourcePosition: { x: 20, y: 20 }, targetPosition: { x: 100, y: 320 } });
  assert.equal(await page.evaluate(() => window.pluginDrop), owner, JSON.stringify(await page.evaluate(() => window.dragTrace)));
  await page.frameLocator('iframe:visible').locator('.workspace-tools').waitFor();
  assert.equal(await page.locator('iframe').count(), 2);
  assert.equal(await page.locator('#settings-panel').count(), 0);
  assert.equal((await page.evaluate((id) => agentDesk.sessions.list(id), owner)).sessions[0].pid, session.pid);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: session.id });
  await page.locator('#desktop').click();
  await openConfiguration(page);
  await card.getByRole('button', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await card.getByRole('button', { name: '启用', exact: true }).waitFor().catch(async (error) => {
    console.log('DISABLE_STATE', await page.evaluate(async () => ({ plugins: await workDesk.plugins.list(), toast: document.querySelector('#toast').textContent, panel: document.querySelector('#settings-panel')?.textContent })));
    throw error;
  });
  assert.equal(await icon.getAttribute('data-enabled'), null);
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await card.getByRole('button', { name: '禁用', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await icon.count(), 1);
  assert.match((await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id })).output, /READY 中文/);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.reload();
  await icon.waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
});


test('desktop: grid windows, bubbles and reversible motion retain live plugin views', { timeout: 120000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const icon = page.locator(`.shelf-app[data-plugin="${owner}"]`);
  await icon.click();
  const first = page.locator('iframe').first();
  await first.contentFrame().locator('.workspace-tools').waitFor();
  await first.contentFrame().locator('.workspace-tools').evaluate((node) => { node.dataset.retained = 'first-window'; });
  await configure(page);
  const session = await create(page, '气泡窗口保留任务');
  await output(page, session.id, 'READY 中文');
  const win = page.locator('.application-window').first();
  assert.equal(await win.getAttribute('data-mode'), 'normal');
  assert.equal(await page.locator('#dock').count(), 0);
  const initial = await win.boundingBox();
  await openConfiguration(page);
  const bounds = await page.locator('#settings-panel').boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) < 2);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2);
  await page.getByRole('button', { name: '列表展示', exact: true }).click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'list');
  await page.locator('#desktop-settings').click();
  await page.getByLabel('网格大小').selectOption('32');
  await page.waitForFunction(() => document.querySelector('#content').style.getPropertyValue('--grid-size') === '32px');
  await page.locator('#theme-settings').click();
  await page.locator('#theme').click();
  assert.equal((await page.evaluate(() => workDesk.storage.getPreferences())).gridSize, 32);
  await page.locator('#plugin-center').click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'list');
  await page.getByRole('button', { name: '图框展示', exact: true }).click();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  const header = await win.locator('.window-title').boundingBox();
  await page.mouse.move(header.x + 100, header.y + 16);
  await page.mouse.down();
  await page.mouse.move(header.x + 157, header.y + 51, { steps: 6 });
  await page.mouse.up();
  const moved = await win.boundingBox();
  const stage = await page.locator('#content').boundingBox();
  assert.equal((moved.x - stage.x) % 32, 0);
  assert.equal((moved.y - stage.y) % 32, 0);
  assert.notEqual(moved.x, initial.x);
  const resize = await win.locator('.window-resize').boundingBox();
  await page.mouse.move(resize.x + 5, resize.y + 5);
  await page.mouse.down();
  await page.mouse.move(resize.x - 72, resize.y - 48, { steps: 6 });
  await page.mouse.up();
  const normal = await win.boundingBox();
  assert.equal(normal.width % 32, 0);
  assert.equal(normal.height % 32, 0);
  await win.getByRole('button', { name: '平铺到桌面', exact: true }).click();
  assert.equal(await win.getAttribute('data-mode'), 'flat');
  assert.deepEqual(await win.boundingBox(), stage);
  await page.locator('#desktop').click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'minimized');
  const bubble = page.locator('.session-bubble').first();
  await bubble.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  assert.equal((await bubble.boundingBox()).width, 44);
  assert.equal(await first.isVisible(), false);
  assert.equal(await page.locator('#desktop').isVisible(), false);
  await icon.click();
  await page.locator('iframe').nth(1).contentFrame().locator('.workspace-tools').waitFor();
  await bubble.click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'open');
  assert.equal(await first.isVisible(), true);
  assert.equal(await win.getAttribute('data-mode'), 'flat');
  await win.getByRole('button', { name: '普通窗口', exact: true }).click();
  assert.deepEqual(await win.boundingBox(), normal);
  assert.equal(await page.locator('iframe:visible').count(), 2);
  assert.equal(await first.contentFrame().locator('.workspace-tools').getAttribute('data-retained'), 'first-window');
  assert.equal(alive(session.pid), true);
  await page.locator('#desktop').click();
  // Reverse while the window is still travelling, then minimize again before restoration finishes.
  await page.locator('.session-bubble').first().click();
  await page.locator('#desktop').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.application-window')].every((node) => node.dataset.phase === 'minimized'));
  assert.equal(await page.locator('.session-bubble').count(), 2);
  await page.screenshot({ path: resolve('.test-results/desktop-bubbles.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bubble.click();
  assert.equal(await win.getAttribute('data-phase'), 'open');
  assert.deepEqual(await win.boundingBox(), normal);
  await page.screenshot({ path: resolve('.test-results/desktop-windows.png') });
  await page.locator('#desktop').click();
  await bubble.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('heading', { name: '关闭插件', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 2);
  assert.equal(alive(session.pid), true);
  await page.getByRole('button', { name: '关闭插件', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('iframe'));
  await openConfiguration(page);
  const card = page.locator(`.plugin-card[data-plugin="${owner}"]`);
  await card.getByRole('button', { name: '启用', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.session-bubble').count(), 0);
  assert.equal(alive(session.pid), false);
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await card.getByRole('button', { name: '禁用', exact: true }).waitFor();
  assert.match((await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id })).output, /READY 中文/);
  await page.reload();
  await icon.waitFor();
  assert.equal((await page.evaluate(() => workDesk.storage.getPreferences())).gridSize, 32);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.deepEqual(errors, []);
});


test('desktop: bubble motion lands on its final rail position and windows stay inside a resized desktop', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { app, page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  const landing = await page.evaluate(() => {
    document.querySelector('#desktop').click();
    const root = document.querySelector('.application-window');
    const slot = document.querySelector('.bubble-slot');
    const animation = root.getAnimations()[0];
    const end = new DOMMatrix(animation.effect.getKeyframes().at(-1).transform);
    const stage = document.querySelector('#content').getBoundingClientRect();
    const targetY = document.querySelector('.bubble-rail').getBoundingClientRect().y + slot.offsetTop;
    animation.currentTime = 320;
    return { landingY: stage.y + root.offsetTop + end.f, targetY, width: root.getBoundingClientRect().width,
      originalWidth: root.offsetWidth, phase: root.dataset.phase };
  });
  assert.ok(Math.abs(landing.landingY - landing.targetY) < 1, JSON.stringify(landing));
  assert.ok(landing.width > 44 && landing.width < landing.originalWidth);
  assert.equal(landing.phase, 'minimizing');
  await page.locator('.session-bubble').click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'open');
  const bounds = await page.locator('.application-window').boundingBox();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.application-window').getByRole('button', { name: '最小化', exact: true }).click();
  assert.equal(await page.locator('.application-window').getAttribute('data-phase'), 'minimized');
  await page.locator('.session-bubble').click();
  assert.deepEqual(await page.locator('.application-window').boundingBox(), bounds);
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(480, 420); win.setSize(520, 460); });
  await page.waitForFunction(() => {
    const window = document.querySelector('.application-window').getBoundingClientRect();
    const stage = document.querySelector('#content').getBoundingClientRect();
    return innerWidth === 520 && window.right <= stage.right && window.bottom <= stage.bottom;
  });
  const small = await page.locator('.application-window').boundingBox();
  const stage = await page.locator('#content').boundingBox();
  assert.ok(small.x >= stage.x && small.y >= stage.y);
  assert.ok(small.x + small.width <= stage.x + stage.width && small.y + small.height <= stage.y + stage.height);
  await page.locator('.window-title').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(((await page.locator('.application-window').boundingBox()).x - stage.x) % 24, 0);
  await page.locator('.window-resize').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal((await page.locator('.application-window').boundingBox()).height % 24, 0);
  await page.screenshot({ path: resolve('.test-results/desktop-narrow.png') });
});


test('desktop: clicking an exposed plugin frame raises its containing window', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { app, page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  await page.locator('#desktop').click();
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  await page.locator('iframe').nth(1).contentFrame().locator('.workspace-tools').waitFor();
  await page.locator('.session-bubble[data-window="1"]').click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'open');
  const declarations = await app.evaluate(async ({ BrowserWindow }) => {
    const frames = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.filter((frame) => frame.url.startsWith('desk-plugin:'));
    return Promise.all(frames.map((frame) => frame.executeJavaScript('const activate = 1; activate')));
  });
  assert.deepEqual(declarations, [1, 1], 'Host focus listeners must not reserve plugin global names');
  for (const index of [1, 0, 1, 0]) {
    const frame = await page.locator('iframe').nth(index).boundingBox();
    await page.mouse.click(index ? frame.x + frame.width - 8 : frame.x + 8, frame.y + 100);
    await page.waitForFunction((index) => document.querySelectorAll('.application-window')[index].classList.contains('focused'), index);
    assert.equal(await page.locator('.application-window.focused').getAttribute('data-window'), String(index + 1));
  }
});


test('desktop: window and complete bubble decoration crossfade without a residual left edge', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  const inspect = (phase) => page.evaluate((phase) => {
    const root = document.querySelector('.application-window');
    const slot = document.querySelector('.bubble-slot');
    const bubble = document.querySelector('.session-bubble');
    if (phase === 'minimizing') {
      root.querySelector('[aria-label="最小化"]').click();
    } else {
      bubble.click();
    }
    const motion = root.getAnimations()[0];
    motion.pause();
    // All participating effects share elapsed time, so inspect the rendered handoff rather than waiting on wall time.
    const seek = (progress) => {
      const elapsed = motion.effect.getTiming().duration * progress;
      for (const node of [root, root.querySelector('.window-body'), slot, bubble]) {
        for (const animation of node.getAnimations()) {
          animation.pause();
          animation.currentTime = elapsed;
        }
      }
      return { slotOpacity: Number(getComputedStyle(slot).opacity), bubbleOpacity: Number(getComputedStyle(bubble).opacity),
        windowOpacity: Number(getComputedStyle(root).opacity) };
    };
    const early = seek(.15);
    const late = seek(.9);
    return { phase: root.dataset.phase, early, late, bubbleWidth: bubble.offsetWidth,
      properties: motion.effect.getKeyframes().flatMap((key) => Object.keys(key)) };
  }, phase);
  const minimize = await inspect('minimizing');
  assert.equal(minimize.phase, 'minimizing');
  assert.equal(minimize.early.slotOpacity, 0, 'The attachment and satellites must stay invisible before the window reaches the rail');
  assert.ok(minimize.late.slotOpacity > .5, 'The whole bubble must fade in during arrival, rather than appearing after it');
  assert.ok(minimize.late.windowOpacity < .5);
  assert.equal(minimize.bubbleWidth, 44);
  assert.equal(minimize.properties.includes('borderRadius'), false, 'Window travel must not repaint its clipping radius every frame');
  await page.evaluate(() => document.querySelector('.application-window').getAnimations()[0].finish());
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'minimized');
  const restore = await inspect('restoring');
  assert.equal(restore.phase, 'restoring');
  assert.equal(restore.late.slotOpacity, 0, 'No attachment may remain while the restored window is expanded');
  assert.ok(restore.late.windowOpacity > .9);
  await page.evaluate(() => document.querySelector('.application-window').getAnimations()[0].finish());
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'open');
  assert.equal(await page.locator('.session-bubble').isVisible(), false);
  assert.equal(await page.locator('iframe:visible').count(), 1);
});


test('desktop: hovered bubbles keep a clean contour without an exposed attachment edge', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  await page.locator('#desktop').click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'minimized');
  const bubble = page.locator('.session-bubble');
  const contour = await bubble.evaluate((node) => getComputedStyle(node).borderRadius);
  await bubble.hover();
  await bubble.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const hovered = await bubble.evaluate((node) => ({ contour: getComputedStyle(node).borderRadius,
    attachment: getComputedStyle(node.parentElement, '::before').content, width: node.offsetWidth }));
  assert.equal(hovered.attachment, 'none', 'The bubble already touches the edge; a second outlined bridge exposes a horizontal seam on hover');
  assert.equal(hovered.contour, contour);
  assert.equal(hovered.width, 44);
});


test('desktop: complete window content scales progressively in both directions', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {}) });
  for (const action of ['minimize', 'restore']) {
    const samples = await page.evaluate((action) => {
      const root = document.querySelector('.application-window');
      if (action === 'minimize') { root.querySelector('[aria-label="最小化"]').click(); }
      else { document.querySelector('.session-bubble').click(); }
      const motion = root.getAnimations()[0];
      const effects = [root, root.querySelector('.window-body'), document.querySelector('.bubble-slot')]
        .flatMap((node) => node.getAnimations());
      effects.forEach((animation) => animation.pause());
      // Inspect geometry across equal time intervals, independent of the machine's frame scheduling.
      return [0, .25, .5, .75, 1].map((progress) => {
        effects.forEach((animation) => { animation.currentTime = motion.effect.getTiming().duration * progress; });
        return { width: root.getBoundingClientRect().width, bodyOpacity: Number(getComputedStyle(root.querySelector('.window-body')).opacity) };
      });
    }, action);
    const progress = samples.map((sample) => (sample.width - samples[0].width) / (samples.at(-1).width - samples[0].width));
    assert.ok(progress[1] > .05 && progress[1] < .3);
    assert.ok(Math.abs(progress[2] - .5) < .06, 'Halfway through the motion the window must be halfway through its scale');
    assert.ok(progress[3] > .7 && progress[3] < .95);
    assert.ok(samples.every((sample) => sample.bodyOpacity === 1), 'Content must scale with its window instead of becoming an empty shell');
    await page.evaluate(() => document.querySelector('.application-window').getAnimations()[0].finish());
    await page.waitForFunction((phase) => document.querySelector('.application-window').dataset.phase === phase,
      action === 'minimize' ? 'minimized' : 'open');
  }
  assert.equal(await page.locator('iframe:visible').count(), 1);
});

test('desktop: closing a plugin shell confirms before stopping its processes and all windows', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk') } : {}) });
  await configure(page, { child: true });
  const session = await create(page, '外壳关闭归档');
  const snapshot = await output(page, session.id, /CHILD=(\d+)/);
  const childPid = Number(snapshot.data.match(/CHILD=(\d+)/)[1]);
  const backendPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(session.pid)], { encoding: 'utf8' }).trim());
  assert.match(execFileSync('ps', ['-o', 'command=', '-p', String(backendPid)], { encoding: 'utf8' }), /plugin-worker\.js/);
  await page.locator('#desktop').click();
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  const close = page.locator('.application-window[data-window="2"] [aria-label="关闭窗口"]');
  await close.click();
  await page.getByRole('heading', { name: '关闭插件', exact: true }).waitFor({ timeout: 4000 });
  assert.equal(alive(session.pid), true);
  assert.equal(alive(childPid), true);
  assert.equal(alive(backendPid), true);
  assert.equal(await page.locator('iframe').count(), 2);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 2);
  assert.equal(alive(session.pid), true);
  await close.click();
  await page.getByRole('button', { name: '关闭插件', exact: true }).click();
  await page.waitForFunction(async (owner) => {
    const plugin = (await workDesk.plugins.list()).find(plugin => plugin.id === owner);
    return plugin.state === 'disabled' && !plugin.operation && !document.querySelector('iframe');
  }, owner);
  // The lifecycle response can precede the OS child-process exit notification.
  for (let attempt = 0; attempt < 60 && [session.pid, childPid, backendPid].some(alive); attempt++) {
    await delay(50);
  }
  assert.equal(alive(session.pid), false);
  assert.equal(alive(childPid), false);
  assert.equal(alive(backendPid), false);
  assert.equal(await page.locator('.session-bubble').count(), 0);
  await page.evaluate(owner => workDesk.plugins.enable(owner), owner);
  const archived = await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id });
  assert.match(archived.output, /READY 中文/);
});

test('desktop: collapsible installed plugin shelf opens enabled apps and retains disabled entries', { timeout: 60000 }, async (t) => {
  const packaged = process.env.WORK_DESK_PACKAGED === '1';
  const { page } = await launch(t, { openPlugin: false, ...(packaged
    ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk') } : {}) });
  const shelf = page.getByRole('navigation', { name: '已安装插件' });
  const entry = shelf.locator(`[data-plugin="${owner}"]`);
  await entry.waitFor({ timeout: 4000 });
  await entry.click();
  await page.locator('iframe').contentFrame().locator('.workspace-tools').waitFor();
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  assert.equal(await shelf.isVisible(), false);
  await page.getByRole('button', { name: '显示插件栏', exact: true }).click();
  await openConfiguration(page);
  await page.locator(`.plugin-card[data-plugin="${owner}"]`).getByRole('button', { name: '禁用', exact: true }).click();
  await page.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await page.locator(`.plugin-card[data-plugin="${owner}"]`).getByRole('button', { name: '启用', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await entry.count(), 1);
  await entry.click();
  await page.getByRole('heading', { name: '插件中心', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
});


test('desktop: shelf edge reveals on hover and dragging preserves width without collapsing', { timeout: 60000 }, async (t) => {
  const { page } = await launch(t, { openPlugin: false });
  const toggle = page.getByRole('button', { name: '隐藏插件栏', exact: true });
  const shelf = page.locator('#plugin-shelf');
  const initial = await toggle.boundingBox();
  await page.mouse.move(initial.x + 7, initial.y + initial.height / 2);
  await page.mouse.down();
  await page.mouse.move(initial.x + 143, initial.y + initial.height / 2, { steps: 12 });
  await page.mouse.up();
  assert.equal(await shelf.isVisible(), true);
  assert.equal(Math.round((await shelf.boundingBox()).width), 200);
  assert.equal(await page.locator('#content').evaluate((node) => node.offsetLeft), 200);
  await toggle.click();
  const edge = page.getByRole('button', { name: '显示插件栏', exact: true });
  await page.mouse.move(400, 200);
  await page.waitForTimeout(200);
  assert.equal(await edge.evaluate((node) => getComputedStyle(node, '::after').opacity), '0');
  await edge.hover();
  await page.waitForTimeout(200);
  assert.equal(await edge.evaluate((node) => getComputedStyle(node, '::after').opacity), '1');
  await edge.click();
  assert.equal(Math.round((await shelf.boundingBox()).width), 200);
  await page.reload();
  await page.locator('.shelf-app').first().waitFor();
  assert.equal(Math.round((await shelf.boundingBox()).width), 200);
  const divider = page.getByRole('button', { name: '隐藏插件栏', exact: true });
  for (const [delta, expected] of [[500, 320], [-500, 64]]) {
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + 7, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 7 + delta, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(Math.round((await shelf.boundingBox()).width), expected);
    assert.equal(await shelf.isVisible(), true);
  }
  await divider.focus();
  await page.keyboard.press('Enter');
  assert.equal(await shelf.isVisible(), false);
});
