import { openConfiguration } from './helpers.js';
import { windowOptions } from '../../src/main/os/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

test('desktop UI: launcher restores its latest window and tab double-click explicitly creates a fresh window', async t => {
  const { page } = await launchDesktop(t);
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

test('desktop UI: plugin toolbar separates navigation and shows accessible sliding switches without a reset action', async t => {
  const { page } = await launchDesktop(t);
  await openConfiguration(page);
  const toolbar = page.locator('.plugin-toolbar');
  await toolbar.waitFor();
  assert.equal(await toolbar.getByRole('button', { name: '开发插件', exact: true }).count(), 0);
  const importBox = await toolbar.getByRole('button', { name: '导入本地插件', exact: true }).boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  assert.ok(Math.abs(importBox.x + importBox.width - toolbarBox.x - toolbarBox.width) < 1);
  assert.equal(await page.locator('.settings-tabs .layout-options').count(), 0);
  assert.equal(await page.getByText('插件中心', { exact: true }).count(), 0);
  assert.equal(await page.locator('.settings-body h1, .settings-body .eyebrow').count(), 0);
  assert.equal(await page.locator('.plugin-card .badge').count(), 0);
  const tabs = await page.locator('.settings-tabs').boundingBox();
  assert.ok((await toolbar.boundingBox()).y >= tabs.y + tabs.height);
  await toolbar.getByRole('button', { name: '列表展示', exact: true }).click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'list');
  const card = page.locator('.plugin-card').first();
  const enabled = card.getByRole('switch', { name: '禁用', exact: true });
  assert.equal(await enabled.getAttribute('aria-checked'), 'true');
  assert.equal(await enabled.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(0, 185, 107)');
  assert.equal(await card.getByRole('button', { name: '恢复默认图标', exact: true }).count(), 0);
  const onPosition = await enabled.locator('.plugin-toggle-thumb').evaluate(node => getComputedStyle(node).transform);
  assert.equal(await card.locator('.row-actions .plugin-toggle').count(), 0);
  assert.equal(await card.locator(':scope > .plugin-toggle').count(), 1);
  await enabled.click();
  const disabled = card.getByRole('switch', { name: '启用', exact: true });
  await disabled.waitFor();
  assert.equal(await disabled.getAttribute('aria-checked'), 'false');
  assert.notEqual(await disabled.locator('.plugin-toggle-thumb').evaluate(node => getComputedStyle(node).transform), onPosition);
  await disabled.focus();
  await disabled.press('Space');
  await enabled.waitFor();
  await toolbar.getByRole('button', { name: '图框展示', exact: true }).click();
  assert.equal(await page.locator('.plugin-grid').getAttribute('data-layout'), 'grid');
  const controlBox = await enabled.boundingBox();
  const cardBox = await card.boundingBox();
  assert.ok(Math.abs(controlBox.y - cardBox.y - 25) < 1);
  assert.ok(Math.abs(cardBox.x + cardBox.width - controlBox.x - controlBox.width - 25) < 1);
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
  await dialog.getByText('确认关闭', { exact: true }).waitFor();
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
  assert.equal(await page.locator('.plugin-card').first().getByRole('switch', { name: '禁用', exact: true }).getAttribute('aria-checked'), 'true');
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
test('desktop UI: close confirmation omits stopped history and bounds active task titles', async t => {
  const { page } = await launchDesktop(t);
  await page.evaluate(() => localStorage.setItem('test-running-tasks', JSON.stringify([
    { name: '不应作为待关闭任务展示的历史会话', exited: true }
  ])));
  await page.locator('.shelf-app').first().click();
  const close = page.getByRole('button', { name: '关闭窗口', exact: true });
  await close.evaluate(node => node.click());
  const dialog = page.getByRole('dialog');
  await dialog.getByText('停止测试任务，保留记录。', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.confirm-session').count(), 0);
  assert.doesNotMatch(await dialog.innerText(), /将关闭|待归档|历史会话/);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const title = '执行中 ' + '较长的任务标题与用户消息 '.repeat(30);
  await page.evaluate(title => localStorage.setItem('test-running-tasks', JSON.stringify([
    { name: title, exited: false }, { name: '已完成会话', exited: true }
  ])), title);
  await close.evaluate(node => node.click());
  await dialog.getByText('将关闭 1 个任务。', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.confirm-session').count(), 1);
  const row = dialog.locator('.confirm-session');
  assert.equal(await row.getAttribute('title'), title);
  assert.equal(await row.evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');
  assert.doesNotMatch(await dialog.innerText(), /已完成会话|待归档/);
  await mkdir('.test-results', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await dialog.screenshot({ path: resolve(`.test-results/close-active-tasks-${theme}.png`) });
  }
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.application-window').count(), 1);
});

test('desktop UI: disable only confirms active tasks, with check and cross preserving cancellation', async t => {
  const { page } = await launchDesktop(t);
  await openConfiguration(page);
  const card = page.locator('.plugin-card').first();
  await page.evaluate(() => localStorage.setItem('test-running-tasks', JSON.stringify([
    { name: '执行中的任务', exited: false }, { name: '已停止的任务', exited: true }
  ])));
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  const dialog = page.locator('dialog');
  await dialog.getByText('执行中的任务', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button').count(), 2);
  assert.equal(await dialog.getByRole('button', { name: '关闭并禁用', exact: true }).locator('path').getAttribute('d'), 'm5 12 4 4L19 6');
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).locator('path').getAttribute('d'), 'm6 6 12 12M18 6 6 18');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await card.getByRole('switch', { name: '禁用', exact: true }).count(), 1);
  assert.equal(await page.locator('.shelf-app').count(), 6);
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await card.getByRole('switch', { name: '启用', exact: true }).waitFor();
  await card.getByRole('switch', { name: '启用', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('test-running-tasks', JSON.stringify([{ name: '已停止的任务', exited: true }])));
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  await card.getByRole('switch', { name: '启用', exact: true }).waitFor();
  assert.equal(await dialog.count(), 0);
});

test('desktop UI: a task starting after the idle preview requires a fresh disable confirmation', async t => {
  const { page } = await launchDesktop(t);
  await openConfiguration(page);
  await page.evaluate(() => localStorage.setItem('test-stale-confirmation', 'yes'));
  const card = page.locator('.plugin-card').first();
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  const dialog = page.locator('dialog');
  await dialog.getByText('新执行的任务', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('test-plugin-state:0')), null);
  await dialog.getByRole('button', { name: '关闭并禁用', exact: true }).click();
  await card.getByRole('switch', { name: '启用', exact: true }).waitFor();
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
  await page.evaluate(() => localStorage.setItem('plugin-shelf-width', '300'));
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
  const neighbor = await page.locator('.shelf-app').nth(1).boundingBox();
  await page.mouse.move(neighbor.x + 20, neighbor.y + 20);
  await page.mouse.down();
  await page.mouse.move(neighbor.x + 20, neighbor.y + 520, { steps: 16 });
  await page.mouse.up();
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
      const wrapRow = 4 + direction * height;
      await page.evaluate(({ direction, wrapRow }) => {
        const placements = [
          { col: direction === 1 ? 0 : 10, row: 6, span: 2 },
          ...Array.from({ length: 4 }, (_, i) => ({ col: direction === 1 ? 4 + i * 2 : 6 - i * 2, row: 4, span: 2 })),
          { col: direction === 1 ? 0 : 10, row: wrapRow, span: 2 }
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
      const expected = (direction === 1 ? [4, 6, 8, 10] : [6, 4, 2, 0])
        .map(col => `5 / ${col + 1} / span ${height} / span 2`);
      expected.push(...(direction === 1 ? [0, 2] : [10, 8])
        .map(col => `${wrapRow + 1} / ${col + 1} / span ${height} / span 2`));
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
  for (const start of [{ col: 0, row: 6 }, { col: 10, row: 6 }, { col: 4, row: 0 }, { col: 4, row: 12 }]) {
    await page.evaluate(start => {
      localStorage.setItem('plugin-shelf-width', '300');
      localStorage.setItem('plugin-shelf-show-names', 'true');
      localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries([
        { ...start, span: 2 }, { col: 4, row: 6, span: 2 }, { col: 6, row: 8, span: 2 },
        { col: 0, row: 10, span: 2 }, { col: 0, row: 16, span: 2 }, { col: 8, row: 16, span: 2 }
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
    assert.equal(inserted[1], `7 / ${start.col > 4 ? 3 : 7} / span 3 / span 2`);
    assert.equal(inserted[2], start.col > 4 ? original[2] : '9 / 9 / span 3 / span 2');
    assert.deepEqual(inserted.slice(3), original.slice(3));
    const cell = await page.locator('.plugin-shelf').evaluate(node => parseFloat(node.style.getPropertyValue('--shelf-cell-height')));
    await pointer('pointermove', target.x + 10 - 4 * cell, target.y + 10 - 4 * cell);
    assert.deepEqual((await areas()).slice(1), original.slice(1));
    await pointer('pointerup', target.x + 10 - 4 * cell, target.y + 10 - 4 * cell);
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
      { col: 10, row: 6, span: 2 },
      ...[0, 2, 4, 6].map(col => ({ col, row: 0, span: 2 })),
      { col: 8, row: 0, span: 4 }
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

test('desktop UI: shelf rejects bottom overflow and keeps dragging and resizing inside one screen', async t => {
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
    ...[4, 6, 8, 10].map(col => ({ col, row: rows - 3, span: 2 })),
    { col: 0, row: rows - 6, span: 2 }
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
  assert.deepEqual(await areas(), original);
  await pointer('pointerup', target.x + 10, target.y + 10);
  await page.reload();
  await icons.first().waitFor();
  assert.deepEqual(await areas(), original);

  await icons.first().evaluate(node => { node.setPointerCapture = () => {}; });
  await pointer('pointerdown', source.x + 10, source.y + 10);
  await pointer('pointermove', source.x + 10, source.y + 2000);
  await pointer('pointerup', source.x + 10, source.y + 2000);
  const inside = () => page.locator('.plugin-shelf').evaluate(node => {
    const shelf = node.getBoundingClientRect();
    return [...node.children].filter(child => !child.hidden).every(child => {
      const rect = child.getBoundingClientRect();
      return rect.top >= shelf.top && rect.bottom <= shelf.bottom;
    });
  });
  assert.equal(await inside(), true);
  const handle = icons.first().locator('.shelf-icon-resize');
  await handle.dispatchEvent('pointerdown', { pointerId: 1, button: 0, clientX: source.x + 10, clientY: source.y + 10, bubbles: true });
  await pointer('pointermove', source.x + 400, source.y + 2000);
  await pointer('pointerup', source.x + 400, source.y + 2000);
  assert.equal(await inside(), true);
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await inside(), true);
  assert.equal(await page.locator('.plugin-shelf').evaluate(node => {
    node.scrollTop = 10000;
    return node.scrollTop;
  }), 0);
  assert.equal(await page.locator('iframe').count(), 0);
});

test('desktop UI: shelf capacity stays finite and preserves saved positions when the viewport shrinks', async t => {
  const { page } = await launchDesktop(t);
  const icons = page.locator('.shelf-app');
  await icons.first().waitFor();
  await page.evaluate(() => localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`desktop-probe-${i}`, { col: 0, row: i * 100, span: 2 }])))));
  await page.reload();
  await icons.first().waitFor();
  const stored = await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout'));
  await page.locator('.plugin-shelf').evaluate(node => {
    node.style.height = '180px';
    node.style.bottom = 'auto';
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.shelf-app')].some(node => node.hidden));
  const capacity = await page.locator('.plugin-shelf').evaluate(node => {
    node.scrollTop = 10000;
    const rect = node.getBoundingClientRect();
    return { scroll: node.scrollTop, visible: [...node.children].filter(child => !child.hidden).length,
      inside: [...node.children].filter(child => !child.hidden).every(child => child.getBoundingClientRect().bottom <= rect.bottom) };
  });
  assert.ok(capacity.visible > 0 && capacity.visible < 6);
  assert.equal(capacity.inside, true);
  assert.equal(capacity.scroll, 0);
  await page.locator('.plugin-shelf').evaluate(node => {
    node.style.height = '';
    node.style.bottom = '';
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.shelf-app')].every(node => !node.hidden));
  assert.equal(await page.evaluate(() => localStorage.getItem('plugin-shelf-fine-layout')), stored);
  assert.equal(await page.locator('iframe').count(), 0);

  await page.evaluate(() => {
    localStorage.setItem('plugin-shelf-width', '300');
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`desktop-probe-${i}`, { col: i % 3 * 4, row: Math.floor(i / 3) * 5, span: 4 }]))));
  });
  await page.reload();
  await icons.first().waitFor();
  await page.locator('.plugin-shelf').evaluate(node => {
    node.style.height = '240px';
    node.style.bottom = 'auto';
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.shelf-app')].some(node => node.hidden));
  const hidden = () => icons.evaluateAll(nodes => nodes.map(node => node.hidden));
  const before = await hidden();
  const source = await icons.first().boundingBox();
  await icons.first().evaluate(node => { node.setPointerCapture = () => {}; });
  for (const [type, y] of [['pointerdown', source.y + 10], ['pointermove', source.y + 35], ['pointercancel', source.y + 35]]) {
    await icons.first().dispatchEvent(type, { pointerId: 1, button: 0, clientX: source.x + 10, clientY: y, bubbles: true });
    assert.deepEqual(await hidden(), before);
  }
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
        'desktop-probe-1': { col: 4, row: 0, span: 2 },
        'desktop-probe-2': { col: 6, row: 0, span: 4 },
        'desktop-probe-3': { col: 0, row: 14, span: 2 },
        'desktop-probe-4': { col: 0, row: 16, span: 2 },
        'desktop-probe-5': { col: 6, row: 7, span: 2 }
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
      assert.ok(a.col + a.width <= 13);
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
  await page.getByRole('checkbox', { name: '显示插件名称', exact: true }).uncheck();
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
  const names = page.getByRole('checkbox', { name: '显示插件名称', exact: true });
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
  const card = page.locator('.plugin-card[data-plugin="desktop-probe-0"]');
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
  await launcher.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.shelf-app').count(), 5);
  await card.getByRole('switch', { name: '启用', exact: true }).click();
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
  const arrow = grid.locator('..').locator('.select-arrow');
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await grid.evaluate(node => getComputedStyle(node).appearance), 'none');
  await page.bringToFront();
  await grid.hover();
  await page.waitForFunction(node => getComputedStyle(node).transform === 'matrix(1, 0, 0, 1, 0, 3)', await arrow.elementHandle());
  assert.equal(await arrow.evaluate(node => getComputedStyle(node).transitionDuration), '0.24s');
  await grid.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.equal(await grid.inputValue(), '24');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await grid.hover();
  assert.equal(await arrow.evaluate(node => getComputedStyle(node).transform), 'none');
  await page.screenshot({ path: '.test-results/settings-dropdown.png' });
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
  assert.equal(result.separator, '24px');
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
  assert.ok(await page.locator('.titlebar').evaluate(node => node.getBoundingClientRect().width) >= controls.x);
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
  await card.getByRole('switch', { name: '禁用', exact: true }).click();
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
    'mcp/src/renderer/style.css', 'text-editor/src/renderer/app.css',
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
    for (const path of palettes) {
      const css = await readFile(resolve('plugin-dev', path), 'utf8');
      const background = await frame.locator('body').evaluate((body, { css, theme }) => {
        document.head.querySelectorAll('style').forEach(node => node.remove());
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        document.documentElement.dataset.theme = theme;
        const color = getComputedStyle(body).backgroundColor;
        return color === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.documentElement).backgroundColor : color;
      }, { css, theme });
      assert.equal(background, canvas, `${path}: ${theme} canvas`);
    }
    await page.screenshot({ path: `.test-results/unified-surfaces-${theme}.png` });
  }
});
