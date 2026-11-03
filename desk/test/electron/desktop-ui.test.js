import { openConfiguration } from './helpers.js';
import { windowOptions } from '../../src/main/os/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

test('desktop UI: launcher restores its latest window and tab double-click explicitly creates a fresh window', async t => {
  const { page } = await launchDesktop(t);
  assert.equal(await page.locator('.global-conversation-entry').count(), 0);
  const launcher = page.locator('.shelf-app').first();
  await launcher.click();
  const firstSource = await page.locator('.application-window iframe').getAttribute('src');
  await launcher.click();
  assert.equal(await page.locator('.application-window').count(), 1);
  await page.locator('#desktop').click();
  await launcher.click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'open');
  assert.equal(await page.locator('.application-window iframe').getAttribute('src'), firstSource);
  assert.equal(await launcher.getByRole('button', { name: '新建窗口', exact: true }).count(), 0);
  await page.getByRole('tab').first().dblclick();
  assert.equal(await page.locator('.application-window').count(), 2);
  assert.equal(new URL(await page.locator('.application-window iframe').nth(1).getAttribute('src')).searchParams.get('fresh'), '1');
  await launcher.click();
  assert.equal(await page.locator('.application-window').count(), 2);
  assert.equal(await page.locator('.application-window.focused').getAttribute('data-window'), '2');
});

test('desktop UI: plugin toolbar separates navigation and omits enable switches in list and grid layouts', async t => {
  const { page } = await launchDesktop(t);
  await openConfiguration(page);
  const toolbar = page.locator('.plugin-toolbar');
  await toolbar.waitFor();
  assert.equal(await toolbar.getByRole('button', { name: '开发插件', exact: true }).count(), 0);
  const importBox = await toolbar.getByRole('button', { name: '导入本地插件', exact: true }).boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  const settingsBox = await toolbar.getByRole('button', { name: '插件更新设置', exact: true }).boundingBox();
  assert.ok(settingsBox.x > importBox.x + importBox.width);
  assert.ok(Math.abs(settingsBox.x + settingsBox.width - toolbarBox.x - toolbarBox.width) < 1);
  assert.equal(await page.getByRole('textbox', { name: '插件包扫描目录', exact: true }).count(), 0);
  assert.equal(await page.locator('.settings-tabs .layout-options').count(), 0);
  assert.equal(await page.getByText('插件中心', { exact: true }).count(), 0);
  assert.equal(await page.locator('.settings-body h1, .settings-body .eyebrow').count(), 0);
  assert.equal(await page.locator('.plugin-card .badge').count(), 0);
  const tabs = await page.locator('.settings-tabs').boundingBox();
  assert.ok((await toolbar.boundingBox()).y >= tabs.y + tabs.height);
  await toolbar.getByRole('button', { name: '列表展示', exact: true }).click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'list');
  const card = page.locator('.plugin-card').first();
  assert.equal(await page.locator('.plugin-card [role="switch"]').count(), 0);
  assert.equal(await card.getByRole('button', { name: '恢复默认图标', exact: true }).count(), 0);
  await toolbar.getByRole('button', { name: '图框展示', exact: true }).click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'grid');
  assert.equal(await page.locator('.plugin-card [role="switch"]').count(), 0);
  assert.equal(await card.getByRole('button', { name: '打开', exact: true }).locator('path').getAttribute('d'),
    'M3 5h18v14H3ZM3 9h18M6 7h.01M9 7h.01');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: '导入本地插件', exact: true }).locator('path').getAttribute('d'),
    'M14 3h6v18H4v-5M3 10h12m-4-4 4 4-4 4');
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('#settings-panel').screenshot({ path: resolve(`.test-results/plugin-toolbar-${theme}.png`) });
  }
});

test('desktop UI: compact close confirmation shows check and cross and keeps emergency close available', async t => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).evaluate(node => node.click());
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('h2').count(), 0);
  await dialog.getByText('仍有窗口未关闭，是否关闭？', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button').count(), 2);
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).locator('path').getAttribute('d'), 'm5 12 4 4L19 6');
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).locator('path').getAttribute('d'), 'm6 6 12 12M18 6 6 18');
  assert.equal(await dialog.getByText('当前没有待关闭任务。', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(node => node === document.activeElement), true);
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await dialog.screenshot({ path: resolve(`.test-results/close-confirmation-${theme}.png`) });
  }
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.application-window').count(), 1);
  await page.getByRole('button', { name: '关闭窗口', exact: true }).evaluate(node => node.click());
  await dialog.getByRole('button', { name: '关闭', exact: true }).getAttribute('title').then(title => assert.equal(title, '关闭'));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.application-window'));
  assert.equal(await page.evaluate(() => localStorage.getItem('test-force-closed')), null);
  await openConfiguration(page);
  assert.equal(await page.evaluate(async () => (await workDesk.plugins.list())[0].state), 'enabled');
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.locator('.shelf-app').first().click();
  await page.evaluate(() => localStorage.setItem('test-preview-hang', '1'));
  await page.getByRole('button', { name: '关闭窗口', exact: true }).evaluate(node => node.click());
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => localStorage.getItem('test-force-closed')), 'desktop-probe-0');
  await page.waitForFunction(() => !document.querySelector('.application-window'));
  assert.equal(await page.evaluate(() => localStorage.getItem('test-plugin-state:0')), null);
});
test('desktop UI: close confirmation only warns about open windows without listing task details', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(() => localStorage.setItem('test-running-tasks', JSON.stringify([
    { name: '不应作为待关闭任务展示的历史会话', exited: true }
  ])));
  await page.locator('.shelf-app').first().click();
  const close = page.getByRole('button', { name: '关闭窗口', exact: true });
  await close.evaluate(node => node.click());
  const dialog = page.getByRole('dialog');
  await dialog.getByText('仍有窗口未关闭，是否关闭？', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.confirm-session').count(), 0);
  assert.doesNotMatch(await dialog.innerText(), /将关闭|待归档|历史会话/);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const title = '执行中 ' + '较长的任务标题与用户消息 '.repeat(30);
  await page.evaluate(title => localStorage.setItem('test-running-tasks', JSON.stringify([
    ...Array.from({ length: 7 }, (_, index) => ({ name: `${title}${index}`, exited: false, collapsed: true })),
    { name: '已完成会话', exited: true }
  ])), title);
  await close.evaluate(node => node.click());
  await dialog.getByRole('button', { name: '关闭', exact: true }).getAttribute('title').then(title => assert.equal(title, '关闭'));
  assert.equal(await dialog.locator('.confirm-session, .confirm-task-list').count(), 0);
  assert.equal(await dialog.locator('.dialog-body').innerText(), '仍有窗口未关闭，是否关闭？');
  assert.doesNotMatch(await dialog.innerText(), /执行中|已完成会话|已折叠|将关闭|停止测试任务/);
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await dialog.screenshot({ path: resolve(`.test-results/close-active-tasks-${theme}.png`) });
  }
  await page.setViewportSize({ width: 420, height: 600 });
  await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 420 && bounds.y + bounds.height <= 600);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.application-window').count(), 1);
});

// Keep desktop presentation tests independent of installed packages and user data.
async function launchDesktop(t) {
  const data = await mkdtemp(join(tmpdir(), 'work-desk-ui-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'),
    args: [resolve('desk/test/fixtures/desktop-ui/main.cjs'), `--test-data=${data}`], env });
  t.after(async () => {
    await app.close();
    await rm(data, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => console.error(error.message));
  return { app, page };
}

test('desktop UI: sandbox window context follows real retained windows, names and closing', async t => {
  const { page } = await launchDesktop(t);
  const request = (root, method) => root.locator('iframe').contentFrame().locator('body').evaluate((_body, method) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => reject(Error(`Timed out: ${method}`)), 4000);
    const receive = event => {
      if (event.source !== parent || event.data?.type !== 'desk:result' || event.data.id !== id) {
        return;
      }
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      event.data.error ? reject(Error(event.data.error.message)) : resolve(event.data.value);
    };
    window.addEventListener('message', receive);
    parent.postMessage({ type: 'desk:invoke', id, method, args: [] }, 'desk-host://desktop');
  }), method);
  await page.locator('.shelf-app').first().click();
  const first = page.locator('.application-window').first();
  const context = await request(first, 'host.getWindowContext');
  assert.match(context.id, /^[a-f0-9-]{36}$/);
  assert.equal(context.name, '窗口1');
  await page.getByRole('tab').first().dblclick();
  const second = page.locator('.application-window').nth(1);
  const sibling = await request(second, 'host.getWindowContext');
  assert.notEqual(context.id, sibling.id);
  assert.equal(sibling.name, '窗口2');
  assert.deepEqual((await request(second, 'host.listWindows')).map(window => window.id), [context.id, sibling.id]);
  await page.getByRole('tab').nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.locator('dialog input').fill('真实窗口名称');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await request(second, 'host.getWindowContext')).name, '真实窗口名称');
  await page.getByRole('tab').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭窗口', exact: true }).click();
  const remaining = await request(page.locator('.application-window'), 'host.listWindows');
  assert.deepEqual(remaining, [{ ...sibling, name: '真实窗口名称' }]);
  assert.equal(await page.locator('.application-window').getAttribute('data-window'), '2');
  await page.locator('.application-window iframe').contentFrame().locator('body').evaluate(() => location.reload());
  assert.deepEqual(await request(page.locator('.application-window'), 'host.getWindowContext'), remaining[0]);
});

test('desktop UI: shell names can be edited without replacing the frame and survive other window creation', async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  const root = page.locator('.application-window').first();
  await root.locator('iframe').contentFrame().locator('h1').waitFor();
  await root.locator('iframe').contentFrame().locator('body').evaluate(node => { node.dataset.retained = 'renamed'; });
  await page.getByRole('tab').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click({ timeout: 4000 });
  await page.locator('dialog input').fill('我的工作会话');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await root.getAttribute('aria-label'), '我的工作会话');
  assert.equal(await root.locator('iframe').contentFrame().locator('body').getAttribute('data-retained'), 'renamed');
  await page.locator('#desktop').click();
  await page.locator('.shelf-app').nth(1).click();
  assert.equal(await root.getAttribute('aria-label'), '我的工作会话');
  assert.equal(await page.getByRole('tab').first().getAttribute('title'), '我的工作会话');
});

test('desktop UI: icon hover works without starting any business plugin', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  const icon = page.locator('.shelf-app').first();
  await icon.waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  await icon.hover();
  const animation = await icon.locator('.shelf-icon').evaluate(node => {
    const animation = node.getAnimations()[0];
    animation.pause();
    animation.currentTime = 120;
    return { transform: getComputedStyle(node).transform, duration: animation.effect.getTiming().duration };
  });
  assert.equal(animation.duration, 480);
  assert.notEqual(animation.transform, 'matrix(1, 0, 0, 1, 0, 0)');
  assert.equal(await icon.evaluate(node => getComputedStyle(node).borderTopColor), 'rgba(0, 0, 0, 0)');
  await page.mouse.move(1100, 700);
  assert.equal(await icon.locator('.shelf-icon').evaluate(node => getComputedStyle(node).transform), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await icon.hover();
  assert.equal(await icon.locator('.shelf-icon').evaluate(node => node.getAnimations().length), 0);
});


test('desktop UI: shelf and workspace resizing retain the same generic frame', { timeout: 30000 }, async (t) => {
  const { app, page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  const frame = page.frameLocator('iframe');
  await frame.locator('h1').waitFor();
  await frame.locator('body').evaluate(body => { body.dataset.retained = 'same-document'; });
  const size = () => page.locator('iframe').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }));
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  await page.getByRole('combobox', { name: '插件图标大小', exact: true }).selectOption('48');
  await page.waitForFunction(() => document.querySelector('.shelf-icon').clientWidth === 46);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'same-document');
  const before = await size();
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#content').classList.contains('shelf-collapsed'));
  assert.ok((await size()).width > before.width);
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'same-document');
  await page.getByRole('button', { name: '显示插件栏', exact: true }).click();
  await page.waitForFunction(width => document.querySelector('iframe').clientWidth === width, before.width);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 650));
  await page.waitForFunction(width => document.querySelector('iframe').clientWidth < width, before.width);
  const after = await size();
  assert.ok(after.height < before.height);
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'same-document');
  assert.equal(await page.locator('iframe').count(), 1);
});


test('desktop UI: shelf minimum fits two cells across icon sizes', async t => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().waitFor();
  for (const size of [24, 36, 48]) {
    await page.evaluate(size => {
      const stage = document.querySelector('.desktop-stage');
      stage.style.setProperty('--shelf-icon-size', `${size}px`);
    }, size);
    const handle = await page.locator('.shelf-toggle').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(0, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    const grid = await page.locator('.plugin-shelf').evaluate(node => ({
      width: node.getBoundingClientRect().width,
      columns: getComputedStyle(node).gridTemplateColumns.split(' ').length
    }));
    assert.equal(grid.columns, 2);
    assert.equal(grid.width, size + 16);
  }
});

test('desktop UI: shelf grid wraps and icon size survives settings and reload', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().waitFor();
  const positions = () => page.locator('.shelf-app').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  }));
  assert.equal(new Set((await positions()).map(rect => rect.x)).size, 1);
  // Use the existing persisted width to test grid geometry independently of pointer timing.
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '240'));
  await page.reload();
  await page.locator('.shelf-app').first().waitFor();
  const wide = await positions();
  assert.ok(new Set(wide.map(rect => rect.x)).size > 1);
  assert.ok(new Set(wide.map(rect => rect.y)).size > 1);
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  const select = page.getByRole('combobox', { name: '插件图标大小', exact: true });
  await select.selectOption('48');
  await page.waitForFunction(() => document.querySelector('.shelf-icon').clientWidth === 46);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.screenshot({ path: '.test-results/shelf-grid-wide.png' });
  await page.reload();
  await page.locator('.shelf-app').first().waitFor();
  assert.equal(await page.locator('.shelf-icon').first().evaluate(node => node.getBoundingClientRect().width), 48);
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  assert.equal(await select.inputValue(), '48');
  await select.selectOption('24');
  await page.waitForFunction(() => document.querySelector('.shelf-icon').clientWidth === 22);
  assert.equal(await page.locator('iframe').count(), 0);
});

test('desktop UI: shelf icons move to empty cells and resize independently with persistent layout', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().waitFor();
  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-width', '300');
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`desktop-probe-${i}`, { col: i === 0 ? 0 : 2, row: i === 0 ? 0 : 15 + i * 3, span: 2 }]))));
  });
  await page.reload();
  const first = page.locator('.shelf-app').first();
  await first.waitFor();
  const start = await first.boundingBox();
  const neighbors = await page.locator('.shelf-app').evaluateAll(nodes => nodes.slice(1).map(node => node.style.gridArea));
  await first.evaluate(node => {
    window.shelfTrace = [];
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => node.addEventListener(type, event => {
      window.shelfTrace.push({ type, x: event.clientX, y: event.clientY, area: node.style.gridArea, target: event.target.className });
    }));
  });
  await page.mouse.move(start.x + start.width / 2, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + 260, { steps: 16 });
  assert.deepEqual(await page.locator('.shelf-app').evaluateAll(nodes => nodes.slice(1).map(node => node.style.gridArea)), neighbors);
  await page.mouse.up();
  const moved = await first.boundingBox();
  assert.deepEqual(await page.locator('.shelf-app').evaluateAll(nodes => nodes.slice(1).map(node => node.style.gridArea)), neighbors);
  assert.ok(moved.y > start.y + 150, JSON.stringify({ start, moved, trace: await page.evaluate(() => window.shelfTrace) }));
  assert.equal(await page.locator('iframe').count(), 0);
  const handle = first.getByRole('button', { name: '调整图标大小', exact: true });
  await first.hover();
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 65, grip.y + grip.height / 2 + 75, { steps: 12 });
  await page.mouse.up();
  const width = await first.locator('.shelf-icon').evaluate(node => node.getBoundingClientRect().width);
  assert.ok(width > 60);
  assert.deepEqual(await page.locator('.shelf-app').evaluateAll(nodes => nodes.slice(1).map(node => node.style.gridArea)), neighbors);
  assert.equal(await page.locator('.shelf-icon').nth(1).evaluate(node => node.getBoundingClientRect().width), 36);
  const rectangles = await page.locator('.shelf-app').evaluateAll(nodes => nodes.map(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  }));
  rectangles.forEach((a, i) => rectangles.slice(i + 1).forEach(b => {
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }));
  const placed = await first.boundingBox();
  await page.screenshot({ path: '.test-results/shelf-placement-wide.png' });
  await page.reload();
  await first.waitFor();
  assert.deepEqual(await first.boundingBox(), placed);
  assert.deepEqual(await page.locator('.shelf-app').evaluateAll(nodes => nodes.slice(1).map(node => node.style.gridArea)), neighbors);
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '64'));
  await page.reload();
  await first.waitFor();
  assert.equal(await page.locator('.plugin-shelf').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '300'));
  await page.reload();
  await first.waitFor();
  assert.deepEqual(await first.boundingBox(), placed);
  assert.equal(await page.locator('iframe').count(), 0);
  await first.click();
  await page.frameLocator('iframe').locator('h1').waitFor();
});

test('desktop UI: shelf horizontal insertion follows direction and wraps to adjacent rows', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  for (const direction of [1, -1]) {
    for (const names of ['visible', 'hidden']) {
      await page.evaluate(names => {
        localStorage.setItem('plugin-shelf-width', '300');
        localStorage.setItem('plugin-shelf-show-names', names === 'hidden' ? 'false' : 'true');
      }, names);
      await page.reload();
      await icons.first().waitFor();
      const height = names === 'hidden' ? 2 : 3;
      const wrapRow = 12 + direction * height;
      await page.evaluate(({ direction, wrapRow }) => {
        const placements = [
          { col: direction === 1 ? 0 : 2, row: 20, span: 2 },
          ...Array.from({ length: 4 }, (_, i) => ({ col: i % 2 * 2,
            row: 12 + (direction === 1 ? Math.floor(i / 2) : Math.floor((i + 1) / 2)) * (wrapRow - 12), span: 2 })),
          { col: 0, row: 12 + 2 * (wrapRow - 12), span: 2 }
        ];
        localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries(
          placements.map((position, i) => [`desktop-probe-${i}`, position]))));
      }, { direction, wrapRow });
      await page.reload();
      await icons.first().waitFor();
      const areas = () => icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
      const original = await areas();
      const source = await icons.first().boundingBox();
      const target = await icons.nth(1).boundingBox();
      const expected = Array.from({ length: 6 }, (_, i) =>
        `${12 + (direction === 1 ? Math.floor(i / 2) : Math.floor((i + 1) / 2)) * direction * height + 1} / ${i % 2 * 2 + 1} / span ${height} / span 2`);
      // Synthetic pointers keep collision assertions independent of macOS native capture cancellation.
      await icons.first().evaluate(node => { node.setPointerCapture = () => {}; });
      const pointer = async (type, x, y) => icons.first().dispatchEvent(type,
        { pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true });
      await pointer('pointermove', source.x + 10, source.y + 10);
      await pointer('pointerdown', source.x + 10, source.y + 10);
      await pointer('pointermove', target.x + 10, target.y + 10);
      assert.deepEqual(await areas(), expected);
      // Repeated hover uses the same starting layout, including after wrapping.
      for (const offset of [11, 12, 10]) {
        await pointer('pointermove', target.x + offset, target.y + 10);
        assert.deepEqual(await areas(), expected);
      }
      await pointer('pointermove', source.x + 10, source.y + 10);
      assert.deepEqual(await areas(), original);
      await pointer('pointermove', target.x + 10, target.y + 10);
      await icons.first().evaluate(node => node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
      await pointer('pointerup', target.x + 10, target.y + 10);
      assert.deepEqual(await areas(), original);
      await pointer('pointermove', source.x + 10, source.y + 10);
      await pointer('pointerdown', source.x + 10, source.y + 10);
      await pointer('pointermove', target.x + 10, target.y + 10);
      await pointer('pointerup', target.x + 10, target.y + 10);
      assert.deepEqual(await areas(), expected);
      assert.equal(await page.locator('iframe').count(), 0);
      await page.reload();
      await icons.first().waitFor();
      assert.deepEqual(await areas(), expected);
    }
  }
});

test('desktop UI: shelf insertion only moves collided neighbors and restores them when the pointer leaves', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  for (const start of [{ col: 0, row: 0 }, { col: 2, row: 0 }, { col: 0, row: 12 }]) {
    await page.evaluate(start => {
      localStorage.setItem('plugin-shelf-width', '300');
      localStorage.setItem('plugin-shelf-show-names', 'true');
      localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries([
        { ...start, span: 2 }, { col: 0, row: 6, span: 2 }, { col: 2, row: 8, span: 2 },
        { col: 0, row: 30, span: 2 }, { col: 0, row: 16, span: 2 }, { col: 2, row: 16, span: 2 }
      ].map((position, i) => [`desktop-probe-${i}`, position]))));
    }, start);
    await page.reload();
    await icons.first().waitFor();
    const areas = () => icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
    const original = await areas();
    const source = await icons.first().boundingBox();
    const target = await icons.nth(1).boundingBox();
    await icons.first().evaluate(node => { node.setPointerCapture = () => {}; });
    const pointer = async (type, x, y) => icons.first().dispatchEvent(type,
      { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true });
    await pointer('pointerdown', source.x + 10, source.y + 10);
    await pointer('pointermove', target.x + 10, target.y + 10);
    const inserted = await areas();
    assert.equal(inserted[1], start.col > 0 ? '4 / 3 / span 3 / span 2' : '7 / 3 / span 3 / span 2');
    assert.equal(inserted[2], start.col > 0 ? original[2] : '12 / 1 / span 3 / span 2');
    assert.deepEqual(inserted.slice(3), original.slice(3));
    await pointer('pointermove', source.x + 10, source.y + 10);
    assert.deepEqual((await areas()).slice(1), original.slice(1));
    await pointer('pointerup', source.x + 10, source.y + 10);
    await page.reload();
    await icons.first().waitFor();
    assert.deepEqual((await areas()).slice(1), original.slice(1));
    assert.equal(await page.locator('iframe').count(), 0);
  }
});

test('desktop UI: shelf horizontal insertion restores the layout when insertion would cross the top boundary', { timeout: 10000 }, async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-width', '300');
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries([
      { col: 2, row: 12, span: 2 },
      { col: 0, row: 0, span: 2 }, { col: 2, row: 0, span: 2 },
      { col: 0, row: 3, span: 2 }, { col: 2, row: 3, span: 2 }, { col: 0, row: 6, span: 3 }
    ].map((position, i) => [`desktop-probe-${i}`, position]))));
  });
  await page.reload();
  await icons.first().waitFor();
  const original = await icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
  const source = await icons.first().boundingBox();
  const target = await icons.nth(1).boundingBox();
  await icons.first().evaluate(node => { node.setPointerCapture = () => {}; });
  for (const [type, rect] of [['pointerdown', source], ['pointermove', target], ['pointerup', target]]) {
    await icons.first().dispatchEvent(type, { pointerId: 1, button: 0, clientX: rect.x + 10, clientY: rect.y + 10, bubbles: true });
  }
  assert.deepEqual(await icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea)), original);
  await page.reload();
  await icons.first().waitFor();
  assert.deepEqual(await icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea)), original);
});

test('desktop UI: shelf insertion at the viewport bottom continues into scrollable rows', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '300'));
  await page.reload();
  await icons.first().waitFor();
  const rows = await page.locator('.plugin-shelf').evaluate(node =>
    Math.floor((node.clientHeight - 12) / parseFloat(node.style.getPropertyValue('--shelf-cell-height'))));
  await page.evaluate(rows => localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries([
    { col: 0, row: 0, span: 2 },
    ...Array.from({ length: 5 }, (_, i) => ({ col: i % 2 * 2, row: rows - 3 + Math.floor(i / 2) * 3, span: 2 }))
  ].map((position, i) => [`desktop-probe-${i}`, position])))), rows);
  await page.reload();
  await icons.first().waitFor();
  const areas = () => icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
  const original = await areas();
  const source = await icons.first().boundingBox();
  const target = await icons.nth(1).boundingBox();
  await icons.first().evaluate(node => { node.setPointerCapture = () => {}; });
  const pointer = async (type, x, y) => icons.first().dispatchEvent(type,
    { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true });
  await pointer('pointerdown', source.x + 10, source.y + 10);
  await pointer('pointermove', target.x + 10, target.y + 10);
  const preview = await areas();
  assert.notDeepEqual(preview, original);
  await pointer('pointerup', target.x + 10, target.y + 10);
  await page.reload();
  await icons.first().waitFor();
  assert.deepEqual(await areas(), preview);
  assert.equal(await icons.evaluateAll(nodes => nodes.every(node => !node.hidden)), true);
  const scroll = await page.locator('.plugin-shelf').evaluate(node => {
    node.scrollTop = node.scrollHeight;
    return node.scrollTop;
  });
  assert.ok(scroll > 0);
  assert.equal(await page.locator('iframe').count(), 0);
});

test('desktop UI: shelf overflow scrolls between fixed navigation and account regions', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  const stored = await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout'));
  await page.locator('.plugin-shelf').evaluate(node => {
    node.style.height = '180px';
    node.style.bottom = 'auto';
  });
  await page.waitForTimeout(100);
  assert.equal(await icons.evaluateAll(nodes => nodes.every(node => !node.hidden)), true);
  const home = await page.locator('.titlebar').boundingBox();
  const footer = await page.locator('.shelf-footer').boundingBox();
  const scroll = await page.locator('.plugin-shelf').evaluate(node => {
    node.scrollTop = node.scrollHeight;
    const rect = node.getBoundingClientRect();
    return { top: node.scrollTop, lastBottom: node.lastElementChild.getBoundingClientRect().bottom, bottom: rect.bottom };
  });
  assert.ok(scroll.top > 0);
  assert.ok(scroll.lastBottom <= scroll.bottom);
  assert.deepEqual(await page.locator('.titlebar').boundingBox(), home);
  assert.deepEqual(await page.locator('.shelf-footer').boundingBox(), footer);
  assert.equal(await page.locator('.shelf-footer').evaluate(node => getComputedStyle(node, '::before').height), '1px');
  assert.equal(await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout')), stored);
  assert.equal(await page.locator('iframe').count(), 0);
});

test('desktop UI: shelf insertion respects mixed sizes and leaves icons outside the chain in place', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  for (const names of ['visible', 'hidden']) {
    await page.evaluate(names => {
      localStorage.setItem('plugin-shelf-width', '300');
      localStorage.setItem('plugin-shelf-show-names', names === 'hidden' ? 'false' : 'true');
      localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify({
        'desktop-probe-0': { col: 0, row: 10, span: 3 },
        'desktop-probe-1': { col: 0, row: 0, span: 2 },
        'desktop-probe-2': { col: 2, row: 0, span: 2 },
        'desktop-probe-3': { col: 0, row: 14, span: 2 },
        'desktop-probe-4': { col: 2, row: 14, span: 2 },
        'desktop-probe-5': { col: 2, row: 25, span: 2 }
      }));
    }, names);
    await page.reload();
    await icons.first().waitFor();
    const areas = () => icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
    const original = await areas();
    const source = await icons.first().boundingBox();
    const target = await icons.nth(1).boundingBox();
    // Exercise the layout handlers without native pointer capture interruptions.
    await icons.first().evaluate(node => { node.setPointerCapture = () => {}; });
    for (const [type, rect] of [['pointerdown', source], ['pointermove', target], ['pointerup', target]]) {
      await icons.first().dispatchEvent(type, { pointerId: 1, button: 0, clientX: rect.x + 10, clientY: rect.y + 10, bubbles: true });
    }
    const placed = await areas();
    assert.deepEqual(placed.slice(3), original.slice(3));
    assert.notEqual(placed[1], original[1]);
    assert.notEqual(placed[2], original[2]);
    const rectangles = placed.map(area => {
      const [row, col, height, width] = area.split('/').map(value => Number(value.trim().replace('span ', '')));
      return { row, col, height, width };
    });
    rectangles.forEach((a, i) => {
      assert.equal(a.width, Number(original[i].split('/').at(-1).trim().replace('span ', '')));
      assert.ok(a.col + a.width <= 5);
      rectangles.slice(i + 1).forEach(b => {
        assert.ok(a.col + a.width <= b.col || b.col + b.width <= a.col || a.row + a.height <= b.row || b.row + b.height <= a.row);
      });
    });
    assert.equal(await page.locator('iframe').count(), 0);
    await page.reload();
    await icons.first().waitFor();
    assert.deepEqual(await areas(), placed);
  }
});

test('desktop UI: finer shelf cells, hidden labels and custom names persist without opening plugins', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  const first = page.locator('.shelf-app').first();
  await first.waitFor();
  const cells = await page.locator('.plugin-shelf').evaluate(node => ({
    width: parseFloat(node.style.getPropertyValue('--shelf-cell-width')),
    height: parseFloat(node.style.getPropertyValue('--shelf-cell-height'))
  }));
  assert.equal(cells.width, cells.height);
  assert.ok(cells.height >= 12 && cells.height <= 30, 'launcher cells stay fine and square');
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('我的助手 <本地>');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await first.locator('.shelf-name').textContent(), '我的助手 <本地>');
  assert.equal(await first.getAttribute('aria-label'), '我的助手 <本地>');
  const firstRect = await first.boundingBox();
  const secondRect = await page.locator('.shelf-app').nth(1).boundingBox();
  assert.ok(firstRect.y + firstRect.height <= secondRect.y);
  assert.equal(await page.evaluate(async () => (await window.workDesk.plugins.list())[0].name), '测试图标1');
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  await page.getByRole('switch', { name: '显示插件名称', exact: true }).uncheck();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await first.locator('.shelf-name').isVisible(), false);
  assert.equal(await first.getAttribute('title'), '我的助手 <本地>');
  assert.equal(await page.locator('.plugin-shelf').evaluate(node => parseFloat(node.style.getPropertyValue('--shelf-cell-height'))), cells.height);
  await page.reload();
  await first.waitFor();
  assert.equal(await first.locator('.shelf-name').isVisible(), false);
  assert.equal(await first.getAttribute('aria-label'), '我的助手 <本地>');
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('不保存');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await first.getAttribute('aria-label'), '我的助手 <本地>');
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('   ');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await first.getAttribute('aria-label'), '我的助手 <本地>');
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  const names = page.getByRole('switch', { name: '显示插件名称', exact: true });
  assert.equal(await names.isChecked(), false);
  await names.check();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await first.locator('.shelf-name').isVisible(), true);
  assert.equal(await page.locator('iframe').count(), 0);
  await first.click();
  const frame = page.frameLocator('iframe');
  await frame.locator('h1').waitFor();
  await frame.locator('body').evaluate(node => { node.dataset.retained = 'rename-keeps-window'; });
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('新的显示名称');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'rename-keeps-window');
});

test('desktop UI: rename menu stays above a wide shelf and dismisses normally', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().waitFor();
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '300'));
  await page.reload();
  const first = page.locator('.shelf-app').first();
  await first.click({ button: 'right', position: { x: 15, y: 15 } });
  const item = page.getByRole('menuitem', { name: '修改名称', exact: true });
  assert.equal(await item.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), true);
  await item.click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('可见菜单');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await first.getAttribute('aria-label'), '可见菜单');
  await first.click({ button: 'right' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  await first.click({ button: 'right' });
  await page.locator('.desktop-surface').click({ position: { x: 500, y: 300 } });
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.locator('iframe').count(), 0);
});

test('desktop UI: icons occupy at least two fine cells and legacy layout is retained', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().waitFor();
  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-width', '300');
    localStorage.setItem('plugin-shelf-layout', JSON.stringify({ 'desktop-probe-1': { col: 1, row: 2, span: 2 } }));
  });
  await page.reload();
  const first = page.locator('.shelf-app').first();
  await first.waitFor();
  assert.equal(await first.evaluate(node => getComputedStyle(node).gridColumnEnd), 'span 2');
  const legacy = page.locator('.shelf-app').nth(1);
  assert.equal(await legacy.evaluate(node => node.style.gridColumnStart), '3');
  assert.equal(await legacy.evaluate(node => node.style.gridRowStart), '7');
  assert.equal(await legacy.evaluate(node => node.style.gridColumnEnd), 'span 4');
  const start = await first.boundingBox();
  await page.mouse.move(start.x + 20, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(start.x + 45, start.y + 44, { steps: 10 });
  await page.mouse.up();
  const moved = await first.boundingBox();
  assert.ok(moved.x > start.x + 15 && moved.x < start.x + 35, JSON.stringify({ start, moved }));
  assert.ok(moved.y - start.y > 20 && moved.y - start.y < 30);
  const grip = first.getByRole('button', { name: '调整图标大小', exact: true });
  await grip.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await first.evaluate(node => node.style.gridColumnEnd), 'span 2', 'occupied cells reject enlargement');
  // Move to a free row before testing enlargement; neighbors retain their reserved cells.
  const neighbors = await page.locator('.shelf-app').evaluateAll(nodes => nodes.slice(1).map(node => node.style.gridArea));
  await page.mouse.move(moved.x + 20, moved.y + 20);
  await page.mouse.down();
  await page.mouse.move(moved.x + 20, moved.y + 320, { steps: 12 });
  await page.mouse.up();
  await grip.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await first.evaluate(node => node.style.gridColumnEnd), 'span 3');
  assert.deepEqual(await page.locator('.shelf-app').evaluateAll(nodes => nodes.slice(1).map(node => node.style.gridArea)), neighbors);
  const resized = await first.locator('.shelf-icon').evaluate(node => node.offsetWidth);
  assert.ok(resized > 50 && resized < 70);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await first.evaluate(node => node.style.gridColumnEnd), 'span 2');
  const placed = await first.boundingBox();
  await page.reload();
  await first.waitFor();
  assert.deepEqual(await first.boundingBox(), placed);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('plugin-shelf-layout'))['desktop-probe-1'].span), 2);
  assert.equal(await page.locator('iframe').count(), 0);
  await page.screenshot({ path: '.test-results/shelf-fine-grid.png' });
});

test('desktop UI: workspace label is centered and header configuration is removed', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().waitFor();
  assert.equal(await page.locator('#configuration, #active-app').count(), 0);
  const label = page.locator('.workspace-label');
  assert.equal(await label.textContent(), '本地工作空间');
  const centered = async () => {
    const text = await label.boundingBox();
    const area = await page.locator('.desktop-surface').boundingBox();
    assert.ok(Math.abs(text.x + text.width / 2 - area.x - area.width / 2) < 1);
    assert.ok(Math.abs(text.y + text.height / 2 - area.y - area.height / 2) < 1);
    assert.equal(await label.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    assert.ok(await label.evaluate(node => Number(getComputedStyle(node).opacity)) < 0.5);
  };
  await centered();
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '300'));
  await page.reload();
  await label.waitFor();
  await centered();
  await page.screenshot({ path: '.test-results/workspace-label.png' });
});

test('desktop UI: sibling closes independently and last window can force close while task snapshot hangs', async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  await page.getByRole('tab').first().dblclick();
  await page.locator('.shelf-app').nth(1).click();
  await page.evaluate(() => localStorage.setItem('test-preview-hang', 'yes'));
  await page.getByRole('tab').first().getByRole('button', { name: '关闭窗口', exact: true }).evaluate(node => node.click());
  await page.waitForFunction(() => document.querySelectorAll('.application-window').length === 2);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('test-force-closed')), null);
  await page.getByRole('tab').first().getByRole('button', { name: '关闭窗口', exact: true }).evaluate(node => node.click());
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 2);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 2);
  await page.getByRole('tab').first().getByRole('button', { name: '关闭窗口', exact: true }).evaluate(node => node.click());
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.application-window').length === 1);
  assert.equal(await page.locator('.application-window iframe').getAttribute('src').then(src => src.includes('desktop-probe-1')), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('test-force-closed')), 'desktop-probe-0');
  assert.equal(await page.evaluate(() => localStorage.getItem('test-plugin-state:0')), null);
});

test('desktop UI: removed plugins stay hidden in configuration after reload without deleting their records', async (t) => {
  const { page } = await launchDesktop(t);
  await page.evaluate(() => localStorage.setItem('test-plugin-state:0', 'uninstalled'));
  await page.reload();
  await openConfiguration(page);
  assert.equal(await page.locator('.plugin-card[data-plugin="desktop-probe-0"]').count(), 0);
  assert.equal(await page.locator('.shelf-app[data-plugin="desktop-probe-0"]').count(), 0);
  assert.equal((await page.evaluate(() => workDesk.plugins.list())).length, 6);
  assert.equal(await page.locator('.plugin-card').count(), 5);
});

test('desktop UI: disabled plugins leave the shelf and enabling restores their saved placement and alias', async (t) => {
  const { page } = await launchDesktop(t);
  const launcher = page.locator('.shelf-app[data-plugin="desktop-probe-0"]');
  await launcher.waitFor();
  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-name:desktop-probe-0', '我的助手');
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify({ 'desktop-probe-0': { col: 0, row: 12, span: 2 } }));
  });
  await page.reload();
  await launcher.waitFor();
  const placement = await launcher.getAttribute('style');
  await openConfiguration(page);
  await page.evaluate(() => workDesk.plugins.disable('desktop-probe-0'));
  await launcher.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.shelf-app').count(), 5);
  await page.evaluate(() => workDesk.plugins.enable('desktop-probe-0'));
  await launcher.waitFor();
  assert.equal(await launcher.getAttribute('aria-label'), '我的助手');
  assert.equal(await launcher.getAttribute('style'), placement);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.reload();
  await launcher.waitFor();
  assert.equal(await launcher.getAttribute('style'), placement);
  assert.equal(await page.locator('iframe').count(), 0);
});

test('desktop UI: system theme follows light and dark changes and retains manual overrides', async (t) => {
  const { page } = await launchDesktop(t);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('.shelf-app').first().click();
  const frame = page.frameLocator('iframe');
  await frame.locator('h1').waitFor();
  const pluginTheme = await frame.locator('body').evaluate(() => new Promise(resolve => {
    const receive = event => {
      if (event.data?.type === 'desk:result' && event.data.id === 'theme-probe') {
        window.removeEventListener('message', receive);
        resolve(event.data.value.theme);
      }
    };
    window.addEventListener('message', receive);
    window.parent.postMessage({ type: 'desk:invoke', id: 'theme-probe', method: 'storage.getPreferences', args: [] }, '*');
  }));
  assert.equal(pluginTheme, 'light');
  await openConfiguration(page);
  await page.locator('#theme-settings').click();
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await openConfiguration(page);
  await page.locator('#theme-settings').click();
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('system');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
});


test('desktop UI: sidebar home reaches the top while its divider clears native controls', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().waitFor();
  const measure = () => page.evaluate(() => {
    const bounds = selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    return { title: bounds('.titlebar'), workspace: bounds('#content'), divider: bounds('.shelf-toggle'),
      shelf: bounds('.plugin-shelf') };
  });
  const before = await measure();
  assert.equal(before.workspace.y, 0);
  assert.ok(await page.locator('.window-tabs').evaluate(node => node.offsetHeight) >=
    await page.evaluate(() => navigator.windowControlsOverlay?.getTitlebarAreaRect().height || 0));
  assert.ok(before.divider.y >= await page.evaluate(() => navigator.windowControlsOverlay?.getTitlebarAreaRect().height || 0));
  assert.equal(before.divider.height, await page.evaluate(() => innerHeight) - before.divider.y);
  assert.equal(before.title.x, 0);
  assert.equal(before.title.width, before.shelf.width);
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '240'));
  await page.reload();
  assert.equal((await measure()).title.width, 240);
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  assert.equal(await page.locator('.titlebar').isVisible(), false);
  assert.equal((await measure()).workspace.x, 0);
  await page.getByRole('button', { name: '显示插件栏', exact: true }).click();
  assert.equal(await page.locator('.titlebar').isVisible(), true);
  await page.screenshot({ path: '.test-results/sidebar-title-continuous-workspace.png' });
});

test('desktop UI: sidebar account menu stays in the top layer and opens settings without replacing plugin frames', async (t) => {
  const { page } = await launchDesktop(t);
  const trigger = page.getByRole('button', { name: '用户菜单', exact: true });
  await trigger.waitFor();
  const borders = await page.locator('.titlebar').evaluate(node => {
    const style = getComputedStyle(node);
    return [style.borderTopWidth, style.borderBottomWidth];
  });
  assert.deepEqual(borders, ['0px', '0px']);
  await page.locator('.shelf-app').first().click();
  const frame = page.locator('iframe').first().contentFrame();
  await frame.locator('body').evaluate(node => { node.dataset.retained = 'account-menu'; });
  await trigger.click();
  const menu = page.locator('#account-menu');
  assert.equal(await menu.evaluate(node => node.matches(':popover-open')), true);
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['游客', '插件', '设置', '语言', '检查更新']);
  await menu.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  await page.screenshot({ path: '.test-results/sidebar-account-menu.png' });
  const bounds = await menu.boundingBox();
  const button = await trigger.boundingBox();
  assert.ok(bounds.x >= button.x + button.width);
  await menu.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('dialog', { name: '配置', exact: true }).waitFor();
  assert.equal(await menu.evaluate(node => node.matches(':popover-open')), false);
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'account-menu');
  await page.keyboard.press('Escape');
  await trigger.click();
  await page.keyboard.press('Escape');
  assert.equal(await menu.evaluate(node => node.matches(':popover-open')), false);
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  assert.equal(await trigger.isVisible(), false);
});

test('desktop UI: account menu hides on pointer leave and plugin entry opens plugin settings', async t => {
  const { page } = await launchDesktop(t);
  const trigger = page.getByRole('button', { name: '用户菜单', exact: true });
  const menu = page.locator('#account-menu');
  const submenu = page.locator('#language-menu');
  await trigger.click();
  await page.mouse.move(800, 100);
  await menu.waitFor({ state: 'hidden', timeout: 1500 });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await trigger.click();
  await menu.getByRole('menuitem', { name: '语言', exact: true }).hover();
  await submenu.getByRole('menuitemradio', { name: 'English', exact: true }).hover();
  // Crossing the gaps between trigger, menu and submenu must not dismiss a usable menu.
  await page.waitForTimeout(400);
  assert.equal(await menu.isVisible(), true);
  assert.equal(await submenu.isVisible(), true);
  await page.mouse.move(800, 100);
  await menu.waitFor({ state: 'hidden', timeout: 1500 });
  assert.equal(await submenu.isVisible(), false);
  await trigger.click();
  await menu.getByRole('menuitem', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '导入本地插件', exact: true }).waitFor();
  assert.equal(await page.locator('#plugin-center').evaluate(node => node.classList.contains('selected')), true);
  assert.equal(await menu.isVisible(), false);
});

test('desktop UI: language switches persist without replacing or translating a plugin frame', async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  const frame = page.locator('iframe').first().contentFrame();
  await frame.locator('body').evaluate(node => { node.dataset.retained = 'language'; });
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '语言', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('.workspace-label').textContent(), 'Local workspace');
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'language');
  assert.equal(await frame.locator('h1').textContent(), '桌面契约测试页面');
  await page.getByRole('button', { name: 'User menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Import local plugin', exact: true }).waitFor();
  assert.equal(await page.locator('#plugin-center').textContent(), 'Plugins');
  assert.equal(await page.locator('.settings-body h1, .settings-body .eyebrow').count(), 0);
  await page.screenshot({ path: '.test-results/desktop-english-settings.png' });
  await page.locator('#desktop-settings').click();
  await page.getByRole('combobox', { name: 'Grid size', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: 'User menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await page.getByRole('button', { name: '用户菜单', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-label').textContent(), '本地工作空间');
});


test('desktop UI: compact settings retain layout and theme controls without duplicate chrome', async (t) => {
  const { page } = await launchDesktop(t);
  await openConfiguration(page);
  const panel = page.locator('#settings-panel');
  assert.equal(await panel.locator('.dialog-heading, .settings-footer').count(), 0);
  for (const name of ['列表展示', '图框展示', '关闭配置']) {
    assert.equal(await panel.getByRole('button', { name, exact: true }).locator('svg').count(), 1);
  }
  await panel.getByRole('button', { name: '列表展示', exact: true }).click();
  assert.equal(await panel.locator('.plugin-grid').getAttribute('data-layout'), 'list');
  await page.locator('#theme-settings').click();
  assert.equal(await panel.getByRole('heading').count(), 0);
  assert.equal(await panel.getByRole('button', { name: '切换黑白主题', exact: true }).count(), 0);
  await panel.getByRole('combobox', { name: '外观', exact: true }).selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await panel.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await openConfiguration(page);
  await page.locator('#theme-settings').click();
  assert.equal(await page.locator('#theme-mode').inputValue(), 'dark');
  await panel.evaluate(async node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  await page.screenshot({ path: resolve('.test-results/compact-settings.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings-panel').count(), 0);
});

test('desktop UI: settings dropdown arrows animate without changing native selection', async (t) => {
  const { page } = await launchDesktop(t);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  const grid = page.getByRole('combobox', { name: '网格大小', exact: true });
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await grid.evaluate(node => getComputedStyle(node).appearance), 'none');
  await page.bringToFront();
  await grid.focus();
  await grid.hover();
  await page.waitForFunction(node => getComputedStyle(node).backgroundPositionY === 'calc(50% + 3px)', await grid.elementHandle());
  assert.equal(await grid.evaluate(node => getComputedStyle(node).transitionDuration), '0.18s, 0.24s');
  await grid.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.equal(await grid.inputValue(), '24');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await grid.hover();
  assert.equal(await grid.evaluate(node => getComputedStyle(node).backgroundPositionY), '50%');
  await page.screenshot({ path: '.test-results/settings-dropdown.png' });
});

test('desktop UI: shared dropdowns match desktop settings across plugin styles and themes', async t => {
  const { page } = await launchDesktop(t);
  await page.bringToFront();
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  const reference = page.getByRole('combobox', { name: '网格大小', exact: true });
  const styles = ['ai-agent/app', 'ai-agent/conversation', 'ai-agent/settings', 'mcp/app', 'text-editor/app',
    'codex-capture/app', 'resource-monitor/app', 'work-flow/app'];
  const css = await Promise.all(styles.map(name => {
    const [plugin, entry] = name.split('/');
    return readFile(`plugin-dev/${plugin}/dist/renderer/${entry}.css`, 'utf8');
  }));
  const appearance = node => {
    const style = getComputedStyle(node);
    return Object.fromEntries(['minHeight', 'padding', 'borderRadius', 'borderColor', 'backgroundColor', 'color',
      'fontSize', 'lineHeight', 'appearance', 'backgroundImage', 'backgroundSize'].map(key => [key, style[key]]));
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await reference.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    const expected = await reference.evaluate(appearance);
    for (const [index, name] of styles.entries()) {
      // Isolated documents exercise packaged styles without starting any plugin or using user data.
      await page.evaluate(({ css, theme }) => {
        document.querySelector('#control-fixture')?.remove();
        const frame = document.createElement('iframe');
        frame.id = 'control-fixture';
        frame.style.cssText = 'position:fixed;inset:0;width:360px;height:400px;z-index:99999;background:white';
        frame.srcdoc = `<html data-theme="${theme}"><head><style>${css}</style></head><body>
          <div class="configuration-dialog engine-page"><div id="settings"><div class="controls palette-field">
          <label style="display:block;width:240px">选项<select id="choice" aria-label="选项" style="width:100%">
          <option value="one">第一个选项</option><option value="two">第二个选项</option></select></label>
          </div></div></div></body></html>`;
        document.body.append(frame);
      }, { css: css[index], theme });
      const frame = page.frameLocator('#control-fixture');
      const select = frame.locator('#choice');
      await select.waitFor();
      assert.deepEqual(await select.evaluate(appearance), expected, `${name}: ${theme}`);
      await select.evaluate(node => node.addEventListener('change', () => { node.dataset.changed = node.value; }));
      await select.selectOption('two');
      assert.equal(await select.inputValue(), 'two', `${name}: native selection`);
      assert.equal(await select.getAttribute('data-changed'), 'two', `${name}: change event`);
      await select.evaluate(node => { node.disabled = true; });
      await page.waitForTimeout(260);
      assert.equal(await select.evaluate(node => getComputedStyle(node).cursor), 'default');
      assert.equal(await select.evaluate(node => getComputedStyle(node).backgroundPositionY), '50%');
      assert.ok((await select.boundingBox()).width <= 240, `${name}: narrow container`);
    }
  }
  await page.locator('#control-fixture').evaluate(node => node.remove());
});

test('desktop UI: language submenu opens beside the menu and supports hover and keyboard', async (t) => {
  const { page } = await launchDesktop(t);
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  const row = page.getByRole('menuitem', { name: '语言', exact: true });
  const submenu = page.locator('#language-menu');
  await row.hover();
  await submenu.waitFor({ state: 'visible' });
  await submenu.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  assert.equal(await page.locator('dialog').count(), 0);
  const parentBounds = await page.locator('#account-menu').boundingBox();
  const bounds = await submenu.boundingBox();
  assert.ok(bounds.x >= parentBounds.x + parentBounds.width);
  assert.equal(await submenu.getByRole('menuitemradio', { name: '简体中文', exact: true }).getAttribute('aria-checked'), 'true');
  await row.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('#account-menu').isVisible(), false);
  await page.getByRole('button', { name: 'User menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  assert.equal(await submenu.isVisible(), false);
  assert.equal(await page.locator('#account-menu').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#account-menu').isVisible(), false);
});

test('desktop UI: sidebar divider starts below tabs and home has a short separator', async (t) => {
  const { page } = await launchDesktop(t);
  // firstWindow resolves before the renderer has necessarily mounted its sidebar.
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).waitFor();
  await page.getByRole('button', { name: '回到桌面', exact: true }).waitFor();
  const result = await page.evaluate(() => {
    const divider = document.querySelector('.shelf-toggle');
    const bounds = divider.getBoundingClientRect();
    const title = document.querySelector('.titlebar');
    return { hit: document.elementFromPoint(bounds.x + 6, innerHeight - 8) === divider,
      top: title.getBoundingClientRect().top, dividerTop: bounds.top,
      controlsHeight: navigator.windowControlsOverlay?.getTitlebarAreaRect().height || 0,
      separator: getComputedStyle(title, '::after').width,
      shelfTop: document.querySelector('.plugin-shelf').getBoundingClientRect().top,
      titleBottom: title.getBoundingClientRect().bottom };
  });
  assert.equal(result.hit, true);
  assert.equal(result.top, 0);
  assert.ok(result.dividerTop >= result.controlsHeight);
  assert.equal(result.separator, '36px');
  assert.equal(result.shelfTop, result.titleBottom);
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '语言', exact: true }).hover();
  await page.locator('#language-menu').waitFor({ state: 'visible' });
  await page.locator('#language-menu').evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  await page.screenshot({ path: '.test-results/sidebar-refinement.png' });
});


test('desktop UI: home icon returns to desktop without a right-side action or reloading frames', async (t) => {
  const { app, page } = await launchDesktop(t);
  const chrome = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { bounds: window.getBounds(), content: window.getContentBounds() };
  });
  if (windowOptions.titleBarOverlay) {
    assert.deepEqual(chrome.content, chrome.bounds, 'native controls overlay the themed canvas');
  }
  const brand = page.getByRole('button', { name: '回到桌面', exact: true });
  await brand.waitFor();
  assert.equal(await page.locator('.titlebar-actions').count(), 0);
  assert.equal(await brand.evaluate(node => getComputedStyle(node).webkitAppRegion), 'no-drag');
  await page.locator('.shelf-app').first().click();
  const frame = page.locator('iframe').first().contentFrame();
  await frame.locator('body').evaluate(node => { node.dataset.retained = 'brand-return'; });
  await brand.click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'inactive');
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'brand-return');
  await page.getByRole('tab').first().click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'open');
  await brand.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'inactive');
  assert.equal(await brand.textContent(), '');
  assert.equal(await brand.locator('svg').count(), 1);
  assert.equal(await brand.getAttribute('title'), '回到桌面');
});


test('desktop UI: native controls reserve space on the themed canvas with the shelf open or hidden', async (t) => {
  const { page } = await launchDesktop(t);
  if (!windowOptions.titleBarOverlay) {
    t.skip('native overlay is only configured on platforms that support it');
    return;
  }
  await page.locator('.shelf-app').first().waitFor();
  const controls = await page.evaluate(() => {
    const { x, height } = navigator.windowControlsOverlay.getTitlebarAreaRect();
    return { x, height, visible: navigator.windowControlsOverlay.visible };
  });
  assert.equal(controls.visible, true);
  assert.ok(controls.height > 0);
  assert.ok(await page.locator('.window-tabs').evaluate(node =>
    node.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(node).paddingLeft)) >= controls.x);
  assert.ok(await page.locator('#desktop').evaluate(node => node.getBoundingClientRect().top) >= controls.height);
  for (const [theme, color] of [['dark', 'rgb(24, 24, 24)'], ['light', 'rgb(247, 247, 247)']]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const top = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      overlayBackground: getComputedStyle(document.querySelector('.app'), '::before').backgroundColor,
      border: getComputedStyle(document.querySelector('.app'), '::before').borderBottomWidth
    }));
    assert.equal(top.background, color);
    assert.equal(top.overlayBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(top.border, '0px');
    await page.screenshot({ path: `.test-results/native-overlay-${theme}.png` });
  }
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  assert.equal(await page.locator('#content').evaluate(node => node.getBoundingClientRect().top), 0);
  await page.getByRole('button', { name: '显示插件栏', exact: true }).click();
  await page.locator('.shelf-app').first().click();
  assert.ok(await page.locator('.application-window').first().evaluate(node => node.getBoundingClientRect().top) >= controls.height);
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  assert.ok(await page.locator('.application-window').first().evaluate(node => node.getBoundingClientRect().top) >= controls.height);
});

test('desktop UI: independent plugin settings preserve host metadata, frame state and scoped RPC', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(() => localStorage.setItem('test-settings', 'yes'));
  await openConfiguration(page);
  const card = page.locator('.plugin-card').first();
  assert.equal(await card.getByRole('button', { name: '修改图标', exact: true }).count(), 0);
  await card.getByRole('button', { name: '插件配置', exact: true }).click();
  const dialog = page.locator('dialog.plugin-settings');
  await dialog.getByText('作者：测试作者', { exact: true }).waitFor();
  assert.match(await dialog.locator('.plugin-settings-metadata').innerText(), /v1.2.3/);
  const frame = dialog.locator('iframe');
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  const content = frame.contentFrame();
  await content.locator('body[data-result]').waitFor();
  const result = JSON.parse(await content.locator('body').getAttribute('data-result'));
  assert.deepEqual(result.value, { pluginId: 'desktop-probe-0', method: 'settings.read' });
  await content.getByRole('textbox', { name: '测试配置' }).fill('尚未保存的配置');
  await page.waitForFunction(() => document.querySelector('.plugin-settings-icon img')?.naturalWidth > 0);
  const oldIcon = await dialog.locator('.plugin-settings-icon img').getAttribute('src');
  await dialog.getByRole('button', { name: '修改图标', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('test-icon-changed') === 'desktop-probe-0');
  assert.equal(await content.getByRole('textbox').inputValue(), '尚未保存的配置');
  assert.notEqual(await dialog.locator('.plugin-settings-icon img').getAttribute('src'), oldIcon);
  const box = await dialog.boundingBox();
  const size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(box.x + box.width / 2 - size.width / 2) < 2);
  await dialog.screenshot({ path: resolve('.test-results/plugin-settings.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.evaluate(() => workDesk.plugins.disable('desktop-probe-0'));
  await card.getByRole('button', { name: '插件配置', exact: true }).click();
  await dialog.getByText('启用插件后可设置。', { exact: true }).waitFor();
  assert.equal(await dialog.locator('iframe').count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('.plugin-card').nth(1).getByRole('button', { name: '插件配置', exact: true }).click();
  await dialog.getByText('作者：未提供', { exact: true }).waitFor();
  assert.equal(await dialog.locator('iframe').count(), 0);
});

test('desktop UI: plugin settings releases its frame on disable, close and uninstall', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(() => localStorage.setItem('test-settings', 'yes'));
  await openConfiguration(page);
  const open = () => page.locator('.plugin-card').first().getByRole('button', { name: '插件配置', exact: true }).click();
  const dialog = page.locator('dialog.plugin-settings');
  await open();
  await dialog.locator('iframe').waitFor();
  await page.evaluate(() => window.workDesk.plugins.disable('desktop-probe-0'));
  await dialog.getByText('启用插件后可设置。', { exact: true }).waitFor();
  assert.equal(await dialog.locator('iframe').count(), 0);
  await page.evaluate(() => window.workDesk.plugins.enable('desktop-probe-0'));
  await dialog.locator('iframe').waitFor();
  await page.evaluate(() => window.workDesk.plugins.close('desktop-probe-0'));
  await dialog.waitFor({ state: 'detached' });
  await open();
  await dialog.locator('iframe').waitFor();
  await page.evaluate(() => {
    localStorage.setItem('test-plugin-state:0', 'uninstalled');
    return window.workDesk.plugins.enable('desktop-probe-1');
  });
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.plugin-card[data-plugin="desktop-probe-0"]').count(), 0);
});

test('desktop UI: plugin content fills its shell without a second title bar or window mode controls', async t => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  const root = page.locator('.application-window');
  assert.equal(await root.locator('.window-title, .window-actions').count(), 0);
  for (const name of ['最小化', '最大化', '平铺到桌面', '普通窗口']) {
    assert.equal(await root.getByRole('button', { name, exact: true }).count(), 0);
  }
  assert.equal(await root.evaluate(node => getComputedStyle(node).webkitAppRegion), 'no-drag');
  const shell = await root.boundingBox();
  const body = await root.locator('.window-body').boundingBox();
  assert.deepEqual(body, shell);
  assert.equal(await root.locator('.window-resize').count(), 0);
  assert.deepEqual(await root.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.borderTopWidth, style.borderRadius, style.boxShadow];
  }), ['0px', '0px', 'none']);
  assert.equal(await page.getByRole('tablist').evaluate(node => getComputedStyle(node).borderBottomWidth), '0px');
  assert.ok(shell.y >= (await page.getByRole('tablist').boundingBox()).height);
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await page.getByRole('tab').evaluate(node => getComputedStyle(node).backgroundColor),
      await root.evaluate(node => getComputedStyle(node).backgroundColor));
    await page.screenshot({ path: `.test-results/plugin-shell-${theme}.png` });
  }
});

test('desktop UI: tabs switch retained workspace pages, hide close until hover and number each plugin independently', async t => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  const first = page.locator('.application-window').first();
  await first.frameLocator('iframe').locator('body').evaluate(node => { node.dataset.retained = 'first-tab'; });
  const geometry = await first.boundingBox();
  await page.getByRole('tab').first().dblclick();
  await page.locator('.shelf-app').nth(1).click();
  const tabs = page.getByRole('tab');
  assert.deepEqual(await tabs.locator('.tab-label').allTextContents(), ['测试图标1', '测试图标1', '测试图标2']);
  assert.deepEqual(await page.locator('.application-window').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['窗口1', '窗口2', '窗口1']);
  const alignment = await tabs.first().evaluate(node => ({
    tab: node.getBoundingClientRect().left,
    workspace: document.querySelector('#content').getBoundingClientRect().left
  }));
  assert.equal(alignment.tab, alignment.workspace, 'first tab must align with the workspace boundary');
  assert.equal(await page.locator('.bubble-rail, .session-bubble').count(), 0);
  assert.equal(await page.getByRole('button', { name: '最小化', exact: true }).count(), 0);
  assert.equal(await page.locator('.application-window:visible').count(), 1);
  await tabs.first().click();
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  assert.deepEqual(await first.boundingBox(), geometry);
  assert.equal(await first.frameLocator('iframe').locator('body').getAttribute('data-retained'), 'first-tab');
  const tabBounds = await tabs.first().boundingBox();
  assert.ok(geometry.y >= tabBounds.y + tabBounds.height);
  const strip = await page.getByRole('tablist').boundingBox();
  await page.mouse.move(strip.x + strip.width - 5, strip.y + strip.height / 2);
  // Keyboard focus intentionally reveals close; remove it to verify pointer-only hover.
  await tabs.first().evaluate(node => node.blur());
  const close = tabs.first().getByRole('button', { name: '关闭窗口', exact: true });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.window-tab .tab-close')).opacity === '0');
  assert.equal(await close.evaluate(node => getComputedStyle(node).opacity), '0');
  await tabs.first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.window-tab .tab-close')).opacity === '1');
  assert.equal(await close.evaluate(node => getComputedStyle(node).opacity), '1');
  assert.notEqual(await tabs.first().evaluate(node => getComputedStyle(node).backgroundColor),
    await tabs.nth(1).evaluate(node => getComputedStyle(node).backgroundColor));
  await close.click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(await tabs.locator('.tab-label').allTextContents(), ['测试图标1', '测试图标2']);
  assert.deepEqual(await page.locator('.application-window').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['窗口1', '窗口1']);
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  await tabs.first().dblclick();
  assert.deepEqual(await tabs.locator('.tab-label').allTextContents(), ['测试图标1', '测试图标2', '测试图标1']);
  assert.deepEqual(await page.locator('.application-window').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['窗口1', '窗口1', '窗口2']);
  await page.locator('#desktop').click();
  assert.equal(await page.locator('.application-window:visible').count(), 0);
  assert.equal(await tabs.count(), 3);
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const colors = await tabs.evaluateAll(nodes => nodes.slice(0, 2).map(node => {
      const rgb = getComputedStyle(node).backgroundColor.match(/\d+/g).map(Number);
      return rgb.slice(0, 3).reduce((sum, value) => sum + value, 0) / 3;
    }));
    assert.notEqual(colors[0], colors[1], 'selected surface must differ from inactive tabs in either theme');
    assert.ok(theme !== 'light' || colors.every(value => value >= 220), 'light tabs must remain light');
    await page.screenshot({ path: `.test-results/plugin-tabs-${theme}.png` });
  }
});


test('desktop UI: plugin pages fill the workspace through sidebar and native resizing', async t => {
  const { app, page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  const root = page.locator('.application-window').first();
  await root.frameLocator('iframe').locator('body').evaluate(node => { node.dataset.retained = 'full-workspace'; });
  const assertFilled = async () => {
    const content = await page.locator('#content').boundingBox();
    const tabs = await page.getByRole('tablist').boundingBox();
    assert.deepEqual(await root.boundingBox(), {
      x: content.x, y: tabs.y + tabs.height, width: content.width, height: content.height - tabs.height
    });
  };
  await assertFilled();
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  await assertFilled();
  await page.getByRole('button', { name: '显示插件栏', exact: true }).click();
  await assertFilled();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 650));
  await page.waitForFunction(() => innerWidth === 1000);
  await assertFilled();
  await page.locator('.shelf-app').nth(1).click();
  await page.getByRole('tab').first().click();
  await assertFilled();
  assert.equal(await root.frameLocator('iframe').locator('body').getAttribute('data-retained'), 'full-workspace');
  assert.equal(await root.locator('.window-resize').count(), 0);
});


test('desktop UI: single-instance windows hide creation and retain the existing frame', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(() => localStorage.setItem('test-single-instance', '1'));
  await page.reload();
  const launcher = page.locator('.shelf-app').first();
  await launcher.click();
  const root = page.locator('.application-window');
  await root.frameLocator('iframe').locator('body').evaluate(node => { node.dataset.retained = 'single'; });
  assert.equal(await root.getByRole('button', { name: '新建窗口', exact: true }).count(), 0);
  await page.getByRole('tab').dispatchEvent('contextmenu');
  assert.equal(await page.getByRole('menuitem', { name: '新建窗口', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('tab').dblclick();
  await launcher.click();
  assert.equal(await root.count(), 1);
  assert.equal(await root.frameLocator('iframe').locator('body').getAttribute('data-retained'), 'single');
});


test('desktop UI: selected tabs share every plugin canvas while inactive tabs share the sidebar and strip', async t => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  await page.locator('.shelf-app').nth(1).click();
  const palettes = [
    'ai-agent/src/renderer/workspace.css', 'ai-agent/src/renderer/conversation.css',
    'mcp/src/renderer/style.css', 'text-editor/src/renderer/app.css', 'code-browser/src/renderer/style.css',
    'work-flow/src/renderer/style.css', 'codex-capture/src/renderer/style.css', 'resource-monitor/src/renderer/style.css'
  ];
  const frame = page.locator('.application-window').last().frameLocator('iframe');
  for (const [theme, canvas, chrome] of [['dark', 'rgb(24, 24, 24)', 'rgb(34, 34, 34)'],
    ['light', 'rgb(247, 247, 247)', 'rgb(239, 239, 239)']]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const surfaces = await page.evaluate(() => {
      const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
      return { selected: color('.window-tab[aria-selected=true]'), inactive: color('.window-tab[aria-selected=false]'),
        strip: color('.window-tabs'), shelf: color('.plugin-shelf'), footer: color('.shelf-footer'), home: color('.titlebar') };
    });
    assert.deepEqual(surfaces, { selected: canvas, inactive: chrome, strip: chrome, shelf: chrome, footer: chrome, home: chrome });
    assert.equal(await page.locator('.application-window').last().evaluate(node => getComputedStyle(node).borderTopLeftRadius), '10px');
    assert.equal(await page.locator('.window-tab[aria-selected=true]').evaluate(node => getComputedStyle(node, '::before').pointerEvents), 'none');
    assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).color),
      theme === 'dark' ? 'rgb(173, 176, 183)' : 'rgb(41, 39, 51)');
    const iconFilter = await page.evaluate(() => {
      const icon = document.createElement('img');
      icon.className = 'plugin-icon-image';
      document.body.append(icon);
      const filter = getComputedStyle(icon).filter;
      icon.remove();
      return filter;
    });
    assert.equal(iconFilter, theme === 'dark' ? 'invert(1) brightness(0.74)' : 'none');
    for (const path of palettes) {
      const css = await readFile(resolve('plugin-dev', path), 'utf8');
      const palette = await frame.locator('body').evaluate((body, { css, theme }) => {
        document.head.querySelectorAll('style').forEach(node => node.remove());
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        document.documentElement.dataset.theme = theme;
        const icon = document.createElement('img');
        icon.className = 'empty-symbol';
        body.append(icon);
        const iconFilter = getComputedStyle(icon).filter;
        icon.remove();
        const color = getComputedStyle(body).backgroundColor;
        return { background: color === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.documentElement).backgroundColor : color,
          text: getComputedStyle(body).color, iconFilter };
      }, { css, theme });
      assert.equal(palette.background, canvas, `${path}: ${theme} canvas`);
      if (theme === 'dark') {
        assert.equal(palette.text, 'rgb(173, 176, 183)', `${path}: softened dark text`);
      }
      if (path === 'ai-agent/src/renderer/workspace.css') {
        assert.equal(palette.iconFilter, theme === 'dark' ? 'invert(1) brightness(0.74)' : 'none');
      }
    }
    await page.screenshot({ path: `.test-results/unified-surfaces-${theme}.png` });
  }
});

test('desktop UI: shared form and floating surfaces match across every packaged view', { timeout: 60000 }, async t => {
  const { page } = await launchDesktop(t);
  const entries = ['desk', 'ai-agent/app', 'ai-agent/conversation', 'ai-agent/settings', 'mcp/app',
    'text-editor/app', 'codex-capture/app', 'resource-monitor/app', 'work-flow/app', 'code-browser/app'];
  const appearance = node => {
    const style = getComputedStyle(node);
    return Object.fromEntries(['backgroundColor', 'color', 'borderColor', 'borderWidth', 'borderRadius',
      'boxShadow', 'fontSize', 'lineHeight', 'padding'].map(key => [key, style[key]]));
  };
  const css = await Promise.all(entries.map(async entry => {
    if (entry === 'desk') {
      return readFile('desk/dist/renderer/app.css', 'utf8');
    }
    const [plugin, view] = entry.split('/');
    const manifest = JSON.parse(await readFile(`plugin-dev/${plugin}/plugin.json`, 'utf8'));
    const directory = manifest.views[0].entry.slice(0, manifest.views[0].entry.lastIndexOf('/'));
    return readFile(`plugin-dev/${plugin}/${directory}/${view}.css`, 'utf8');
  }));
  for (const theme of ['light', 'dark']) {
    let expected;
    for (const [index, entry] of entries.entries()) {
      // Load only built CSS in isolated documents, never plugin scripts or saved user data.
      await page.evaluate(({ css, theme }) => {
        document.querySelector('#surface-fixture')?.remove();
        const frame = document.createElement('iframe');
        frame.id = 'surface-fixture';
        frame.style.cssText = 'position:fixed;top:0;left:250px;width:600px;height:700px;z-index:2147483647';
        frame.srcdoc = `<html data-theme="${theme}"><head><style>${css}</style></head><body style="padding:16px">
          <section class="engine-page configuration-dialog"><input id="field" placeholder="输入内容" aria-label="输入内容">
          <input id="password" type="password"><input id="number" type="number">
          <textarea id="multiline" aria-label="多行内容"></textarea>
          <button class="icon icon-button" title="确认" aria-label="确认"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></button>
          ${['save-cli', 'provider-save', 'save-services'].map(id => `<button id="${id}" class="icon-button"><svg width="20" height="20"
            fill="none" stroke="currentColor"><path d="m5 12 4 4 10-10"/></svg></button>`).join('')}</section>
          <div role="tooltip" class="settings-tooltip" style="display:block;position:static">帮助说明</div>
          <div class="context-menu" style="position:static">菜单</div><div id="toast" style="position:static;transform:none">已保存</div>
          <dialog open class="configuration-dialog confirmation-dialog user-input-dialog" style="position:static;width:400px">
          <div class="dialog-heading">确认操作</div><div class="dialog-body">保留现有数据</div>
          <div class="dialog-actions">${['icon primary', 'icon danger', 'icon-button primary', 'icon-button danger'].map((classes, index) =>
            `<button id="confirm-${index}" class="${classes}" title="确认操作"><svg width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="1.6"><path d="m5 12 4 4 10-10"/></svg></button>`).join('')}</div></dialog></body></html>`;
        document.body.append(frame);
      }, { css: css[index], theme });
      const frame = page.frameLocator('#surface-fixture');
      const selectors = ['#field', '#password', '#number', '#multiline', '[role=tooltip]', '.context-menu', '#toast',
        'dialog', '.dialog-heading', '.dialog-body', '.dialog-actions'];
      const actual = await Promise.all(selectors.map(selector => frame.locator(selector).evaluate(appearance)));
      expected ??= actual;
      assert.deepEqual(actual, expected, `${entry}: ${theme} public appearance`);
      const field = frame.locator('#field');
      await field.fill('测试');
      await field.focus();
      assert.equal(await field.inputValue(), '测试');
      assert.equal(await field.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
      assert.equal(await field.evaluate(node => node.getBoundingClientRect().height), 44);
      await field.evaluate(node => { node.disabled = true; });
      assert.equal(await field.evaluate(node => getComputedStyle(node).opacity), '0.5');
      const button = frame.getByRole('button', { name: '确认', exact: true }).first();
      await button.hover();
      assert.equal(await button.evaluate(node => getComputedStyle(node).filter), 'none');
      for (let index = 0; index < 4; index++) {
        const confirm = frame.locator(`#confirm-${index}`);
        const expectedColor = theme === 'light' ? 'rgb(41, 39, 51)' : 'rgb(173, 176, 183)';
        // Filled-action classes must not leave white strokes when shared icon buttons remove the fill.
        const checkStroke = async () => assert.equal(await confirm.locator('svg').evaluate(node => getComputedStyle(node).stroke),
          expectedColor, `${entry}: ${theme} confirmation ${index} remains visible`);
        await checkStroke();
        await confirm.hover();
        await checkStroke();
        await confirm.focus();
        await checkStroke();
        await confirm.evaluate(node => { node.disabled = true; });
        await checkStroke();
        assert.equal(await confirm.evaluate(node => getComputedStyle(node).opacity), '0.5');
        await confirm.evaluate(node => { node.disabled = false; });
      }
      for (const id of ['save-cli', 'provider-save', 'save-services']) {
        const contrast = await frame.locator(`#${id} svg`).evaluate(node => {
          const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
            const channel = value / 255;
            return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
          }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
          const foreground = luminance(getComputedStyle(node).stroke);
          const surface = luminance(getComputedStyle(document.querySelector('dialog')).backgroundColor);
          return (Math.max(foreground, surface) + .05) / (Math.min(foreground, surface) + .05);
        });
        assert.ok(contrast >= 3, `${entry}: ${theme} ${id} icon contrast ${contrast} must be at least 3:1`);
      }
      if (entry === 'ai-agent/app') {
        await page.screenshot({ path: `.test-results/shared-surfaces-${theme}.png` });
      }
    }
  }
  await page.locator('#surface-fixture').evaluate(node => node.remove());
});

test('desktop UI: minimize retains frame and input, restores from launcher and keeps open indicator', async t => {
  const { page } = await launchDesktop(t);
  const launcher = page.locator('.shelf-app').first();
  await launcher.click();
  const root = page.locator('.application-window').first();
  const body = root.frameLocator('iframe').locator('body');
  await body.evaluate(node => {
    const input = document.createElement('input');
    input.id = 'retained-input';
    input.value = 'unsaved input';
    node.append(input);
    window.visibilityEvents = [];
    window.addEventListener('message', event => {
      if (event.data?.type === 'desk:visibility') {
        window.visibilityEvents.push(event.data.visible);
      }
    });
  });
  assert.equal(await launcher.getAttribute('data-open'), 'true');
  await page.getByRole('tab').getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.application-window').style.visibility === 'hidden');
  assert.equal(await body.evaluate(() => window.visibilityEvents.at(-1)), false);
  assert.equal(await page.getByRole('tab').count(), 0);
  assert.equal(await page.locator('.application-window iframe').count(), 1);
  assert.equal(await launcher.getAttribute('data-open'), 'true');
  await launcher.click();
  await page.getByRole('tab').waitFor();
  assert.equal(await page.locator('.application-window iframe').count(), 1);
  assert.equal(await body.locator('#retained-input').inputValue(), 'unsaved input');
  assert.equal(await body.evaluate(() => window.visibilityEvents.at(-1)), true);
  await page.getByRole('tab').dblclick();
  await page.getByRole('tab').last().getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.application-window').dataset.phase === 'open');
  assert.equal(await page.getByRole('tab').count(), 1);
  await page.getByRole('tab').getByRole('button', { name: '关闭窗口', exact: true }).click();
  assert.equal(await page.locator('.application-window').count(), 1);
  assert.equal(await page.getByRole('tab').count(), 0);
  await launcher.click();
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.equal(await page.locator('.application-window').getAttribute('data-window'), '2');
  await page.getByRole('tab').getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.application-window'));
  assert.equal(await launcher.getAttribute('data-open'), 'false');
});


test('desktop UI: creates and copies files, prefers declared text provider and falls back when disabled', async t => {
  const { app, page } = await launchDesktop(t);
  const desktop = page.locator('.desktop-surface');
  await desktop.click({ button: 'right', position: { x: 200, y: 200 } });
  await page.getByRole('menuitem', { name: '创建文件', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input').fill('note.md');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const file = page.getByRole('button', { name: '打开文件 note.md', exact: true });
  await file.waitFor();
  await file.dblclick();
  const body = page.locator('.application-window iframe').contentFrame().locator('body');
  const context = await body.evaluate(() => new Promise(resolve => {
    window.addEventListener('message', function receive(event) {
      if (event.data.id === 'launch-test') {
        window.removeEventListener('message', receive);
        resolve(event.data.value);
      }
    });
    parent.postMessage({ type: 'desk:invoke', id: 'launch-test', method: 'host.getLaunchContext', args: [] }, '*');
  }));
  assert.match(context.path, /desktop-files\/note\.md$/);
  assert.equal(await readFile(context.path, 'utf8'), '');
  await page.locator('#desktop').click();
  const source = await mkdtemp(join(tmpdir(), 'desktop-drop-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const path = join(source, 'note.md');
  await writeFile(path, 'original content');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file'; input.id = 'drop-fixture'; document.body.append(input);
  });
  await page.locator('#drop-fixture').setInputFiles(path);
  await page.locator('#drop-fixture').evaluate(node => {
    const transfer = new DataTransfer();
    transfer.items.add(node.files[0]);
    document.querySelector('.desktop-surface').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    node.remove();
  });
  await page.getByRole('button', { name: '打开文件 note (1).md', exact: true }).waitFor();
  assert.equal(await readFile(path, 'utf8'), 'original content');
  const copied = await page.evaluate(() => workDesk.desktop.resolve('note (1).md'));
  assert.equal(await readFile(copied, 'utf8'), 'original content');
  await page.evaluate(() => localStorage.setItem('test-plugin-state:0', 'disabled'));
  await page.reload();
  await file.waitFor();
  await file.dblclick();
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(() => global.lastExternalFile), 'note.md');
  assert.equal(await page.locator('.application-window').count(), 0);
});


test('desktop UI: removes stale files on returning home, refocusing and a failed open', async t => {
  const { app, page } = await launchDesktop(t);
  const root = await app.evaluate(({ app }) => app.getPath('userData'));
  const directory = join(root, 'desktop-files');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'removed.txt'), 'test');
  await page.reload();
  const file = page.getByRole('button', { name: '打开文件 removed.txt', exact: true });
  await file.waitFor();
  await rm(join(directory, 'removed.txt'));
  await file.dblclick();
  await file.waitFor({ state: 'detached' });
  assert.match(await page.locator('#toast').textContent(), /文件已被移走或删除/);
  assert.equal(await page.locator('.application-window').count(), 0);
  await page.locator('.shelf-app').first().click();
  await writeFile(join(directory, 'returned.txt'), 'test');
  await page.locator('#desktop').click();
  await page.getByRole('button', { name: '打开文件 returned.txt', exact: true }).waitFor();
  await rm(join(directory, 'returned.txt'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: '打开文件 returned.txt', exact: true }).waitFor({ state: 'detached' });
});

test('desktop UI: single-instance minimized window restores without motion and can be minimized by keyboard', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(() => localStorage.setItem('test-single-instance', '1'));
  await page.reload();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const launcher = page.locator('.shelf-app').first();
  await launcher.click();
  const minimize = page.getByRole('button', { name: '最小化窗口', exact: true });
  await minimize.focus();
  await minimize.press('Enter');
  await page.waitForFunction(() => document.querySelector('.application-window').style.visibility === 'hidden');
  await launcher.click();
  assert.equal(await page.locator('.application-window').count(), 1);
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.equal(await page.locator('.application-window').evaluate(node => node.getAnimations().length), 0);
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: resolve(`.test-results/desktop-minimize-${theme}.png`) });
  }
});


test('desktop UI: file context menu renames and confirms moving only the selected file to Trash', async t => {
  const { app, page } = await launchDesktop(t);
  await page.evaluate(async () => { await workDesk.desktop.create('rename.txt'); await workDesk.desktop.create('keep.txt'); });
  await page.reload();
  const original = page.getByRole('button', { name: '打开文件 rename.txt', exact: true });
  await original.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByRole('dialog').locator('input').fill('renamed.md');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  const renamed = page.getByRole('button', { name: '打开文件 renamed.md', exact: true });
  await renamed.waitFor();
  assert.equal(await original.count(), 0);
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到废纸篓', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await renamed.count(), 1);
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到废纸篓', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await renamed.waitFor({ state: 'detached' });
  assert.match(await app.evaluate(() => global.lastTrashedFile), /desktop-files\/renamed.md$/);
  assert.equal(await page.getByRole('button', { name: '打开文件 keep.txt', exact: true }).count(), 1);
});

test('desktop UI: desktop files move independently, yield temporarily, persist and use format icons', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(async () => {
    for (const name of ['a.txt', 'b.png', 'c.json', 'd.zip', 'e.pdf', 'f.mp3', 'g.mp4', 'h.xlsx']) {
      await workDesk.desktop.create(name);
    }
  });
  await page.reload();
  const files = page.locator('.desktop-file');
  await files.first().waitFor();
  const paths = await files.locator('svg path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
  assert.equal(new Set(paths).size, 8);
  const areas = () => files.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
  const original = await areas();
  assert.ok(original.every(Boolean));
  const source = await files.first().boundingBox();
  const target = await files.nth(1).boundingBox();
  await files.first().evaluate(node => { node.setPointerCapture = () => {}; });
  const pointer = (type, x, y) => files.first().dispatchEvent(type,
    { pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x + 10, clientY: y + 10, bubbles: true });
  await pointer('pointerdown', source.x, source.y);
  await pointer('pointermove', target.x, target.y);
  const preview = await areas();
  assert.notEqual(preview[1], original[1]);
  await pointer('pointermove', source.x, source.y);
  assert.deepEqual(await areas(), original);
  await pointer('pointermove', target.x, target.y);
  await pointer('pointerup', target.x, target.y);
  assert.deepEqual(await areas(), preview);
  assert.equal(await page.locator('iframe').count(), 0);
  await page.reload();
  await files.first().waitFor();
  assert.deepEqual(await areas(), preview);
  const first = files.first();
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.locator('dialog input').fill('renamed.md');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const renamed = page.getByRole('button', { name: '打开文件 renamed.md', exact: true });
  await renamed.waitFor();
  assert.equal(await renamed.evaluate(node => node.style.gridArea), preview[0]);
  assert.equal(await files.locator('.shelf-icon-resize').count(), 8);
});

test('desktop UI: file placement leaves empty cells, stays independent and keeps overflow files reachable', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(async () => {
    await workDesk.desktop.create('move.txt');
    await workDesk.desktop.create('stay.txt');
  });
  await page.reload();
  const files = page.locator('.desktop-file');
  await files.first().waitFor();
  const original = await files.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
  const source = await files.first().boundingBox();
  await page.bringToFront();
  await page.mouse.move(source.x + 15, source.y + 15);
  await page.mouse.down();
  await page.mouse.move(source.x + 215, source.y + 165, { steps: 10 });
  await page.mouse.up();
  const moved = await files.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
  assert.notEqual(moved[0], original[0]);
  assert.equal(moved[1], original[1]);
  await files.first().focus();
  await files.first().press('Enter');
  await page.waitForFunction(() => document.querySelector('iframe'));
  await page.locator('#desktop').click();
  await page.evaluate(async () => {
    for (let i = 0; i < 80; i++) {
      await workDesk.desktop.create(`overflow-${i}.txt`);
    }
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.desktop-file').length === 82);
  assert.equal(await page.locator('.desktop-file[hidden]').count(), 0);
  await files.last().scrollIntoViewIfNeeded();
  const last = await files.last().boundingBox();
  assert.ok(last.y >= 0 && last.y + last.height <= 800);
});


test('desktop UI: desktop file icons resize persistently and complete names wrap without overlap', async t => {
  const { page } = await launchDesktop(t);
  const name = '完整文件名称-technical-design-with-a-long-name-that-must-remain-readable.md';
  await page.evaluate(async name => {
    await workDesk.desktop.create(name);
    await workDesk.desktop.create('neighbor.png');
  }, name);
  await page.reload();
  const file = page.getByRole('button', { name: `打开文件 ${name}`, exact: true });
  await file.waitFor();
  const label = file.locator('.desktop-file-name');
  assert.equal(await label.textContent(), name);
  assert.ok(await label.evaluate(node => node.clientHeight >= node.scrollHeight));
  const before = await file.locator('svg').boundingBox();
  assert.ok(before.width >= 48);
  const handle = file.getByRole('button', { name: '调整图标大小' });
  await handle.focus();
  await handle.press('ArrowRight');
  const after = await file.locator('svg').boundingBox();
  assert.ok(after.width > before.width);
  assert.equal(after.width, after.height);
  await file.evaluate(node => { node.setPointerCapture = () => {}; });
  const grip = await handle.boundingBox();
  await handle.dispatchEvent('pointerdown', { pointerId: 2, button: 0, clientX: grip.x, clientY: grip.y, bubbles: true });
  await file.dispatchEvent('pointermove', { pointerId: 2, clientX: grip.x + 50, clientY: grip.y + 50, bubbles: true });
  await file.dispatchEvent('pointerup', { pointerId: 2, clientX: grip.x + 50, clientY: grip.y + 50, bubbles: true });
  const resized = await file.locator('svg').boundingBox();
  assert.ok(resized.width > after.width);
  const other = page.getByRole('button', { name: '打开文件 neighbor.png', exact: true });
  const a = await file.boundingBox();
  const b = await other.boundingBox();
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  await page.reload();
  await file.waitFor();
  assert.equal((await file.locator('svg').boundingBox()).width, resized.width);
  assert.ok(await label.evaluate(node => node.clientHeight >= node.scrollHeight));
});


test('desktop UI: launcher restores every minimized sibling without reloading frames', async t => {
  const { page } = await launchDesktop(t);
  const launcher = page.locator('.shelf-app').first();
  await launcher.click();
  await page.getByRole('tab').dblclick();
  for (const root of await page.locator('.application-window').all()) {
    await root.frameLocator('iframe').locator('body').evaluate(node => node.dataset.retained = 'yes');
  }
  await page.getByRole('tab').last().getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.getByRole('tab').getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.window-tab')].every(tab => tab.hidden));
  await launcher.click();
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await page.locator('.application-window').count(), 2);
  for (const root of await page.locator('.application-window').all()) {
    assert.equal(await root.frameLocator('iframe').locator('body').getAttribute('data-retained'), 'yes');
  }
});


test('desktop UI: plugin window policy updates existing tabs and icon editing sits in the upper corner', async t => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  const configure = async () => {
    await openConfiguration(page);
    await page.locator('.plugin-card').first().getByRole('button', { name: '插件配置', exact: true }).click();
    return page.locator('dialog.plugin-settings');
  };
  let dialog = await configure();
  await dialog.getByRole('switch', { name: '支持多开', exact: true }).waitFor();
  const policy = await dialog.locator('.plugin-window-policy').first().boundingBox();
  const switchBox = await dialog.getByRole('switch', { name: '支持多开', exact: true }).boundingBox();
  assert.ok(Math.abs(policy.x + policy.width - switchBox.x - switchBox.width) < 1);
  assert.equal(await dialog.getByRole('switch', { name: '支持多开', exact: true }).evaluate(node => getComputedStyle(node, '::after').backgroundColor), 'rgb(255, 255, 255)');
  const image = await dialog.locator('.plugin-settings-icon img').boundingBox();
  const edit = await dialog.getByRole('button', { name: '修改图标', exact: true }).boundingBox();
  assert.ok(edit.x > image.x + image.width / 2 && edit.y < image.y);
  assert.equal(await dialog.getByRole('button', { name: '修改图标', exact: true }).evaluate(node => getComputedStyle(node).borderRadius), '50%');
  assert.equal(await dialog.getByRole('switch', { name: '支持多开', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(0, 185, 107)');
  assert.equal(await dialog.getByRole('switch', { name: '支持多开', exact: true }).getAttribute('aria-checked'), 'true');
  await dialog.getByRole('switch', { name: '支持多开', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.multiple-windows-toggle').getAttribute('aria-checked') === 'false');
  await dialog.screenshot({ path: resolve('.test-results/plugin-window-policy.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.getByRole('tab').dblclick();
  assert.equal(await page.locator('.application-window').count(), 1);
  dialog = await configure();
  await dialog.getByRole('switch', { name: '支持多开', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.multiple-windows-toggle').getAttribute('aria-checked') === 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.getByRole('tab').dblclick();
  assert.equal(await page.locator('.application-window').count(), 2);
});


test('desktop UI: auto start opens only opted-in enabled plugins once per desktop launch', async t => {
  const { page } = await launchDesktop(t);
  assert.equal(await page.locator('.application-window').count(), 0);
  await openConfiguration(page);
  await page.locator('.plugin-card').first().getByRole('button', { name: '插件配置', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '自动启动', exact: true });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('.auto-start-toggle')?.getAttribute('aria-checked') === 'true');
  assert.equal(await page.locator('.application-window').count(), 0, 'changing the preference does not open a window');
  await page.evaluate(() => {
    localStorage.setItem('test-auto-start:1', 'true');
    localStorage.setItem('test-plugin-state:1', 'disabled');
  });
  await page.reload();
  await page.locator('.application-window').waitFor();
  assert.equal(await page.locator('.application-window').count(), 1);
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.match(await page.getByRole('tab').innerText(), /测试图标1/);
  await page.getByRole('tab').getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.evaluate(() => window.workDesk.plugins.setAutoStart('desktop-probe-2', false));
  await page.waitForFunction(() => [...document.querySelectorAll('.window-tab')].every(tab => tab.hidden));
  await page.evaluate(() => window.workDesk.plugins.setAutoStart('desktop-probe-0', false));
  await page.reload();
  await page.locator('.shelf-app').first().waitFor();
  assert.equal(await page.locator('.application-window').count(), 0);
});


test('desktop UI: shared preference switches retain keyboard, theme and narrow layout behavior in plugin styles', async t => {
  const { page } = await launchDesktop(t);
  for (const [directory, css, source, selector] of [
    ['ai-agent', 'settings.css', 'src/resource/settings.html', '#reuse-skills'],
    ['resource-monitor', 'app.css', 'src/renderer/app.js', '#compact'],
    ['work-flow', 'app.css', 'src/renderer/app.js', '#trigger-enabled']
  ]) {
    const styles = await readFile(resolve(`plugin-dev/${directory}/dist/renderer/${css}`), 'utf8');
    const markup = await readFile(resolve(`plugin-dev/${directory}/${source}`), 'utf8');
    const id = selector.slice(1);
    assert.match(markup, new RegExp(`<input[^>]*id="${id}"[^>]*role="switch"|<input[^>]*role="switch"[^>]*id="${id}"|id: '${id}', type: 'checkbox', role: 'switch'`));
    // Render only controls in an isolated frame, without starting plugin services or touching user data.
    await page.locator('body').evaluate((body, { styles, id }) => {
      document.querySelector('#switch-preview')?.remove();
      const preview = document.createElement('iframe');
      preview.id = 'switch-preview';
      preview.style.cssText = 'position:fixed;inset:0;width:300px;height:180px;z-index:99999;background:white';
      preview.srcdoc = `<style>${styles}</style><body class="engine-page"><label class="row" style="width:240px">Preference<input type="checkbox" role="switch" id="${id}"></label>`;
      body.append(preview);
    }, { styles, id });
    const frame = page.frameLocator('#switch-preview');
    const control = frame.getByRole('switch', { name: 'Preference' });
    await control.waitFor();
    for (const theme of ['light', 'dark']) {
      await frame.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
      await control.uncheck();
      await control.focus();
      await control.press('Space');
      assert.equal(await control.isChecked(), true);
      await page.waitForTimeout(220);
      assert.deepEqual(await control.evaluate(node => {
        const style = getComputedStyle(node);
        const thumb = getComputedStyle(node, '::after');
        return [style.width, style.height, style.backgroundColor, thumb.backgroundColor, thumb.transform];
      }), ['40px', '24px', 'rgb(0, 185, 107)', 'rgb(255, 255, 255)', 'matrix(1, 0, 0, 1, 16, 0)']);
      const label = await frame.locator('label').boundingBox();
      const box = await control.boundingBox();
      assert.ok(Math.abs(label.x + label.width - box.x - box.width) < 1);
      await control.uncheck();
      await page.waitForTimeout(220);
      assert.equal(await control.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(120, 124, 132)');
      await control.evaluate(node => { node.disabled = true; });
      assert.equal(await control.evaluate(node => getComputedStyle(node).opacity), '0.5');
      await control.evaluate(node => { node.disabled = false; });
    }
  }
});

test('desktop UI: file properties, copy menu and paste shortcuts preserve text editing', async t => {
  const { app, page } = await launchDesktop(t);
  const root = await app.evaluate(({ app }) => app.getPath('userData'));
  await page.evaluate(() => workDesk.desktop.create('clipboard.md'));
  await writeFile(join(root, 'desktop-files', 'clipboard.md'), 'desktop clipboard');
  await page.reload();
  const file = page.getByRole('button', { name: '打开文件 clipboard.md', exact: true });
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '属性', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '文件属性', exact: true });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /17 B/);
  assert.match(await dialog.textContent(), /desktop-files\/clipboard.md/);
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await dialog.screenshot({ path: resolve(`.test-results/desktop-file-properties-${theme}.png`) });
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await page.locator('.desktop-surface').click({ button: 'right', position: { x: 350, y: 250 } });
  await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  await page.getByRole('button', { name: '打开文件 clipboard (1).md', exact: true }).waitFor();
  assert.equal(await readFile(join(root, 'desktop-files', 'clipboard (1).md'), 'utf8'), 'desktop clipboard');
  await file.focus();
  await file.press('ControlOrMeta+c');
  await file.press('ControlOrMeta+v');
  await page.getByRole('button', { name: '打开文件 clipboard (2).md', exact: true }).waitFor();
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const input = page.getByRole('dialog').locator('input');
  await input.press('ControlOrMeta+v');
  assert.equal(await page.getByRole('button', { name: '打开文件 clipboard (3).md', exact: true }).count(), 0);
});


test('desktop UI: top tabs drag insert in both directions without reloading plugin frames', async t => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  await page.getByRole('tab').first().dblclick();
  await page.getByRole('tab').first().dblclick();
  const order = () => page.locator('.window-tab').evaluateAll(nodes => nodes.map(node => node.dataset.window));
  const initial = await order();
  await page.evaluate(() => { window.retainedFrames = [...document.querySelectorAll('.application-window iframe')]; });
  const drag = async (id, targetId, fraction) => {
    const source = await page.locator(`.window-tab[data-window="${id}"]`).boundingBox();
    const target = await page.locator(`.window-tab[data-window="${targetId}"]`).boundingBox();
    await page.mouse.move(source.x + 24, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width * fraction, target.y + target.height / 2, { steps: 15 });
    await page.mouse.up();
    await page.locator('.window-tabs').evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
  };
  await drag(initial[2], initial[0], 0.2);
  assert.deepEqual(await order(), [initial[2], initial[0], initial[1]]);
  await drag(initial[2], initial[1], 0.9);
  assert.deepEqual(await order(), initial);
  await drag(initial[0], initial[1], 0.9);
  assert.deepEqual(await order(), [initial[1], initial[0], initial[2]]);
  assert.equal(await page.locator('.window-tab[aria-selected=true]').getAttribute('data-window'), initial[2]);
  await page.locator(`.window-tab[data-window="${initial[1]}"]`).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.window-tab[aria-selected=true]').getAttribute('data-window'), initial[0]);
  assert.equal(await page.evaluate(() => window.retainedFrames.every((frame, index) =>
    frame === document.querySelectorAll('.application-window iframe')[index] && frame.isConnected)), true);
  assert.equal(await page.locator('.window-tab.dragging').count(), 0);
});

test('desktop UI: large popups and desktop settings stay centered while small menus remain anchored', async t => {
  const { page } = await launchDesktop(t);
  await openConfiguration(page);
  const centered = async selector => {
    await page.waitForFunction(selector => {
      const bounds = document.querySelector(selector).getBoundingClientRect();
      return Math.abs(bounds.left + bounds.width / 2 - innerWidth / 2) < 1
        && Math.abs(bounds.top + bounds.height / 2 - innerHeight / 2) < 1;
    }, selector);
  };
  await centered('#settings-panel');
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  const source = await readFile('desk/src/resource/popup.js', 'utf8');
  await page.evaluate(source => {
    const { showPopup } = new Function(`${source.replaceAll('export ', '')}; return { showPopup };`)();
    const trigger = document.createElement('button');
    trigger.style.cssText = 'position:fixed;left:8px;top:80px';
    const panel = document.createElement('dialog');
    panel.id = 'large-popup';
    panel.style.cssText = 'width:640px;height:400px';
    document.body.append(trigger, panel);
    showPopup(panel, trigger);
  }, source);
  await centered('#large-popup');
  await page.locator('#large-popup').evaluate(node => { node.style.height = '500px'; });
  await centered('#large-popup');
  await page.setViewportSize({ width: 480, height: 600 });
  await centered('#large-popup');
});

test('desktop UI: shared popups keep theme, edge placement, nested cancellation and native dialog results', async t => {
  const { page } = await launchDesktop(t);
  await page.waitForSelector('.desktop-surface');
  const source = await readFile('desk/src/resource/popup.js', 'utf8');
  await page.evaluate(source => {
    const { showPopup } = new Function(`${source.replaceAll('export ', '')}; return { showPopup };`)();
    const trigger = document.createElement('button');
    trigger.id = 'popup-trigger';
    trigger.style.cssText = 'position:fixed;right:16px;top:100px';
    trigger.textContent = 'Open';
    const dialog = document.createElement('dialog');
    dialog.id = 'popup-parent';
    dialog.style.width = '320px';
    dialog.innerHTML = '<button id="popup-child-trigger">Child</button><button id="popup-confirm">Confirm</button>';
    const child = document.createElement('dialog');
    child.id = 'popup-child';
    child.style.width = '220px';
    child.innerHTML = '<input aria-label="Child input">';
    document.body.append(trigger, dialog, child);
    trigger.onclick = () => showPopup(dialog, trigger);
    dialog.querySelector('#popup-child-trigger').onclick = event => showPopup(child, event.currentTarget);
    dialog.querySelector('#popup-confirm').onclick = () => dialog.close('confirmed');
  }, source);
  await page.locator('#popup-trigger').click();
  const parent = page.locator('#popup-parent');
  await page.waitForFunction(() => document.querySelector('#popup-parent').matches(':popover-open'));
  const triggerBounds = await page.locator('#popup-trigger').boundingBox();
  const bounds = await parent.boundingBox();
  assert.ok(bounds.x + bounds.width <= triggerBounds.x);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const styles = await parent.evaluate(node => {
      const css = getComputedStyle(node);
      return [css.backgroundColor, css.borderRadius, getComputedStyle(node, '::backdrop').backdropFilter];
    });
    assert.deepEqual(styles, [theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(34, 34, 34)', '12px', 'none']);
  }
  await parent.locator('#popup-child-trigger').click();
  await page.waitForFunction(() => document.querySelector('#popup-child').matches(':popover-open'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#popup-child').matches(':popover-open'));
  assert.equal(await parent.evaluate(node => node.open), true);
  await parent.locator('#popup-confirm').click();
  await page.waitForFunction(() => !document.querySelector('#popup-parent').matches(':popover-open'));
  assert.equal(await parent.evaluate(node => node.returnValue), 'confirmed');
  await page.locator('#popup-trigger').click();
  await page.mouse.click(700, 650);
  await page.waitForFunction(() => !document.querySelector('#popup-parent').open);
  assert.equal(await parent.evaluate(node => node.returnValue), '');
  await page.setViewportSize({ width: 380, height: 500 });
  await page.locator('#popup-trigger').click();
  const narrow = await parent.boundingBox();
  assert.ok(narrow.x >= 8 && narrow.x + narrow.width <= 372, JSON.stringify(narrow));
  assert.ok(narrow.y >= 8 && narrow.y + narrow.height <= 492);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await parent.evaluate(node => getComputedStyle(node).animationName), 'none');
  await parent.evaluate(node => node.addEventListener('cancel', event => event.preventDefault(), { once: true }));
  await page.keyboard.press('Escape');
  assert.equal(await parent.evaluate(node => node.open), true, 'an in-progress action can prevent dismissal');
  await page.evaluate(() => {
    const panel = document.querySelector('#popup-parent');
    panel.close();
    document.querySelector('#popup-trigger').click();
  });
  await page.waitForFunction(() => document.querySelector('#popup-parent').open);
  await parent.locator('#popup-child-trigger').click();
  await parent.evaluate(node => node.close());
  await page.waitForFunction(() => !document.querySelector('#popup-child').matches(':popover-open'));
  assert.equal(await page.locator('#popup-child').evaluate(node => node.open), false);
  await page.locator('#popup-trigger').click();
  await page.setViewportSize({ width: 300, height: 300 });
  await page.waitForFunction(() => {
    const bounds = document.querySelector('#popup-parent').getBoundingClientRect();
    return bounds.left >= 8 && bounds.right <= innerWidth - 8;
  });
  await mkdir('.test-results', { recursive: true });
  await page.screenshot({ path: '.test-results/shared-popup-dark.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({ path: '.test-results/shared-popup-light.png' });
});


test('desktop UI: option menus show icons and translated labels and dismiss only after leaving', async t => {
  const { page } = await launchDesktop(t);
  const desktop = page.locator('.desktop-surface');
  for (const [language, create] of [['zh-CN', '创建文件'], ['en', 'Create file']]) {
    await page.evaluate(language => { document.documentElement.lang = language; }, language);
    await desktop.click({ button: 'right', position: { x: 300, y: 200 } });
    const menu = page.locator('.desk-option-menu[role=menu]');
    const item = menu.getByRole('menuitem', { name: create, exact: true });
    assert.equal(await item.locator('span').textContent(), create);
    assert.equal(await item.locator('svg').count(), 1);
    await item.hover();
    await page.waitForTimeout(300);
    assert.equal(await menu.isVisible(), true);
    await page.mouse.move(1000, 700);
    await menu.waitFor({ state: 'detached' });
  }
});

test('desktop UI: option submenu gap is safe and leaving forms does not dismiss them', async t => {
  const { page } = await launchDesktop(t);
  await page.waitForSelector('.desktop-surface');
  const source = await readFile('desk/src/resource/popup.js', 'utf8');
  await page.evaluate(source => {
    const { showPopup } = new Function(`${source.replaceAll('export ', '')}; return { showPopup };`)();
    const trigger = document.createElement('button');
    trigger.style.cssText = 'position:fixed;left:200px;top:200px';
    const menu = document.createElement('div');
    menu.id = 'leave-parent';
    menu.role = 'menu';
    menu.className = 'context-menu desk-option-menu';
    menu.innerHTML = '<button role="menuitem">Submenu</button>';
    const child = document.createElement('div');
    child.id = 'leave-child';
    child.role = 'menu';
    child.className = 'context-menu desk-option-menu';
    child.innerHTML = '<button role="menuitem">Choose</button>';
    const form = document.createElement('dialog');
    form.id = 'leave-form';
    form.innerHTML = '<input aria-label="Name"><button>Save</button>';
    document.body.append(trigger, menu, child, form);
    menu.firstChild.onclick = () => showPopup(child, menu.firstChild);
    window.openLeaveForm = () => showPopup(form, trigger);
    showPopup(menu, trigger);
  }, source);
  const parent = page.locator('#leave-parent');
  const child = page.locator('#leave-child');
  await parent.getByRole('menuitem').click();
  await child.getByRole('menuitem').hover();
  await page.waitForTimeout(350);
  assert.equal(await parent.isVisible(), true, 'moving into the submenu keeps its parent open');
  assert.equal(await child.isVisible(), true);
  await page.mouse.move(1000, 700);
  await page.waitForFunction(() => !document.querySelector('#leave-parent').matches(':popover-open')
    && !document.querySelector('#leave-child').matches(':popover-open'));
  await page.evaluate(() => window.openLeaveForm());
  await page.locator('#leave-form input').hover();
  await page.mouse.move(1000, 700);
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#leave-form').isVisible(), true, 'content forms remain open on pointer exit');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#leave-form').matches(':popover-open'));
});

test('desktop UI: AI option menus keep visible bilingual labels, disabled actions and pointer dismissal', async t => {
  const { page } = await launchDesktop(t);
  await page.waitForSelector('.desktop-surface');
  const { build } = await import('esbuild');
  const bundle = await build({
    stdin: {
      contents: `import { groupNavigation } from './plugin-dev/ai-agent/src/renderer/session-groups.js';
        window.createMenuNavigation = groupNavigation;`,
      resolveDir: process.cwd()
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome145'
  });
  await page.evaluate(source => new Function(source)(), bundle.outputFiles[0].text);
  await page.evaluate(() => {
    const navigation = window.createMenuNavigation({
      select() {}, focus() {}, move() {}, add() {}, rename() {}, remove() {}, save() {},
      presentation: { expandedGroups: ['example'] }
    });
    navigation.node.style.cssText = 'position:fixed;left:250px;top:150px;width:220px;z-index:999';
    document.body.append(navigation.node);
    navigation.update([{ id: 'example', name: 'Example' }], [
      { id: 'idle', groupId: 'example', name: 'Idle', activity: 'idle' },
      { id: 'busy', groupId: 'example', name: 'Busy', activity: 'working' }
    ], 'example');
  });
  for (const [language, rename, move] of [['zh-CN', '修改组名', '换组'], ['en', 'Rename group', 'Move to group']]) {
    await page.evaluate(language => { document.documentElement.lang = language; }, language);
    await page.locator('[data-navigation="group:example"]').click({ button: 'right' });
    const menu = page.locator('.group-context-menu');
    assert.equal(await menu.getByRole('menuitem').count(), 3);
    const action = menu.getByRole('menuitem', { name: rename, exact: true });
    assert.equal(await action.locator('span').textContent(), rename);
    assert.equal(await action.locator('svg').count(), 1);
    await action.hover();
    await page.mouse.move(1000, 700);
    await menu.waitFor({ state: 'detached' });
    await page.locator('[data-navigation="member:busy"]').click({ button: 'right' });
    assert.equal(await menu.getByRole('menuitem', { name: move, exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    await page.locator('[data-navigation="member:idle"]').click({ button: 'right' });
    assert.equal(await menu.getByRole('menuitem', { name: move, exact: true }).isEnabled(), true);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
  }
});

test('desktop UI: plugin cards reorder inside settings and retain order after reload', async t => {
  const { page } = await launchDesktop(t);
  await openConfiguration(page);
  await page.getByRole('button', { name: '列表展示', exact: true }).click();
  const cards = page.locator('#settings-panel .plugin-card');
  const original = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.plugin));
  const first = cards.nth(0);
  const second = cards.nth(1);
  await second.locator('h2').dragTo(first.locator('h2'));
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.plugin)),
    [original[1], original[0], ...original.slice(2)]);
  await page.reload();
  await openConfiguration(page);
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.plugin)),
    [original[1], original[0], ...original.slice(2)]);
  const target = cards.nth(1);
  const bounds = await target.boundingBox();
  await cards.nth(0).locator('.plugin-sort-handle').dragTo(target, {
    targetPosition: { x: 20, y: bounds.height - 5 }
  });
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.plugin)), original);
});


test('desktop UI: narrowing and widening the shelf packs all fitting icons without overwriting preferences', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-width', '300');
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`desktop-probe-${i}`, { col: i % 2 * 6, row: Math.floor(i / 2) * 7, span: 4 }]))));
  });
  await page.reload();
  await icons.first().waitFor();
  const shelf = page.locator('.plugin-shelf');
  await shelf.evaluate(node => { node.style.height = '600px'; node.style.bottom = 'auto'; });
  const areas = () => icons.evaluateAll(nodes => nodes.map(node => node.style.gridArea));
  const stored = await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout'));
  await page.locator('.desktop-stage').evaluate(node => node.style.setProperty('--shelf-preferred-width', '64px'));
  await page.waitForFunction(() => document.querySelector('.plugin-shelf').clientWidth === 64);
  await page.waitForTimeout(100);
  const compact = await icons.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { hidden: node.hidden, x: rect.x, top: rect.top, bottom: rect.bottom, row: Number(node.style.gridRowStart) };
  }));
  assert.ok(compact.every(node => !node.hidden), 'all six icons fit in the narrow shelf');
  assert.equal(new Set(compact.map(node => Math.round(node.x))).size, 1);
  for (let i = 1; i < compact.length; i++) {
    assert.ok(compact[i].top >= compact[i - 1].bottom, 'icons never overlap');
    assert.equal(compact[i].row - compact[i - 1].row, 3, 'narrowing removes obsolete row gaps');
  }
  assert.ok(compact.at(-1).bottom <= (await shelf.boundingBox()).y + 600);
  assert.equal(await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout')), stored);
  await page.locator('.desktop-stage').evaluate(node => node.style.setProperty('--shelf-preferred-width', '90px'));
  await page.waitForFunction(() => document.querySelector('.plugin-shelf').clientWidth === 90);
  await page.waitForTimeout(100);
  const bounds = await shelf.boundingBox();
  const centers = await icons.locator('.shelf-icon').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return rect.x + rect.width / 2;
  }));
  assert.ok(centers.every(center => Math.abs(center - bounds.x - bounds.width / 2) < 1), 'single-column icons stay centered');
  await page.locator('.desktop-stage').evaluate(node => node.style.setProperty('--shelf-preferred-width', '300px'));
  await page.waitForFunction(() => document.querySelector('.plugin-shelf').clientWidth === 300);
  await page.waitForTimeout(100);
  assert.ok((await areas()).every(area => area.includes('span 3')));
  assert.equal(await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout')), stored);
});


test('desktop UI: shelf limits each row to two icons and each labeled icon to twelve cells', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-width', '300');
    localStorage.removeItem('plugin-shelf-fine-layout');
  });
  await page.reload();
  await icons.first().waitFor();
  const placements = () => icons.evaluateAll(nodes => nodes.map(node => ({
    row: Number(node.style.gridRowStart),
    width: Number(node.style.gridColumnEnd.replace('span ', '')),
    height: Number(node.style.gridRowEnd.replace('span ', '')),
    hidden: node.hidden
  })));
  const initial = await placements();
  assert.ok(initial.every(icon => !icon.hidden));
  for (const row of new Set(initial.map(icon => icon.row))) {
    assert.ok(initial.filter(icon => icon.row === row).length <= 2, 'at most two icons share a row');
  }
  await page.evaluate(() => localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`desktop-probe-${i}`, { col: 0, row: i * 5, span: 2 }])))));
  await page.reload();
  await icons.first().waitFor();
  const handle = icons.first().locator('.shelf-icon-resize');
  await handle.focus();
  for (let i = 0; i < 12; i++) {
    await handle.press('ArrowRight');
  }
  assert.equal((await placements())[0].width * (await placements())[0].height, 12, 'resizing reaches twelve cells and stops');
  assert.ok((await placements()).every(icon => icon.width * icon.height <= 12), 'name cells count toward the size limit');
  await page.reload();
  await icons.first().waitFor();
  assert.ok((await placements()).every(icon => icon.width * icon.height <= 12), 'size limit survives reload');
});


test('desktop UI: resizing a shelf aligns valid sparse placements without changing saved sizes', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-width', '100');
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`desktop-probe-${i}`, { col: 0, row: i * 7, span: 2 }]))));
  });
  await page.reload();
  await icons.first().waitFor();
  const stored = await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout'));
  for (const width of [80, 180]) {
    await page.locator('.desktop-stage').evaluate((node, width) =>
      node.style.setProperty('--shelf-preferred-width', `${width}px`), width);
    await page.waitForTimeout(250);
    const layout = await icons.evaluateAll(nodes => nodes.map(node => ({
      row: Number(node.style.gridRowStart), col: Number(node.style.gridColumnStart), hidden: node.hidden
    })));
    assert.ok(layout.every(icon => !icon.hidden));
    assert.deepEqual(layout.map(icon => [icon.row, icon.col]), width === 80
      ? Array.from({ length: 6 }, (_, i) => [1 + i * 3, 1])
      : Array.from({ length: 6 }, (_, i) => [1 + Math.floor(i / 2) * 3, 1 + i % 2 * 2]));
  }
  assert.equal(await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout')), stored);
});

test('desktop UI: single-instance launch requests reach retained frames before and after initialization', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(async () => {
    localStorage.setItem('test-single-instance', '1');
    await workDesk.desktop.create('first.md');
    await workDesk.desktop.create('second.md');
    await workDesk.desktop.create('third.md');
  });
  await page.reload();
  const open = async name => {
    await page.locator('#desktop').click();
    await page.getByRole('button', { name: `打开文件 ${name}`, exact: true }).dblclick();
  };
  await open('first.md');
  const body = page.locator('.application-window iframe').contentFrame().locator('body');
  const identity = await body.evaluate(() => {
    window.launches = [];
    window.addEventListener('message', event => {
      if (event.source === parent && event.origin === 'desk-host://desktop' && event.data?.type === 'desk:launch') {
        window.launches.push(event.data.context);
        document.body.dataset.launchCount = String(window.launches.length);
      }
    });
    window.readLaunch = () => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => reject(Error('Launch context timed out')), 3000);
      window.addEventListener('message', function receive(event) {
        if (event.source === parent && event.origin === 'desk-host://desktop' && event.data?.id === id) {
          clearTimeout(timer);
          window.removeEventListener('message', receive);
          resolve(event.data.value);
        }
      });
      parent.postMessage({ type: 'desk:invoke', id, method: 'host.getLaunchContext', args: [] }, 'desk-host://desktop');
    });
    return window.retainedIdentity = crypto.randomUUID();
  });
  await open('second.md');
  const context = await body.evaluate(() => window.readLaunch());
  assert.match(context.path, /desktop-files\/second\.md$/);
  assert.deepEqual(await body.evaluate(() => window.launches), [], 'startup reads the latest request without duplicate events');
  await open('third.md');
  await page.locator('.application-window iframe').contentFrame().locator('body[data-launch-count="1"]').waitFor();
  const launches = await body.evaluate(() => window.launches);
  assert.equal(launches.length, 1);
  assert.match(launches[0].path, /desktop-files\/third\.md$/);
  assert.deepEqual(await body.evaluate(() => window.readLaunch()), launches[0]);
  assert.equal(await body.evaluate(() => window.retainedIdentity), identity);
  assert.equal(await page.locator('.application-window').count(), 1);
  await page.locator('#desktop').click();
  await page.locator('.shelf-app').first().click();
  assert.equal(await body.evaluate(() => window.launches.length), 1, 'restoring from the launcher must not reopen a file');
});

test('desktop UI: conversation font overrides preserve default fields and wrap large text', async t => {
  const { page } = await launchDesktop(t);
  const css = await readFile('desk/dist/renderer/app.css', 'utf8');
  for (const theme of ['light', 'dark']) {
    // Exercise shared controls without loading a business plugin or reading installed data.
    await page.evaluate(({ css, theme }) => {
      document.querySelector('#font-fixture')?.remove();
      const frame = document.createElement('iframe');
      frame.id = 'font-fixture';
      frame.style.cssText = 'position:fixed;inset:0;width:320px;height:600px;z-index:99999';
      frame.srcdoc = `<html data-theme="${theme}"><style>${css}</style><body style="padding:12px">
        <textarea id="default-field" aria-label="默认输入"></textarea>
        <div class="desk-intervention-composer"><textarea id="default-reply" aria-label="默认回答"></textarea></div>
        <div style="--desk-field-font-size:24px;--desk-field-line-height:39.6px">
          <textarea id="large-field" aria-label="大字输入"></textarea>
          <div class="desk-intervention-composer"><textarea id="large-reply" aria-label="大字回答"></textarea></div>
        </div></body></html>`;
      document.body.append(frame);
    }, { css, theme });
    const frame = page.frameLocator('#font-fixture');
    for (const [id, fontSize, lineHeight] of [['default-field', 13, 18], ['default-reply', 14, 23.1],
      ['large-field', 24, 39.6], ['large-reply', 24, 39.6]]) {
      const field = frame.locator(`#${id}`);
      await field.waitFor();
      const measure = () => field.evaluate(node => {
        const style = getComputedStyle(node);
        return [Number.parseFloat(style.fontSize), Number.parseFloat(style.lineHeight)];
      });
      assert.deepEqual(await measure(), [fontSize, lineHeight]);
      await field.focus();
      await page.waitForTimeout(200);
      const focused = await measure();
      assert.ok(Math.abs(focused[0] - fontSize * 1.05) < .01, `${id}: focused font ${focused[0]}`);
      assert.equal(focused[1], lineHeight);
      await field.fill('自动换行LongUnbrokenInput'.repeat(20));
      assert.equal(await field.evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight > node.clientHeight), true);
      await field.evaluate(node => { node.disabled = true; });
      assert.equal(await field.isDisabled(), true);
      assert.equal(await field.evaluate(node => getComputedStyle(node).opacity), '0.5');
    }
  }
});

test('desktop UI: all shared menus follow pointer or button even in narrow windows', async t => {
  const { page } = await launchDesktop(t);
  await page.waitForSelector('.desktop-surface');
  const source = await readFile('desk/src/resource/popup.js', 'utf8');
  await page.evaluate(source => {
    const { showPopup, closePopup } = new Function(`${source.replaceAll('export ', '')}; return { showPopup, closePopup };`)();
    window.popupPlacement = { showPopup, closePopup };
    const anchor = document.createElement('button');
    anchor.id = 'placement-anchor';
    anchor.style.cssText = 'position:fixed;left:20px;top:100px;width:300px;height:30px';
    const menu = document.createElement('div');
    menu.id = 'placement-menu';
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.cssText = 'position:fixed;inset:auto;margin:0;width:360px;height:150px;box-sizing:border-box';
    menu.innerHTML = '<button role="menuitem">Action</button>';
    document.body.append(anchor, menu);
  }, source);
  for (const theme of ['light', 'dark']) {
    for (const width of [1100, 480]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        popupPlacement.showPopup(document.querySelector('#placement-menu'), document.querySelector('#placement-anchor'),
          { point: { x: 50, y: 115 } });
      }, theme);
      const bounds = await page.locator('#placement-menu').boundingBox();
      assert.ok(Math.abs(bounds.x - 58) < 1 && Math.abs(bounds.y - 115) < 1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#placement-menu').matches(':popover-open'));
      await page.evaluate(() => popupPlacement.showPopup(document.querySelector('#placement-menu'),
        document.querySelector('#placement-anchor'), { point: { x: innerWidth - 20, y: innerHeight - 20 } }));
      const edge = await page.locator('#placement-menu').boundingBox();
      assert.ok(edge.x >= 8 && edge.x + edge.width <= width - 8);
      assert.ok(edge.y >= 8 && edge.y + edge.height <= 692);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#placement-menu').matches(':popover-open'));
    }
  }
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.evaluate(() => popupPlacement.showPopup(document.querySelector('#placement-menu'), document.querySelector('#placement-anchor')));
  const menu = await page.locator('#placement-menu').boundingBox();
  const anchor = await page.locator('#placement-anchor').boundingBox();
  assert.ok(Math.abs(menu.x - (anchor.x + anchor.width + 8)) < 1);
  await page.keyboard.press('Escape');
});


test('desktop UI: AI sidebar context menus anchor to the pointer and retain keyboard anchoring', async t => {
  const { page } = await launchDesktop(t);
  await page.waitForSelector('.desktop-surface');
  const { build } = await import('esbuild');
  const bundle = await build({ stdin: {
    contents: `import { groupNavigation } from './plugin-dev/ai-agent/src/renderer/session-groups.js';
      window.createMenuNavigation = groupNavigation;`, resolveDir: process.cwd()
  }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  await page.evaluate(source => new Function(source)(), bundle.outputFiles[0].text);
  await page.evaluate(() => {
    const navigation = createMenuNavigation({ select() {}, focus() {}, move() {}, add() {}, rename() {}, remove() {}, save() {},
      presentation: { expandedGroups: ['example'] } });
    navigation.node.style.cssText = 'position:fixed;left:250px;top:150px;width:320px;z-index:999';
    document.body.append(navigation.node);
    navigation.update([{ id: 'example', name: 'Example' }], [], 'example');
  });
  const heading = page.locator('[data-navigation="group:example"]');
  await heading.click({ button: 'right', position: { x: 25, y: 12 } });
  const box = await heading.boundingBox();
  const menu = page.locator('.group-context-menu');
  const bounds = await menu.boundingBox();
  assert.ok(Math.abs(bounds.x - (box.x + 25 + 8)) < 2);
  assert.ok(Math.abs(bounds.y - (box.y + 12)) < 2);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await heading.focus();
  await heading.press('Shift+F10');
  const keyboard = await menu.boundingBox();
  assert.ok(Math.abs(keyboard.x - (box.x + box.width + 8)) < 2);
});
