import { openConfiguration } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
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
  await root.locator('.window-title').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click({ timeout: 4000 });
  await page.locator('dialog input').fill('我的工作会话');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await root.getAttribute('aria-label'), '我的工作会话');
  assert.equal(await root.locator('iframe').contentFrame().locator('body').getAttribute('data-retained'), 'renamed');
  await page.locator('#desktop').click();
  await page.locator('.shelf-app').nth(1).click();
  assert.equal(await root.getAttribute('aria-label'), '我的工作会话');
  const bubble = page.locator('.session-bubble').first();
  assert.equal(await bubble.getAttribute('title'), '我的工作会话');
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
  await page.getByRole('button', { name: '平铺到桌面', exact: true }).click();
  const size = () => page.locator('iframe').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }));
  await openConfiguration(page);
  await page.locator('#desktop-settings').click();
  await page.getByRole('combobox', { name: '插件图标大小', exact: true }).selectOption('48');
  await page.waitForFunction(() => document.querySelector('.shelf-icon').clientWidth === 46);
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'same-document');
  const before = await size();
  await page.getByRole('button', { name: '隐藏插件栏', exact: true }).click();
  await page.waitForFunction(width => document.querySelector('iframe').clientWidth > width, before.width);
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
  await first.evaluate(node => {
    window.shelfTrace = [];
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => node.addEventListener(type, event => {
      window.shelfTrace.push({ type, x: event.clientX, y: event.clientY, area: node.style.gridArea, target: event.target.className });
    }));
  });
  await page.mouse.move(start.x + start.width / 2, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + 260, { steps: 16 });
  await page.mouse.up();
  const moved = await first.boundingBox();
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
  // An occupied destination moves the other icons aside instead of overlapping or opening them.
  const destination = await page.locator('.shelf-app').nth(1).boundingBox();
  const source = await first.boundingBox();
  await page.mouse.move(source.x + 20, source.y + 20);
  await page.mouse.down();
  await page.mouse.move(destination.x + 20, destination.y + 20, { steps: 16 });
  await page.mouse.up();
  const occupied = await page.locator('.shelf-app').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }));
  occupied.forEach((a, i) => occupied.slice(i + 1).forEach(b => {
    assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  }));
  assert.equal(await page.locator('iframe').count(), 0);
  await first.click();
  await page.frameLocator('iframe').locator('h1').waitFor();
});

test('desktop UI: finer shelf cells, hidden labels and custom names persist without opening plugins', { timeout: 30000 }, async (t) => {
  const { page } = await launchDesktop(t);
  const first = page.locator('.shelf-app').first();
  await first.waitFor();
  assert.equal(await page.locator('.plugin-shelf').evaluate(node => parseFloat(node.style.getPropertyValue('--shelf-cell-height'))), 30);
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
  assert.equal(await page.locator('.plugin-shelf').evaluate(node => parseFloat(node.style.getPropertyValue('--shelf-cell-height'))), 30);
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
  assert.ok(moved.x > start.x + 15 && moved.x < start.x + 35);
  assert.ok(moved.y - start.y > 20 && moved.y - start.y < 30);
  const grip = first.getByRole('button', { name: '调整图标大小', exact: true });
  await grip.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await first.evaluate(node => node.style.gridColumnEnd), 'span 3');
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

test('desktop UI: force close stays available while task snapshot hangs and removes all target shells', async (t) => {
  const { page } = await launchDesktop(t);
  await page.locator('.shelf-app').first().click();
  await page.locator('.shelf-app').first().click();
  await page.locator('.shelf-app').nth(1).click();
  await page.evaluate(() => localStorage.setItem('test-preview-hang', 'yes'));
  await page.locator('.application-window').first().getByRole('button', { name: '关闭窗口', exact: true }).click({ force: true });
  await page.getByRole('button', { name: '强制关闭', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 3);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 3);
  await page.locator('.application-window').first().getByRole('button', { name: '关闭窗口', exact: true }).click({ force: true });
  await page.getByRole('button', { name: '强制关闭', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.application-window').length === 1);
  assert.equal(await page.locator('.application-window iframe').getAttribute('src').then(src => src.includes('desktop-probe-1')), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('test-force-closed')), 'desktop-probe-0');
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
