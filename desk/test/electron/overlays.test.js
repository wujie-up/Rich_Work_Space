import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('generic overlay retains its sandbox while collapsed, constrains movement and stays below settings', { timeout: 60000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'desk-overlays-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [resolve('desk/test/fixtures/desktop-ui/main.cjs'), `--test-data=${data}`], env });
  t.after(async () => { await app.close(); await rm(data, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.locator('.shelf-app').first().waitFor();
  assert.equal(await page.locator('.plugin-overlay').count(), 0);
  await page.evaluate(async () => { localStorage.setItem('test-overlays', '1'); await workDesk.plugins.setIcon('desktop-probe-0'); });
  const overlay = page.locator('.plugin-overlay');
  await overlay.waitFor({ timeout: 3000 });
  await overlay.locator('.overlay-summary').filter({ hasText: 'CPU 12%' }).waitFor({ state: 'attached' });
  const frame = overlay.frameLocator('iframe');
  await frame.locator('body').evaluate(node => { node.dataset.retained = 'yes'; });
  await overlay.getByRole('button', { name: '收起悬浮面板', exact: true }).click();
  assert.equal(Math.round((await overlay.boundingBox()).height), 36);
  assert.equal(await page.locator('.plugin-overlay iframe').count(), 1);
  await overlay.getByRole('button', { name: '展开悬浮面板', exact: true }).click();
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'yes');
  await overlay.getByRole('button', { name: '在窗口中打开', exact: true }).click();
  await page.locator('.application-window').waitFor();
  assert.ok(await overlay.evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + 20, box.y + 20));
  }));
  const handle = overlay.locator('.overlay-title');
  await handle.focus();
  for (let i = 0; i < 100; i++) {
    await handle.press('ArrowLeft');
    await handle.press('ArrowUp');
  }
  assert.ok((await overlay.boundingBox()).x >= 0);
  assert.ok((await overlay.boundingBox()).y >= 0);
  await page.locator('.desktop-surface').dispatchEvent('contextmenu', { clientX: 500, clientY: 300 });
  await page.getByRole('menuitem', { name: '添加插件', exact: true }).click();
  const settings = page.locator('#settings-panel');
  await settings.waitFor();
  assert.ok(Number(await settings.evaluate(node => getComputedStyle(node).zIndex)) >
    Number(await page.locator('.desktop-overlays').evaluate(node => getComputedStyle(node).zIndex)));
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await overlay.getByRole('button', { name: '收起悬浮面板', exact: true }).click();
  await page.reload();
  await page.locator('.plugin-overlay[data-collapsed=true]').waitFor();
  await page.evaluate(async () => { await workDesk.plugins.close('desktop-probe-0'); await workDesk.plugins.setIcon('desktop-probe-0'); });
  await overlay.waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('.shelf-app').first().waitFor();
  assert.equal(await overlay.count(), 0, 'closed enabled overlay must not silently reactivate');
});


test('single-instance overlay never creates tabs and relaunch expands its retained panel', { timeout: 60000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'desk-overlays-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [resolve('desk/test/fixtures/desktop-ui/main.cjs'), `--test-data=${data}`], env });
  t.after(async () => { await app.close(); await rm(data, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.locator('.shelf-app').first().waitFor();

  await page.evaluate(async () => {
    localStorage.setItem('test-overlays', '1');
    localStorage.setItem('test-single-instance', '1');
    await workDesk.plugins.setIcon('desktop-probe-0');
  });
  const overlay = page.locator('.plugin-overlay');
  await overlay.waitFor();
  assert.equal(await overlay.getByRole('button', { name: '在窗口中打开', exact: true }).count(), 0);
  await overlay.frameLocator('iframe').locator('body').evaluate(node => { node.dataset.retained = 'single-overlay'; });
  await overlay.getByRole('button', { name: '收起悬浮面板', exact: true }).click();
  assert.equal(Math.round((await overlay.boundingBox()).height), 36);
  await page.locator('.shelf-app').first().click();
  await page.locator('.plugin-overlay[data-collapsed=false]').waitFor();
  await page.locator('.shelf-app').first().click();
  assert.equal(await overlay.count(), 1);
  assert.equal(await page.locator('.application-window, .window-tab').count(), 0);
  assert.equal(await overlay.frameLocator('iframe').locator('body').getAttribute('data-retained'), 'single-overlay');
});
