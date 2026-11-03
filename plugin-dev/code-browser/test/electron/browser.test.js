import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, toggleTheme } from '../../../../desk/test/electron/helpers.js';

const archive = resolve('plugin-dev/dist/code-browser-0.1.34.plg');

test('real .plg: isolated desktop, Java/Vue/JS, Git, theme, agent capabilities and disable', { timeout: 120000 }, async t => {
  const { app, page, data, logs } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const install = async (path, id = 'code-browser') => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.evaluate(() => workDesk.plugins.install());
    await page.evaluate(id => workDesk.plugins.enable(id), id);
  };
  await install(archive);
  const plugin = await page.evaluate(async () => (await workDesk.plugins.list()).find(plugin => plugin.id === 'code-browser'));
  assert.equal(plugin.version, '0.1.34');
  await page.locator('.shelf-app[data-plugin="code-browser"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="coding"]:visible');
  const showView = async view => {
    await frame.locator('#git-pane').evaluate(dialog => dialog.matches(':popover-open') && document.querySelector('#compare-close').click());
    if (view === 'git') {
      await frame.locator('#git-tab').evaluate(() => document.dispatchEvent(new CustomEvent('coding:compare', {
        detail: { base: 'refs/heads/compare-base', target: 'HEAD' }
      })));
      await frame.locator('#git-pane:popover-open').waitFor();
      await frame.locator('#app[aria-busy="false"]').waitFor();
    } else if (view === 'source') {
      if (await frame.locator('#git-branches').isVisible()) {
        await page.keyboard.press('Escape');
        await frame.locator('#git-branches').waitFor({ state: 'hidden' });
      }
      if (await frame.locator('#tools-panel').isVisible()) {
        await frame.locator('#tools-toggle').click();
      }
    } else if (await frame.locator(`#${view}-pane`).isHidden()) {
      await frame.locator(`#${view}-tab`).click();
    }
  };
  await frame.locator('#folder').waitFor();
  await frame.locator('#status').filter({ hasText: '请选择项目目录' }).waitFor();
  assert.equal(await frame.locator('#source-tab').count(), 0);
  assert.equal(await frame.locator('#tools-panel').isHidden(), true);
  for (const view of ['build', 'spring']) {
    await showView(view);
    assert.equal(await frame.locator('#tools-panel').isVisible(), true);
    assert.equal(await frame.locator('#source-pane').isVisible(), true);
    assert.equal(await frame.locator(`#${view}-tab`).getAttribute('aria-pressed'), 'true');
    assert.equal(await frame.locator(`#${view}-pane`).evaluate(pane => pane.closest('#tools-panel') !== null), true);
    await showView('source');
    assert.equal(await frame.locator('#tools-panel').isHidden(), true);
  }
  assert.equal(await frame.locator('.toolbar nav').evaluate(nav => {
    const bar = nav.closest('header').getBoundingClientRect();
    const rect = nav.getBoundingClientRect();
    return Math.abs(bar.right - rect.right - 8) < 2 && rect.top >= bar.top && rect.bottom <= bar.bottom;
  }), true);

  const root = join(data, 'project');
  await mkdir(root);
  await mkdir(resolve('.test-results/code-browser'), { recursive: true });
  await writeFile(join(root, 'Main.java'), 'class Main { String text = "你好"; }\n');
  await writeFile(join(root, 'App.vue'), '<template><img src=x onerror="window.hacked=1"></template>\n');
  await writeFile(join(root, 'app.js'), 'export const value = 1;\n');
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'README.md'), '# Project');
  await writeFile(join(root, '.gitignore'), 'target/');
  await mkdir(join(root, 'src/demo'), { recursive: true });
  await writeFile(join(root, 'src/demo/Service.java'), 'package demo;\npublic class Service {\n  public void execute() {}\n  public void execute(String value) {}\n}\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('init', '--bare', '-q', join(root, '.git', 'remote.git'));
  git('remote', 'add', 'origin', join(root, '.git', 'remote.git'));
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'deleted.txt'), 'delete me');
  git('add', '.');
  git('commit', '-qm', 'first');
  git('branch', 'compare-base');
  await writeFile(join(root, 'app.js'), 'export const value = 2;\n');
  git('rm', 'deleted.txt');
  await writeFile(join(root, 'added.txt'), 'new file');
  git('add', '.');
  git('commit', '-qm', 'second');
  git('branch', 'compare-target');
  git('update-ref', 'refs/remotes/origin/remote-example', 'HEAD');
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, root);
  await frame.locator('#folder').click();
  await frame.locator('#git-tab').filter({ hasText: 'main' }).waitFor();
  const another = join(data, 'another-project');
  await mkdir(another);
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, another);
  await frame.locator('#folder').click();
  await frame.locator('#projects-history').click();
  await frame.locator('#projects button[aria-pressed="true"]').filter({ hasText: 'another-project' }).waitFor();
  await frame.locator('#projects button').filter({ hasText: /^project$/ }).click();
  await frame.locator('#projects-popup').waitFor({ state: 'hidden' });
  await frame.locator('#projects-history').click();
  await frame.locator('#projects button[aria-pressed="true"]').filter({ hasText: /^project$/ }).waitFor();
  assert.equal(await frame.locator('#projects button').count(), 2);
  await page.keyboard.press('Escape');
  await frame.getByRole('button', { name: 'Main.java', exact: true }).click();
  await frame.locator('#editor').waitFor();
  assert.match(await frame.locator('#editor').inputValue(), /你好/);
  assert.equal(await frame.locator('.definition-tools').isHidden(), true);
  assert.equal(await frame.locator('#edit').count(), 0);
  await frame.locator('#editor').fill('class Main { String text = "你好 edited"; }\n');
  assert.equal(await frame.locator('#save').count(), 0);
  await frame.locator('#status').filter({ hasText: '已自动保存' }).waitFor();
  assert.match(await readFile(join(root, 'Main.java'), 'utf8'), /你好 edited/);
  await writeFile(join(root, 'Main.java'), 'class Main { String text = "你好 external"; }\n');
  await frame.locator('#editor').fill('local conflict draft');
  await frame.locator('#status').filter({ hasText: '文件已被修改' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), 'local conflict draft');
  assert.match(await readFile(join(root, 'Main.java'), 'utf8'), /external/);
  await frame.locator('#editor').fill('unsaved draft');
  await frame.getByRole('button', { name: 'App.vue', exact: true }).click();
  await frame.getByRole('button', { name: '取消操作', exact: true }).click();
  assert.equal(await frame.locator('#editor').inputValue(), 'unsaved draft');
  await writeFile(join(root, 'Main.java'), 'class Main { String text = "你好 edited"; }\n');
  await frame.locator('#editor').fill('class Main { String text = "你好 edited"; }\n');
  await frame.locator('#status').filter({ hasText: '已自动保存' }).waitFor();
  assert.equal(await frame.locator('#edit').count(), 0);
  assert.ok(await frame.locator('#source .syntax-keyword').count() > 0);
  assert.ok(await frame.locator('#source .syntax-string').count() > 0);
  assert.equal(await frame.locator('#files .file-java').count(), 1);
  const iconPath = name => frame.getByRole('button', { name, exact: true }).locator('svg path').first().getAttribute('d');
  assert.notEqual(await iconPath('package.json'), await iconPath('Main.java'));
  assert.notEqual(await iconPath('README.md'), await iconPath('app.js'));
  assert.equal(await frame.getByRole('button', { name: '.gitignore', exact: true }).locator('svg circle').count(), 1);
  assert.equal(await frame.locator('#files svg:not([aria-hidden="true"])').count(), 0);
  const src = frame.getByRole('button', { name: 'src/demo', exact: true });
  await src.click();
  const childIndent = await frame.getByRole('button', { name: 'Service.java', exact: true }).evaluate(el => el.getBoundingClientRect().left);
  const parentIndent = await src.evaluate(el => el.getBoundingClientRect().left);
  assert.ok(childIndent > parentIndent + 10);
  await frame.getByRole('button', { name: 'Service.java', exact: true }).click();
  await frame.getByRole('tab', { name: 'Service.java', exact: true }).waitFor();
  assert.equal(await frame.locator('.document-bar').count(), 0);
  assert.equal(await frame.getByRole('button', { name: 'Main.java', exact: true }).isVisible(), true);
  await src.click();
  assert.equal(await frame.getByRole('button', { name: 'Service.java', exact: true }).isVisible(), false);
  await src.click();
  await frame.locator('#editor').evaluate(input => {
    const offset = input.value.indexOf('execute');
    input.setSelectionRange(offset, offset + 7);
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await frame.locator('#definitions button').first().waitFor();
  assert.equal(await frame.locator('#definitions button').count(), 2);
  await frame.locator('#definitions button').nth(1).click();
  await frame.locator('#editor').waitFor();
  assert.equal(await frame.locator('#editor').evaluate(input => input.value.slice(0, input.selectionStart).split('\n').length), 4);
  await frame.locator('#editor').press('Control+f');
  await frame.locator('#symbol').fill('Service');
  await frame.locator('#definition-search').click();
  await frame.locator('#definitions button').filter({ hasText: '类' }).click();
  await frame.locator('#editor').waitFor();
  assert.equal(await frame.locator('#editor').evaluate(input => input.value.slice(0, input.selectionStart).split('\n').length), 2);
  await page.screenshot({ path: resolve('.test-results/code-browser/navigation.png') });
  await frame.getByRole('button', { name: 'App.vue', exact: true }).click();
  await frame.locator('#editor').waitFor();
  assert.match(await frame.locator('#editor').inputValue(), /onerror/);
  assert.ok(await frame.locator('#source .syntax-tag').count() > 0);
  assert.equal(await frame.locator('#definition-search').isDisabled(), true);
  const clickFileTab = async (name, role = 'tab') => {
    await frame.getByRole(role, { name, exact: true }).click();
    await frame.locator('#app[aria-busy="false"]').waitFor();
  };
  assert.equal(await frame.getByRole('tab', { name: 'Main.java', exact: true }).count(), 1);
  await clickFileTab('Main.java');
  await frame.locator('#editor').waitFor();
  await frame.locator('#editor').fill('class Main { String text = "你好 tabs"; }\n');
  await frame.locator('#editor').evaluate(input => input.setSelectionRange(6, 10));
  await clickFileTab('App.vue');
  assert.match(await readFile(join(root, 'Main.java'), 'utf8'), /你好 tabs/);
  await clickFileTab('Main.java');
  assert.match(await frame.locator('#editor').inputValue(), /你好 tabs/);
  assert.deepEqual(await frame.locator('#editor').evaluate(input => [input.selectionStart, input.selectionEnd]), [6, 10]);
  await frame.locator('#editor').fill('class Main { String text = "你好 edited"; }\n');
  await clickFileTab('App.vue');
  assert.equal(await frame.getByRole('tab', { name: 'App.vue', exact: true }).getAttribute('aria-selected'), 'true');
  await clickFileTab('关闭 Main.java', 'button');
  assert.equal(await frame.getByRole('tab', { name: 'Main.java', exact: true }).count(), 0);
  await clickFileTab('App.vue', 'button');
  assert.equal(await frame.getByRole('tab', { name: 'App.vue', exact: true }).count(), 1);
  await clickFileTab('关闭 App.vue', 'button');
  assert.equal(await frame.getByRole('tab', { name: 'Service.java', exact: true }).getAttribute('aria-selected'), 'true');
  await clickFileTab('关闭 Service.java', 'button');
  assert.equal(await frame.getByRole('tab').count(), 0);
  assert.equal(await frame.locator('#editor').isHidden(), true);
  await clickFileTab('App.vue', 'button');
  assert.equal(await frame.locator('#source img').count(), 0);
  assert.equal(await frame.locator('body').evaluate(() => window.hacked), undefined);
  await frame.locator('#query').fill('value = 2');
  await frame.getByRole('button', { name: '搜索', exact: true }).click();
  await frame.locator('#matches button').waitFor({ timeout: 10000 }).catch(async error => {
    throw Error(`${error.message}; status=${await frame.locator('#status').textContent()}; logs=${logs.join('').slice(-6000)}`);
  });
  await frame.locator('#matches button').click();
  await frame.getByRole('tab', { name: 'app.js', exact: true }).waitFor();
  await frame.locator('#build-tab').focus();
  await frame.locator('#build-tab').press('Enter');
  assert.equal(await frame.locator('#build-pane').isVisible(), true);
  assert.equal(await frame.locator('#source-pane').isVisible(), true);
  assert.equal(await frame.locator('#tools-panel').evaluate(panel => {
    const editor = document.querySelector('.content').getBoundingClientRect();
    return panel.getBoundingClientRect().left >= editor.right - 1;
  }), true);
  await frame.locator('#build-tab').press('Enter');
  assert.equal(await frame.locator('#source-pane').isVisible(), true);
  const sourceWidth = (await frame.locator('.content').boundingBox()).width;
  await frame.locator('#projects-toggle').click();
  assert.equal(await frame.locator('.project-sidebar').isHidden(), true);
  assert.ok((await frame.locator('.content').boundingBox()).width > sourceWidth);
  await frame.locator('#projects-toggle').click();
  assert.equal(await frame.locator('.project-sidebar').isVisible(), true);
  assert.equal(await frame.locator('#git-tab').evaluate(button => {
    const root = document.querySelector('#root').getBoundingClientRect();
    return button.getBoundingClientRect().left > root.right && !button.closest('nav');
  }), true);
  assert.equal(await frame.locator('#source').evaluate(source =>
    getComputedStyle(source).backgroundColor !== getComputedStyle(document.body).backgroundColor), true);
  await frame.locator('#tools-toggle').click();
  assert.equal(await frame.locator('#tools-panel').isVisible(), true);
  await frame.locator('#tools-toggle').click();
  assert.equal(await frame.locator('#tools-panel').isHidden(), true);
  const openGitCommands = async () => showView('git');
  assert.equal(await frame.locator('#git-action').isVisible(), false);
  assert.equal(await frame.locator('#compare-form').count(), 0);
  for (const name of ['新建分支', '推送当前分支', '更新当前分支', '提交']) {
    const button = frame.getByRole('button', { name, exact: true });
    assert.equal(await button.isVisible(), true);
    assert.equal(await button.locator('svg').count(), 1);
    assert.equal(await button.textContent(), '');
  }
  await frame.getByRole('button', { name: '推送当前分支', exact: true }).click();
  await frame.getByRole('dialog', { name: '推送更改', exact: true }).waitFor();
  assert.match(await frame.locator('#git-files').textContent(), /app.js/);
  assert.equal(await frame.locator('#git-stage').isVisible(), false);
  await frame.locator('#git-close').click();
  await openGitCommands();
  await frame.locator('#diff .change-A').waitFor();
  assert.equal(await frame.getByRole('tab').filter({ hasText: /^(新增|修改|删除)/ }).count(), 3);
  await frame.locator('#diff .diff-line.added').filter({ hasText: '+new file' }).waitFor();
  await frame.getByRole('tab', { name: '修改 (1)', exact: true }).click();
  await frame.locator('#diff .diff-line.added').filter({ hasText: '+export const value = 2' }).waitFor();
  await frame.getByRole('tab', { name: '删除 (1)', exact: true }).click();
  await frame.locator('#diff .diff-line.removed').filter({ hasText: '-delete me' }).waitFor();
  await mkdir(resolve('.test-results/code-browser'), { recursive: true });
  for (let index = 0; index < 2; index++) {
    const expected = await page.locator('html').getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    await toggleTheme(page);
    await frame.locator(`html[data-theme="${expected}"]`).waitFor();
    await showView('source');
    await page.screenshot({ path: resolve(`.test-results/code-browser/source-${expected}.png`) });
    await showView('git');
    await page.screenshot({ path: resolve(`.test-results/code-browser/git-${expected}.png`) });
  }

  // Exercise real packaged UI writes against the isolated fixture repository.
  await showView('git');
  await showView('source');
  assert.equal(await frame.locator('#git-tab').textContent(), 'main');
  assert.equal(await frame.locator('#git-tab svg').count(), 0);
  await frame.locator('#git-tab').click();
  await frame.locator('#git-branches:popover-open').waitFor();
  assert.equal(await frame.locator('#git-branches').evaluate(el => {
    const trigger = document.querySelector('#git-tab').getBoundingClientRect();
    return el.getBoundingClientRect().left >= trigger.right;
  }), true);
  const branchPopup = frame.locator('.branch-browser');
  assert.equal(await branchPopup.evaluate(el => el.tagName), 'DIV');
  assert.equal(await branchPopup.evaluate(el => Boolean(el.closest('#tools-panel'))), false);
  assert.equal(await frame.locator('#tools-panel').isHidden(), true);
  await showView('source');
  assert.equal(await branchPopup.isHidden(), true);
  await frame.locator('#git-tab').click();
  await branchPopup.waitFor();
  await page.keyboard.press('Escape');
  await showView('build');
  const resizeHandle = frame.locator('#tools-resize');
  const beforeResize = await frame.locator('#tools-panel').boundingBox();
  const handleBounds = await resizeHandle.boundingBox();
  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x - 80, handleBounds.y + 40, { steps: 5 });
  await page.mouse.up();
  const afterResize = await frame.locator('#tools-panel').boundingBox();
  assert.ok(afterResize.width > beforeResize.width + 70);
  await resizeHandle.focus();
  await resizeHandle.press('ArrowRight');
  assert.ok((await frame.locator('#tools-panel').boundingBox()).width < afterResize.width);
  await frame.locator('#git-tab').click();
  assert.equal(await frame.getByRole('menuitem', { name: '其他 Git 操作…', exact: true }).count(), 0);
  assert.equal(await branchPopup.locator('.branch-tree > details').first().locator(':scope > summary').textContent(), '收藏');
  assert.equal(await branchPopup.locator('details[open]').count(), 0);
  const localGroup = branchPopup.locator('.branch-tree > details').filter({ has: frame.locator(':scope > summary', { hasText: /^本地$/ }) });
  await localGroup.locator(':scope > summary').click();
  await localGroup.getByRole('button', { name: '收藏 compare-base', exact: true }).click();
  await localGroup.getByRole('button', { name: '取消收藏 compare-base', exact: true }).waitFor();
  await localGroup.getByRole('button', { name: '取消收藏 compare-base', exact: true }).click();
  await localGroup.getByRole('button', { name: '收藏 compare-base', exact: true }).waitFor();
  assert.equal(await branchPopup.locator('.branch-tree > details').first().locator('.branch-row').count(), 0);
  await localGroup.getByRole('button', { name: '收藏 compare-base', exact: true }).click();
  await localGroup.getByRole('button', { name: '取消收藏 compare-base', exact: true }).waitFor();
  assert.equal(await localGroup.getAttribute('open'), '');
  const favoriteGroup = branchPopup.locator('.branch-tree > details').first();
  await favoriteGroup.locator(':scope > summary').click();
  await favoriteGroup.locator('.branch-entry').filter({ hasText: 'compare-base' }).waitFor();
  assert.equal(await favoriteGroup.locator('.branch-favorite').getAttribute('aria-pressed'), 'true');
  await frame.locator('#tools-toggle').click();
  await frame.locator('#tools-toggle').click();
  await frame.locator('#git-tab').click();
  await favoriteGroup.locator('.branch-entry').filter({ hasText: 'compare-base' }).waitFor();
  await branchPopup.getByRole('searchbox', { name: '搜索分支和操作' }).fill('compare-base');
  await favoriteGroup.locator(':scope > summary').click();
  for (const action of ['取消收藏', '收藏']) {
    await localGroup.getByRole('button', { name: `${action} compare-base`, exact: true }).click();
    const nextAction = action === '收藏' ? '取消收藏' : '收藏';
    await localGroup.getByRole('button', { name: `${nextAction} compare-base`, exact: true }).waitFor();
    assert.equal(await favoriteGroup.getAttribute('open'), null, 'Favorite changes must preserve collapsed search groups');
    assert.equal(await localGroup.getAttribute('open'), '');
  }
  await favoriteGroup.locator(':scope > summary').click();
  assert.equal(await frame.locator('.branch-actions-dialog').count(), 0);
  await branchPopup.locator('.branch-entry').filter({ hasText: 'compare-base' }).first().hover();
  await frame.locator('.branch-actions-dialog:popover-open').waitFor();
  await branchPopup.locator('.branch-entry').filter({ hasText: 'compare-base' }).first().click();
  const branchActions = frame.locator('.branch-actions-dialog');
  for (const id of ['git-new', 'git-push', 'git-pull']) {
    assert.equal(await frame.locator(`#${id}`).isVisible(), true);
  }
  const listBounds = await branchPopup.locator('.branch-entry').filter({ hasText: 'compare-base' }).first().boundingBox();
  const actionBounds = await branchActions.boundingBox();
  assert.ok(actionBounds.x >= listBounds.x + listBounds.width || actionBounds.x + actionBounds.width <= listBounds.x);
  // The parent list remains interactive and replaces the adjacent child in place.
  await branchPopup.locator('.branch-entry').filter({ hasText: 'compare-base' }).last().click();
  assert.equal(await branchActions.count(), 1);
  assert.equal(await branchActions.locator('.branch-operations').evaluate(el => el.contains(document.activeElement)), true);
  assert.match(await branchActions.locator('button:focus').textContent(), /与当前分支/);
  assert.equal(await branchActions.getByRole('menuitem', { name: '更新', exact: true }).isDisabled(), false);
  assert.equal(await branchActions.getByRole('menuitem', { name: '推送…', exact: true }).isDisabled(), false);
  assert.ok(await branchActions.getByRole('menuitem').filter({ hasText: /将 'compare-base' 合并到当前分支/ }).count());
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) {
      await toggleTheme(page);
    }
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    await page.screenshot({ path: resolve(`.test-results/code-browser/branch-menu-${theme}.png`) });
  }
  await frame.locator('#diff').evaluate(el => el.replaceChildren());
  await branchActions.getByRole('menuitem').filter({ hasText: /^与当前分支/ }).click();
  await frame.locator('#diff .change-A').waitFor();
  assert.equal(await frame.locator('#git-branches').isHidden(), true);
  assert.equal(await frame.locator('#diff').isVisible(), true);
  assert.equal(await frame.locator('#compare-form').count(), 0);
  await frame.getByRole('tab', { name: '修改 (1)', exact: true }).click();
  await frame.locator('#diff .diff-line.added').filter({ hasText: 'value = 2' }).waitFor();
  assert.equal(await frame.locator('#diff .diff-file:visible').evaluateAll(files => files.every(file => file.open)), true);
  await frame.locator('#diff summary').filter({ hasText: 'app.js' }).click();
  assert.equal(await frame.locator('#diff .diff-file:visible').evaluate(file => file.open), false);
  await frame.getByRole('tab', { name: '新增 (1)', exact: true }).click();
  await frame.getByRole('tab', { name: '修改 (1)', exact: true }).click();
  assert.equal(await frame.locator('#diff .diff-file:visible').evaluate(file => file.open), false);
  await frame.locator('#diff summary').filter({ hasText: 'app.js' }).click();
  await page.screenshot({ path: resolve('.test-results/code-browser/branch-compare.png') });
  assert.ok((await frame.locator('#git-pane').boundingBox()).width > 1000);
  await frame.locator('#compare-close').click();

  await frame.locator('#git-tab').click();
  await branchPopup.getByRole('searchbox', { name: '搜索分支和操作' }).fill('没有此分支');
  await branchPopup.getByText('无匹配的分支或操作', { exact: true }).waitFor();
  await branchPopup.getByRole('searchbox', { name: '搜索分支和操作' }).fill('');
  await page.keyboard.press('Escape');
  await frame.locator('#git-branches').waitFor({ state: 'hidden' });
  await frame.getByRole('button', { name: '新建分支', exact: true }).click();
  await frame.getByRole('textbox', { name: '分支名称', exact: true }).fill('codex/ui-test');
  await frame.getByRole('button', { name: '确认分支名称', exact: true }).click();
  await frame.locator('#git-tab').filter({ hasText: 'codex/ui-test' }).waitFor();
  await frame.locator('#git-run:not([disabled])').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('dialog:popover-open').count(), 0);
  assert.equal(git('branch', '--show-current'), 'codex/ui-test');
  for (const branch of ['main', 'codex/ui-test']) {
    await frame.locator('#git-tab').click();
    await branchPopup.getByRole('searchbox').fill(branch);
    await branchPopup.locator('.branch-entry:visible').filter({ hasText: branch.split('/').at(-1) }).first().click();
    await branchActions.getByRole('menuitem', { name: '签出', exact: true }).click();
    await frame.locator('#git-tab').filter({ hasText: branch }).waitFor();
    await frame.locator('#git-new:not([disabled])').waitFor({ state: 'attached' });
    assert.equal(git('branch', '--show-current'), branch);
    assert.equal(await frame.locator('dialog:popover-open').count(), 0);
  }
  await writeFile(join(root, 'ui-new.txt'), 'UI Git test');
  await frame.locator('#git-commit').click();
  await frame.locator('#git-files label').filter({ hasText: 'ui-new.txt' }).waitFor();
  await page.screenshot({ path: resolve('.test-results/code-browser/git-commit-review.png') });
  for (const checkbox of await frame.locator('#git-files input[type="checkbox"]').all()) {
    await checkbox.check();
  }
  await frame.locator('#git-stage').click();
  await frame.locator('#git-state').filter({ hasText: 'succeeded' }).waitFor();
  await frame.locator('#git-run:not([disabled])').waitFor({ state: 'attached' });
  await frame.locator('#git-run').click();
  await frame.locator('#git-state').filter({ hasText: '请填写提交备注' }).waitFor();
  await frame.locator('#git-field-message').fill('UI commit');
  await frame.locator('#git-run').click();
  await frame.locator('#git-state').filter({ hasText: 'succeeded' }).waitFor();
  await frame.locator('#git-run:not([disabled])').waitFor({ state: 'attached' });
  assert.equal(git('log', '-1', '--format=%s'), 'UI commit');
  assert.equal(git('status', '--porcelain'), '');
  await frame.locator('#git-close').click();
  await frame.locator('#git-push').click();
  await frame.getByRole('dialog', { name: '推送更改', exact: true }).waitFor();
  assert.match(await frame.locator('#git-files').textContent(), /ui-new.txt/);
  await page.screenshot({ path: resolve('.test-results/code-browser/git-push-review.png') });
  await frame.locator('#git-run').click();
  await frame.locator('#git-state').filter({ hasText: '推送分支并设置跟踪：succeeded' }).waitFor();
  assert.equal(git('--git-dir', join(root, '.git', 'remote.git'), 'rev-parse', 'refs/heads/codex/ui-test'), git('rev-parse', 'HEAD'));
  await frame.locator('#git-close').click();
  await frame.locator('#git-pull').click();
  await frame.locator('#git-state').filter({ hasText: '拉取更新：succeeded' }).waitFor({ state: 'attached' });
  assert.equal(await frame.locator('dialog:popover-open').count(), 0);
  await frame.locator('#git-commit').click();
  await page.screenshot({ path: resolve('.test-results/code-browser/git-management.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 650));
  assert.equal(await frame.locator('#git-action').inputValue(), 'commit');
  await frame.locator('#git-field-message').focus();
  assert.equal(await frame.locator('#git-field-message').evaluate(element => element === document.activeElement), true);
  assert.equal(await frame.locator('#git-stop').isDisabled(), true);
  assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve('.test-results/code-browser/git-narrow.png') });
  await frame.locator('#git-close').click();
  await frame.locator('#git-tab').click();
  assert.equal(await branchPopup.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: resolve('.test-results/code-browser/branch-menu-narrow.png') });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(400, 400);
    window.setSize(650, 650);
  });
  assert.equal(await branchPopup.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await branchPopup.getByRole('searchbox').fill('compare-base');
  assert.equal(await frame.locator('.branch-actions-dialog').count(), 0);
  await branchPopup.locator('.branch-entry:visible').first().focus();
  await branchPopup.locator('.branch-entry:visible').first().press('Enter');
  assert.equal(await branchActions.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.ok(await branchActions.locator('.branch-menu-header strong').evaluate(el => el.clientWidth > 100));
  await page.screenshot({ path: resolve('.test-results/code-browser/branch-menu-compact.png') });
  await page.keyboard.press('Escape');
  await branchActions.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await branchPopup.waitFor({ state: 'hidden' });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));


  // Expanded category files load in order, including patches larger than the aggregate Git limit.
  git('branch', 'large-base');
  await writeFile(join(root, 'large.js'), ('export const value = "' + 'a'.repeat(180) + '";\n').repeat(1000));
  await writeFile(join(root, 'small.js'), 'export const small = true;\n');
  git('add', 'large.js', 'small.js');
  git('commit', '-qm', 'large comparison fixture');
  await frame.locator('#git-tab').evaluate(() => document.dispatchEvent(new CustomEvent('coding:compare', {
    detail: { base: 'refs/heads/large-base', target: 'HEAD' }
  })));
  await frame.locator('#diff summary').filter({ hasText: 'large.js' }).waitFor();
  assert.equal(await frame.locator('#diff .diff-file').count(), 2);
  await frame.locator('#diff .diff-file').filter({ hasText: 'small.js' }).locator('.diff-line.added').waitFor();
  assert.equal(await frame.locator('#diff .diff-file').filter({ hasText: 'large.js' }).locator('.diff-line.added').count(), 1000);
  assert.equal(await frame.locator('#diff .diff-file').evaluateAll(files => files.every(file => file.open)), true);
  assert.deepEqual(await frame.locator('#diff summary').evaluateAll(rows => rows.map(row => row.lastChild.textContent)),
    git('diff', '--name-only', 'large-base', 'HEAD').split('\n'));
  await page.screenshot({ path: resolve('.test-results/code-browser/branch-compare-large.png') });
  await frame.locator('#compare-close').click();

  if (process.env.CODING_TEST_SCOPE === 'git') {
    assert.deepEqual(errors, []);
    return;
  }

  await writeFile(join(root, 'pom.xml'), '<project><artifactId>platform</artifactId><modules><module>module</module></modules></project>');
  await writeFile(join(root, 'mvnw'), '#!/bin/sh\necho "MAVEN SUCCESS 中文"; printf "arg:%s\\n" "$@"; sleep 0.2\n');
  await mkdir(join(root, 'module'));
  await writeFile(join(root, 'module/pom.xml'), '<project><artifactId>admin</artifactId><modules><module>../components/server</module></modules></project>');
  await mkdir(join(root, 'components/server'), { recursive: true });
  await writeFile(join(root, 'components/server/pom.xml'), '<project><artifactId>admin-server</artifactId></project>');
  await mkdir(join(root, 'unrelated'));
  await writeFile(join(root, 'unrelated/pom.xml'), '<project><artifactId>unrelated</artifactId></project>');
  await showView('build');
  await frame.locator('#build-projects-refresh').click();
  await frame.locator('#build-projects button[data-path="module"]').waitFor();
  assert.equal(await frame.locator('#build-projects button[data-path="components/server"]').isHidden(), true);
  await frame.locator('#build-projects details').filter({ has: frame.locator(':scope > summary button[data-path="module"]') }).locator(':scope > summary').click({ position: { x: 4, y: 10 } });
  assert.equal(await frame.locator('#build-projects button[data-path]').count(), 3);
  assert.deepEqual(await frame.locator('#build-projects button[data-path]').allTextContents(), ['platform', 'admin', 'admin-server']);
  assert.equal(await frame.locator('#build-projects button[data-path="components/server"]').evaluate(button =>
    button.closest('details').parentElement.closest('details').querySelector(':scope > summary button').dataset.path), 'module');
  const rootSummary = frame.locator('#build-projects > div > details > summary');
  await rootSummary.focus();
  await rootSummary.press('Enter');
  assert.equal(await frame.locator('#build-projects button[data-path="module"]').isHidden(), true);
  await rootSummary.press('Enter');
  await frame.locator('#build-projects button[data-path="module"]').click();
  assert.equal(await frame.locator('#build-log').count(), 0);
  assert.equal(await frame.locator('#build-pane input:not([type=hidden])').count(), 0);
  assert.ok((await frame.locator('#build-projects').boundingBox()).height > 300);
  const modulePhases = frame.locator('#build-projects details').filter({ has: frame.locator(':scope > summary button[data-path="module"]') }).locator(':scope > .maven-lifecycle');
  assert.equal(await modulePhases.locator('button').count(), 0);
  await modulePhases.locator('summary').click();
  await modulePhases.locator('[data-phase="install"]').click();
  assert.equal(await frame.locator('#build-path').inputValue(), 'module');
  assert.equal(await frame.locator('#build-phase').inputValue(), 'install');
  assert.deepEqual(await modulePhases.locator('button').allTextContents(), ['clean', 'compile', 'test', 'install', 'deploy']);
  await modulePhases.locator('[data-phase="install"]').dblclick();
  await frame.locator('#build-state').filter({ hasText: '编译成功' }).waitFor();
  await frame.locator('#build-log').filter({ hasText: 'MAVEN SUCCESS 中文' }).waitFor();
  assert.match(await frame.locator('#build-log').innerText(), /arg:install/);
  assert.ok((await frame.locator('#build-output').boundingBox()).height <= 150);
  await frame.locator('#build-projects').evaluate(tree => { tree.scrollTop = 0; });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) {
      await toggleTheme(page);
    }
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    await page.screenshot({ path: resolve(`.test-results/code-browser/maven-${theme}.png`) });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 650));
  assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve('.test-results/code-browser/maven-narrow.png') });
  await modulePhases.locator('[data-phase="deploy"]').click();
  await frame.locator('#build-start').click();
  await frame.getByRole('button', { name: '取消发布', exact: true }).click();
  assert.equal(await frame.locator('dialog:popover-open').count(), 0);
  await modulePhases.locator('[data-phase="compile"]').click();
  await frame.locator('#build-projects button[data-path=""]').click();

  // Spring Boot discovery and process ownership use an isolated Maven wrapper fixture.
  await writeFile(join(root, 'src/demo/Boot.java'), 'package demo; @SpringBootApplication public class Boot { public static void main(String[] args) {} }');
  await writeFile(join(root, 'mvnw'), '#!/bin/sh\necho "SPRING PID:$$"; sleep 60\n');
  await showView('spring');
  await frame.locator('#spring-refresh').click();
  await frame.getByRole('button', { name: '启动 demo.Boot', exact: true }).click();
  await frame.getByRole('button', { name: '确认启动项目', exact: true }).click();
  await frame.locator('#spring-log').filter({ hasText: 'SPRING PID:' }).waitFor();
  const springPid = Number((await frame.locator('#spring-log').textContent()).match(/PID:(\d+)/)[1]);
  await frame.getByRole('button', { name: '停止 demo.Boot', exact: true }).click();
  await frame.locator('#spring-state').filter({ hasText: '已停止' }).waitFor();
  assert.throws(() => process.kill(springPid, 0));
  await writeFile(join(root, 'mvnw'), '#!/bin/sh\necho "MAVEN SUCCESS 中文"; sleep 0.2\n');
  await page.screenshot({ path: resolve('.test-results/code-browser/spring.png') });

  // This caller uses only the public capability contract, just like an agent gateway.
  const caller = join(data, 'capability-caller');
  await mkdir(caller);
  await writeFile(join(caller, 'plugin.json'), JSON.stringify({ id: 'code-browser-probe', name: 'Code probe',
    version: '1.0.0', apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, singleInstance: true,
    loadOnStartup: false, background: 'service', main: 'index.mjs' }));
  await writeFile(join(caller, 'index.mjs'), `export function activate(c) {
    c.methods.register('probe.catalog', () => c.capabilities.discover({pluginId:'code-browser'}));
    c.methods.register('probe.call', async ({id,input}) => {
      const catalog = await c.capabilities.discover({id,pluginId:'code-browser'});
      return c.capabilities.invoke(catalog.providers[0].handle,input);
    });
    c.methods.register('probe.get', id => c.capabilities.getInvocation(id));
  } export function deactivate() {}`);
  await install(caller, 'code-browser-probe');
  const catalog = await page.evaluate(() => workDesk.plugins.invoke('code-browser-probe', 'probe.catalog'));
  assert.equal(catalog.providers.length, 22);
  assert.equal(catalog.providers.find(provider => provider.descriptor.id === 'code.compile').descriptor.confirmation, 'always');
  const compile = await page.evaluate(() => workDesk.plugins.invoke('code-browser-probe', 'probe.call',
    [{ id: 'code.compile', input: {} }]));
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await page.waitForFunction(async id =>
    (await workDesk.plugins.invoke('code-browser-probe', 'probe.get', [id])).state === 'succeeded', compile.invocationId);
  await page.waitForFunction(async () =>
    (await workDesk.plugins.invoke('code-browser', 'code.build')).task?.state === 'succeeded');
  await showView('build');
  await frame.locator('#build-state').filter({ hasText: '编译成功' }).waitFor();
  for (const [id, input, pattern] of [
    ['code.read', { path: 'Main.java' }, '你好'],
    ['code.build', {}, 'MAVEN SUCCESS 中文'],
    ['code.diff', { base: 'compare-base', target: 'compare-target' }, '+export const value = 2']
  ]) {
    const invocation = await page.evaluate(({ id, input }) =>
      workDesk.plugins.invoke('code-browser-probe', 'probe.call', [{ id, input }]), { id, input });
    let task;
    const deadline = Date.now() + 25000;
    do {
      task = await page.evaluate(id => workDesk.plugins.invoke('code-browser-probe', 'probe.get', [id]), invocation.invocationId);
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) {
        break;
      }
      await delay(50);
    } while (Date.now() < deadline);
    assert.equal(task.state, 'succeeded', `${JSON.stringify(task)}; logs=${logs.join('').slice(-10000)}`);
    assert.match(id === 'code.build' ? task.result.task.log : task.result.text, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const definitionCall = await page.evaluate(() => workDesk.plugins.invoke('code-browser-probe', 'probe.call',
    [{ id: 'code.definitions', input: { name: 'execute' } }]));
  await page.waitForFunction(async id =>
    (await workDesk.plugins.invoke('code-browser-probe', 'probe.get', [id])).state === 'succeeded', definitionCall.invocationId);
  const definitionResult = await page.evaluate(id => workDesk.plugins.invoke('code-browser-probe', 'probe.get', [id]),
    definitionCall.invocationId);
  assert.ok(definitionResult.result, JSON.stringify(definitionResult));
  assert.deepEqual(definitionResult.result.candidates.map(item => item.line), [3, 4]);
  await page.reload();
  await page.locator('.shelf-app[data-plugin="code-browser"]').click();
  await frame.getByRole('button', { name: 'Main.java', exact: true }).waitFor();
  assert.equal(await frame.locator('#tools-panel').isHidden(), true);
  await frame.getByRole('button', { name: 'Main.java', exact: true }).click();
  await frame.locator('#editor').waitFor();
  assert.match(await frame.locator('#editor').inputValue(), /你好/);
  assert.equal(await frame.locator('#projects button').count(), 2);
  assert.equal(await frame.locator('#projects button[aria-pressed="true"]').textContent(), 'project');
  await frame.locator('#projects-history').click();
  await frame.locator('#projects-popup').waitFor();
  await page.keyboard.press('Escape');
  await frame.locator('#git-tab').filter({ hasText: 'main' }).waitFor();
  await frame.locator('#git-tab').click();
  await frame.locator('.branch-browser .branch-tree > details').first().locator('.branch-entry').filter({ hasText: 'compare-base' }).waitFor();
  assert.equal(await frame.locator('.branch-browser .branch-tree > details').first().locator('.branch-favorite').getAttribute('aria-pressed'), 'true');
  await showView('source');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 650));
  assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true);
  await frame.locator('#editor').press('Control+f');
  await frame.locator('#symbol').fill('execute');
  await frame.locator('#definition-search').click();
  await frame.locator('#definitions button').first().waitFor();
  assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve('.test-results/code-browser/packaged.png') });
  await writeFile(join(root, 'mvnw'), '#!/bin/sh\necho "PID:$$"; sleep 60\n');
  await frame.locator('#build-tab').click();
  await frame.locator('#build-start').click();
  await frame.locator('#build-log').filter({ hasText: 'PID:' }).waitFor();
  await frame.locator('#build-stop').click();
  await frame.locator('#build-state').filter({ hasText: '已停止' }).waitFor();
  await frame.locator('#build-start').click();
  await frame.locator('#build-state').filter({ hasText: '编译中' }).waitFor();
  const active = await page.evaluate(() => workDesk.plugins.invoke('code-browser', 'code.build'));
  await page.reload();
  await page.locator('.shelf-app[data-plugin="code-browser"]').click();
  await frame.locator('#build-tab').click();
  await frame.locator('#build-state').filter({ hasText: '编译中' }).waitFor();
  await frame.locator('#build-log').filter({ hasText: 'PID:' }).waitFor();
  const pid = Number((await frame.locator('#build-log').textContent()).match(/PID:(\d+)/)[1]);
  assert.equal((await page.evaluate(() => workDesk.plugins.invoke('code-browser', 'code.build'))).task.id, active.task.id);
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('code-browser', 'disable');
    await workDesk.plugins.disable('code-browser', preview.confirmationToken);
  });
  assert.throws(() => process.kill(pid, 0));
  assert.equal((await page.evaluate(() => workDesk.plugins.invoke('code-browser-probe', 'probe.catalog'))).providers.length, 0);
  await page.evaluate(() => workDesk.plugins.enable('code-browser'));
  assert.ok((await page.evaluate(() => workDesk.plugins.invoke('code-browser', 'code.workspace'))).root.endsWith('/project'));
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'export const value = 2;\n');
  assert.deepEqual(errors, []);
  console.info('[coding:e2e] all plugin assertions passed; desktop cleanup follows');
});
