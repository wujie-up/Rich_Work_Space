import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('history popover and file groups retain manual order and allow mouse/keyboard moves', { timeout: 120000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#editor-tools').waitFor();
  assert.equal(await frame.locator('.group-toolbar #add-group').count(), 0);
  const openCreateMenu = async () => {
    const bounds = await frame.locator('#files').boundingBox();
    await frame.locator('#files').click({ button: 'right', position: { x: bounds.width / 2, y: bounds.height - 18 } });
    await frame.locator('#group-create-menu').waitFor({ timeout: 2000 });
  };
  assert.equal(await frame.getByRole('button', { name: '历史文件', exact: true }).count(), 1);
  assert.equal(await frame.locator('#history').isVisible(), false);
  await frame.locator('#history-toggle').click();
  await frame.locator('#history-panel').waitFor();
  await frame.locator('#history-toggle').press('Escape');
  await frame.locator('#history-panel').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#history-toggle').evaluate(node => node === document.activeElement), true);

  const root = join(data, 'documents');
  await mkdir(root);
  for (const name of ['a.md', 'b.md', 'c.md']) {
    await writeFile(join(root, name), `# ${name}`);
  }
  const open = async name => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, join(root, name));
    await frame.locator('#open').click();
    await frame.locator('#document-name').filter({ hasText: name }).waitFor();
    await frame.locator('#group-files button').filter({ hasText: name.replace(/\.md$/, '') }).waitFor();
  };
  await open('a.md');
  await open('b.md');
  assert.deepEqual(await frame.locator('#group-files button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['a.md', 'b.md']);
  const a = frame.locator('#group-files button').filter({ hasText: 'a' });
  const b = frame.locator('#group-files button').filter({ hasText: 'b' });
  await b.dragTo(a, { targetPosition: { x: 20, y: 3 } });
  await frame.locator('#group-files button').first().filter({ hasText: 'b' }).waitFor();
  await a.click();
  await frame.locator('#document-name').filter({ hasText: 'a.md' }).waitFor();
  await frame.locator('#editor').fill('# edited');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.deepEqual(await frame.locator('#group-files button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['b.md', 'a.md']);

  await openCreateMenu();
  assert.equal(await frame.getByRole('menuitem', { name: '新建分组', exact: true }).locator('svg').count(), 1);
  await frame.locator('html').evaluate(node => { node.lang = 'en'; });
  await frame.getByRole('menuitem', { name: 'New group', exact: true }).waitFor();
  await frame.locator('html').evaluate(node => { node.lang = 'zh-CN'; });
  await frame.getByRole('menuitem', { name: '新建分组', exact: true }).click();
  await frame.getByRole('textbox', { name: '分组名称', exact: true }).fill('项目');
  await frame.locator('#group-dialog').getByRole('button', { name: '确认', exact: true }).dblclick();
  await frame.locator('#group-dialog').waitFor({ state: 'hidden', timeout: 2000 });
  const project = frame.locator('.file-group').filter({ has: frame.locator('summary').filter({ hasText: /^项目$/ }) });
  const ungrouped = frame.locator('.file-group[data-group=ungrouped]');
  await project.waitFor();
  assert.equal(await project.count(), 1);
  assert.equal(await project.getAttribute('data-active'), 'true');
  assert.equal(await frame.locator('#group-dialog').evaluate(node => node.open || node.matches(':popover-open')), false);
  await open('c.md');
  await a.dragTo(project.locator('summary'));
  await frame.locator('#group-files button').filter({ hasText: 'a' }).waitFor();
  assert.deepEqual(await project.locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['c.md', 'a.md']);
  await frame.locator('#group-files button').filter({ hasText: 'a' }).focus();
  await frame.locator('#group-files button').filter({ hasText: 'a' }).press('Alt+ArrowUp');
  await project.locator('button').first().filter({ hasText: 'a' }).waitFor();
  await project.locator('summary').click();
  assert.equal(await project.locator('button').first().isVisible(), false);
  await project.locator('summary').press('ArrowRight');
  assert.equal(await project.locator('button').first().isVisible(), true);
  await project.locator('summary').press('ArrowLeft');
  assert.equal(await project.locator('button').first().isVisible(), false);

  await frame.locator('#history-toggle').click();
  await frame.locator('#history-panel').waitFor();
  assert.equal(await frame.locator('#history button').count(), 3);
  await frame.locator('#history button').filter({ hasText: 'b' }).click();
  await frame.locator('#document-name').filter({ hasText: 'b.md' }).waitFor();
  await frame.locator('#history-panel').waitFor({ state: 'hidden' });
  assert.equal(await ungrouped.getAttribute('data-active'), 'true');
  assert.equal(await project.getAttribute('open'), null, 'opening another group preserves this fold');
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await project.locator('summary').waitFor();
  assert.deepEqual(await project.locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['a.md', 'c.md']);
  await project.locator('summary').focus();
  await project.locator('summary').press('ArrowRight');
  assert.equal(await frame.locator('#panes').isVisible(), false);

  await page.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(0, 0));
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    for (const width of [1100, 580]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 650), width);
      const heading = await project.locator('summary').boundingBox();
      const previous = await ungrouped.boundingBox();
      assert.ok(heading.y >= previous.y + previous.height, 'groups occupy separate rows');
      assert.notEqual(await project.locator('summary').evaluate(node => getComputedStyle(node).color),
        await project.locator('button').first().evaluate(node => getComputedStyle(node).color));
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/group-rows-${theme}-${width}.png`) });
      await openCreateMenu();
      await frame.locator('#group-create-menu').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/group-create-${theme}-${width}.png`) });
      await frame.getByRole('menuitem', { name: '新建分组', exact: true }).hover();
      await frame.locator('#history-toggle').hover();
      await frame.locator('#group-create-menu').waitFor({ state: 'hidden', timeout: 2000 });
      await frame.locator('#history-toggle').click();
      await frame.locator('#history-panel').waitFor();
      const bounds = await frame.locator('#history-panel').boundingBox();
      const viewport = await frame.locator('body').evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1);
      await frame.locator('#history-panel').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/groups-${theme}-${width}.png`) });
      await frame.locator('#history button').first().press('Escape');
      await project.locator('summary').click({ button: 'right', position: { x: 25, y: 12 } });
      await frame.locator('#group-menu').waitFor();
      const menu = await frame.locator('#group-menu').boundingBox();
      const groupHeading = await project.locator('summary').boundingBox();
      assert.ok(Math.abs(menu.x - (groupHeading.x + 25 + 8)) < 2, 'group menu follows the click rather than the whole row');
      assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= viewport.width + 1);
      await frame.getByRole('menuitem', { name: '重命名分组', exact: true }).click();
      await frame.locator('#group-dialog input').press('Escape');
      await frame.locator('#group-dialog').waitFor({ state: 'hidden' });
      assert.equal(await frame.locator('#group-menu').isVisible(), true, 'Escape only cancels the nested form');
      await frame.locator('#group-menu').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
      await frame.locator('body').screenshot({ path: resolve(`.test-results/text-editor/group-menu-${theme}-${width}.png`) });
      await frame.getByRole('menuitem', { name: '重命名分组', exact: true }).press('Escape');
      await frame.locator('#group-menu').waitFor({ state: 'hidden' });
      assert.equal(await project.locator('summary').evaluate(node => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(node === document.activeElement)));
      })), true, 'closing the menu returns keyboard focus to its heading');
    }
  }
  await project.locator('summary').press('ArrowRight');
  await ungrouped.locator('summary').click();
  const expanded = await project.getAttribute('open');
  await project.locator('summary').click({ button: 'right' });
  await frame.locator('#group-menu').waitFor({ timeout: 2000 });
  assert.equal(await project.getAttribute('data-active'), 'true', 'right-click must target its own group');
  assert.equal(await project.getAttribute('open'), expanded, 'right-click must not change the fold');
  await frame.getByRole('menuitem', { name: '重命名分组', exact: true }).click();
  await frame.getByRole('textbox', { name: '分组名称', exact: true }).fill('项目资料');
  await frame.getByRole('textbox', { name: '分组名称', exact: true }).press('Enter');
  await frame.locator('summary').filter({ hasText: /^项目资料$/ }).waitFor();
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const renamed = frame.locator('summary').filter({ hasText: /^项目资料$/ });
  await renamed.waitFor();
  await renamed.focus();
  await renamed.press('Shift+F10');
  await frame.locator('#group-menu').waitFor({ timeout: 2000 });
  await frame.getByRole('menuitem', { name: '删除分组', exact: true }).click();
  await frame.locator('#group-dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await frame.locator('summary').filter({ hasText: /^项目资料$/ }).count(), 1);
  await frame.locator('#group-settings').click();
  await frame.getByRole('menuitem', { name: '删除分组', exact: true }).click();
  await frame.locator('#group-dialog').getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('summary').filter({ hasText: /^项目资料$/ }).waitFor({ state: 'detached' });
  assert.deepEqual(await frame.locator('#group-files button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['b.md', 'a.md', 'c.md']);
  assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# edited');
  await ungrouped.locator('summary').click({ button: 'right' });
  assert.equal(await frame.locator('#group-menu').isVisible(), false, 'the built-in ungrouped bucket cannot be deleted');
  await frame.locator('#history-toggle').click();
  await frame.locator('#history button').filter({ hasText: 'b' }).click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await frame.locator('#file-action-dialog').waitFor();
  assert.equal(await frame.locator('#file-action-dialog input').evaluate(input => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(input === document.activeElement)));
  })), true, 'rename input retains keyboard focus after the menu closes');
  await page.keyboard.type('cancelled');
  await frame.locator('#file-action-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await frame.locator('#history button').filter({ hasText: 'b' }).click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '移除记录', exact: true }).click();
  await frame.locator('#status').filter({ hasText: '已移除记录' }).waitFor();
  assert.equal(await frame.locator('#history button').filter({ hasText: 'b' }).count(), 0);
  assert.deepEqual(await frame.locator('#group-files button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['a.md', 'c.md']);
  assert.equal(await readFile(join(root, 'b.md'), 'utf8'), '# b.md');
  await frame.locator('#history-close').click();
  await frame.locator('#group-files button').filter({ hasText: 'a' }).click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await frame.locator('#file-action-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await frame.locator('#files').focus();
  await frame.locator('#files').press('Shift+F10');
  await frame.getByRole('menuitem', { name: '新建分组', exact: true }).click();
  await frame.getByRole('textbox', { name: '分组名称', exact: true }).fill('取消新建');
  await frame.locator('#group-dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await frame.locator('summary').filter({ hasText: /^取消新建$/ }).count(), 0);
  await frame.getByRole('menuitem', { name: '新建分组', exact: true }).press('Escape');
  await frame.locator('#group-create-menu').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#files').evaluate(node => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(node === document.activeElement)));
  })), true);
});
