import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);
const markdown = `# 离线文档\n\n这是 **Markdown**。\n\n\`\`\`mermaid\ngraph TD\n A[开始] --> C[读取文档] --> D[检查内容] --> E[保存结果] --> B[完成]\n\`\`\`\n\n\`\`\`plantuml\n@startuml\nAlice -> Bob : 本地验证\nBob -> Alice : 读取文档\nAlice -> Bob : 检查内容\nBob -> Alice : 保存结果\nAlice -> Bob : 完成\n@enduml\n\`\`\`\n\n\`\`\`plantuml\n@startuml\nclass User\nclass Order\nUser --> Order\n@enduml\n\`\`\`\n\n<img src="https://example.invalid/x" onerror="window.hacked=1"><script>window.hacked=1</script>`;

test('desktop file opens in the real text plugin and saves after minimize and restore', { timeout: 60000 }, async t => {
  const { app, page, logs } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, archive);
  await page.evaluate(async () => {
    const existing = (await workDesk.plugins.list()).find(plugin => plugin.id === 'text-editor' && plugin.state !== 'uninstalled');
    if (existing) {
      const preview = await workDesk.plugins.preview(existing.id, 'remove');
      await workDesk.plugins.remove(existing.id, 'keep', preview.confirmationToken);
    }
    await workDesk.plugins.install();
    await workDesk.plugins.enable('text-editor');
    await workDesk.desktop.create('desktop-note.md');
  });
  const path = await page.evaluate(() => workDesk.desktop.resolve('desktop-note.md'));
  await writeFile(path, '# Desktop file');
  await page.reload();
  await page.getByRole('button', { name: '打开文件 desktop-note.md', exact: true }).dblclick();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#status').filter({ hasText: '已打开' }).waitFor({ timeout: 10000 }).catch(async error => {
    throw Error(`${error.message}\nEditor: ${await frame.locator('#status').textContent()}\n${logs.join('')}`);
  });
  await frame.locator('button[data-mode="edit"]').click();
  assert.equal(await frame.locator('#editor').inputValue(), '# Desktop file');
  await frame.locator('#editor').fill('# Retained desktop change');
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.application-window').style.visibility === 'hidden');
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await page.locator('.application-window:visible').evaluate(element =>
    Promise.all(element.getAnimations().map(animation => animation.finished)));
  assert.equal(await frame.locator('#editor').inputValue(), '# Retained desktop change');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(path, 'utf8'), '# Retained desktop change');
});

async function checkDiagramZoom(frame, language) {
  const figure = frame.locator(`[data-rendered="${language}"]`).first();
  const source = await frame.locator('#editor').inputValue();
  const fontSize = await frame.locator('#font-size').inputValue();
  await figure.locator('svg').click();
  const viewer = frame.getByRole('dialog', { name: '绘图查看器' });
  await viewer.waitFor({ timeout: 3000 });
  const svg = viewer.locator('.diagram-canvas > svg');
  const initial = await svg.boundingBox();
  await viewer.getByRole('button', { name: '放大', exact: true }).click();
  const enlarged = await svg.boundingBox();
  assert.ok(enlarged.width > initial.width && enlarged.height > initial.height, 'zoom must enlarge the whole diagram');
  const screen = await frame.locator('body').evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const bounds = await viewer.evaluate(element => element.getBoundingClientRect().toJSON());
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= screen.width && bounds.y + bounds.height <= screen.height);
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  const theme = await frame.locator('html').getAttribute('data-theme');
  await viewer.screenshot({ path: resolve(`.test-results/text-editor/diagram-${language}-${theme}-${screen.width}.png`) });
  await viewer.getByRole('button', { name: '缩小', exact: true }).click();
  assert.ok(Math.abs((await svg.boundingBox()).width - initial.width) < 1);
  for (let index = 0; index < 12; index++) {
    await viewer.getByRole('button', { name: '放大', exact: true }).click();
  }
  assert.equal(await viewer.getByRole('button', { name: '放大', exact: true }).isDisabled(), true);
  const overflow = await viewer.locator('.diagram-viewport').evaluate(element =>
    element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight);
  assert.equal(overflow, true, 'large diagrams must remain scrollable');
  await viewer.getByRole('button', { name: '重置', exact: true }).click();
  assert.ok(Math.abs((await svg.boundingBox()).width - initial.width) < 1);
  for (let index = 0; index < 3; index++) {
    await viewer.getByRole('button', { name: '缩小', exact: true }).click();
  }
  assert.equal(await viewer.getByRole('button', { name: '缩小', exact: true }).isDisabled(), true);
  await viewer.press('Escape');
  await viewer.waitFor({ state: 'hidden' });
  await figure.focus();
  await figure.press(language === 'mermaid' ? 'Enter' : 'Space');
  await viewer.waitFor();
  assert.ok(Math.abs((await svg.boundingBox()).width - initial.width) < 1, 'reopening must reset the diagram scale');
  await viewer.getByRole('button', { name: '关闭', exact: true }).click();
  await frame.locator(`[data-rendered="${language}"]:focus`).waitFor({ timeout: 3000 });
  assert.equal(await figure.evaluate(element => element === document.activeElement), true);
  assert.equal(await frame.locator('#editor').inputValue(), source);
  assert.equal(await frame.locator('#font-size').inputValue(), fontSize);
}

test('real archive: isolated import, file IO/format/undo, offline diagrams, drafts and theme', { timeout: 180000 }, async t => {
  const { app, page, data, logs } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  const errors = [];

  page.on('pageerror', error => errors.push(error.message));
  const network = [];
  await app.context().route(/^https?:\/\//, route => { network.push(route.request().url()); return route.abort(); });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, archive);
  await page.evaluate(async () => {
    if ((await workDesk.plugins.list()).some(plugin => plugin.id === 'text-editor' && plugin.state !== 'uninstalled')) {
      const preview = await workDesk.plugins.preview('text-editor', 'remove');
      await workDesk.plugins.remove('text-editor', 'keep', preview.confirmationToken);
    }
    await workDesk.plugins.install();
  });
  const record = await page.evaluate(async () => (await workDesk.plugins.list()).find(entry => entry.id === 'text-editor'));
  assert.equal(record.version, version);
  if (record.state !== 'enabled') { await page.evaluate(() => workDesk.plugins.enable('text-editor')); }
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#editor-tools').waitFor();
  assert.equal(await frame.locator('#panes').isVisible(), false);
  assert.equal(await frame.locator('.brand').count(), 0);
  for (const name of ['打开文件', '新建文件', '保存', '另存为', '编辑', '阅读', '分栏']) {
    const button = frame.getByRole('button', { name, exact: true });
    assert.equal(await button.locator('svg').count(), 1);
    assert.ok(await button.getAttribute('title'));
  }
  const directory = join(data, 'files');
  await mkdir(directory);
  await writeFile(join(directory, 'example.md'), markdown);
  await writeFile(join(directory, 'example.xml'), '<r><p>Hello <b>world</b>!</p></r>');
  await writeFile(join(directory, 'example.yaml'), '# comment\na: [1,2]');
  await writeFile(join(directory, 'example.json'), '{"n":9007199254740993123,"ok":true}');
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, join(directory, 'example.md'));
  await frame.locator('#open').click();
  await frame.locator('[data-rendered="mermaid"] svg').waitFor({ timeout: 60000 });
  assert.match(await frame.locator('[data-rendered="mermaid"] svg').textContent(), /开始/);
  assert.match(await frame.locator('[data-rendered="mermaid"] svg').textContent(), /完成/);
  await frame.locator('[data-rendered="plantuml"] svg').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  assert.equal(await frame.locator('[data-rendered="plantuml"] svg').count(), 2,
    `PlantUML errors: ${await frame.locator('.diagram-error').allTextContents()}`);
  assert.equal(await frame.locator('#preview img,#preview script').count(), 0);
  assert.equal(await frame.locator('body').evaluate(() => window.hacked), undefined);
  for (const mode of ['edit', 'read', 'split']) {
    await frame.locator(`button[data-mode="${mode}"]`).click();
    assert.equal(await frame.locator('#editor').isVisible(), mode !== 'read');
    assert.equal(await frame.locator('#preview').isVisible(), mode !== 'edit');
    if (mode !== 'edit') {
      await frame.locator('[data-rendered="plantuml"] svg').nth(1).waitFor({ timeout: 60000 });
      await checkDiagramZoom(frame, mode === 'read' ? 'mermaid' : 'plantuml');
    }
  }
  for (const name of ['example.xml', 'example.yaml']) {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, join(directory, name));
    await frame.locator('#open').click();
    await frame.locator('#document-name').filter({ hasText: name }).waitFor();
    await frame.locator('#format').click();
    await frame.locator('#save').click();
    await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
    const value = await readFile(join(directory, name), 'utf8');
    assert.match(value, name.endsWith('xml') ? /Hello <b>world<\/b>!/ : /# comment/);
  }
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, join(directory, 'example.json'));
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'example.json' }).waitFor();
  await frame.locator('#format').click();
  assert.match(await frame.locator('#editor').inputValue(), /\n  "n": 9007199254740993123/);
  await frame.locator('#editor').press('Meta+z');
  assert.equal(await frame.locator('#editor').inputValue(), '{"n":9007199254740993123,"ok":true}');
  await frame.locator('#format').click();
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.match(await readFile(join(directory, 'example.json'), 'utf8'), /9007199254740993123/);
  await frame.locator('#editor').fill('{broken}');
  await frame.locator('#format').click();
  await frame.locator('#status.error').waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '{broken}');
  await frame.locator('#editor').fill('unfinished draft');
  await frame.locator('#new').click();
  await frame.getByRole('button', { name: '取消', exact: true }).click();
  await frame.locator('.draft button').filter({ hasText: 'example' }).click();
  assert.equal(await frame.locator('#editor').inputValue(), 'unfinished draft');
  await writeFile(join(directory, 'example.json'), '{"external":true}');
  await frame.locator('#save').click();
  await frame.locator('#status.error').filter({ hasText: '已被修改' }).waitFor();
  assert.equal(await readFile(join(directory, 'example.json'), 'utf8'), '{"external":true}');
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, directory);
  await frame.locator('#save-as').click();
  await frame.locator('#filename').fill('copy.txt');
  await frame.getByRole('button', { name: '确认', exact: true }).click();

  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(directory, 'copy.txt'), 'utf8'), 'unfinished draft');
  await frame.locator('#new').click();
  await frame.locator('#filename').fill('bad.md');
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  await frame.locator('#status').filter({ hasText: '新建文件' }).waitFor();
  await frame.locator('#editor').fill('```plantuml\n!include https://example.invalid/evil\n```\n\n```mermaid\nthis is invalid\n```');
  await frame.locator('button[data-mode="split"]').click();
  await frame.locator('.diagram-error').nth(1).waitFor({ timeout: 30000 });
  assert.equal(network.length, 0, network.join('\n'));
  assert.deepEqual(errors, []);
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await page.emulateMedia({ colorScheme: null });
  await frame.locator('html[data-theme="dark"]').waitFor();
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await frame.locator('.draft button').filter({ hasText: 'bad' }).click();
  await frame.locator('#status').filter({ hasText: '已恢复草稿' }).waitFor();
  assert.match(await frame.locator('#editor').inputValue(), /example.invalid/);
  await frame.locator('#group-files').getByRole('button', { name: 'example.md', exact: true }).click();
  await frame.locator('button[data-mode="split"]').click();
  await frame.locator('[data-rendered="mermaid"] svg').waitFor({ timeout: 60000 });
  assert.match(await frame.locator('[data-rendered="mermaid"] svg').textContent(), /开始/);
  assert.match(await frame.locator('[data-rendered="mermaid"] svg').textContent(), /完成/);
  await frame.locator('[data-rendered="plantuml"] svg').nth(1).waitFor({ timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 600));
  await checkDiagramZoom(frame, 'mermaid');
  assert.equal(network.length, 0);
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await writeFile(resolve('.test-results/text-editor/packaged.log'), logs.join(''));
  await page.screenshot({ path: resolve('.test-results/text-editor/packaged.png') });
});
