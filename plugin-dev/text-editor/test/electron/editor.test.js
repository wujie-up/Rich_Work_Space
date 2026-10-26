import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);
const markdown = `# 离线文档\n\n这是 **Markdown**。\n\n\`\`\`mermaid\ngraph TD\n A[开始] --> B[完成]\n\`\`\`\n\n\`\`\`plantuml\n@startuml\nAlice -> Bob : 本地验证\n@enduml\n\`\`\`\n\n\`\`\`plantuml\n@startuml\nclass User\nclass Order\nUser --> Order\n@enduml\n\`\`\`\n\n<img src="https://example.invalid/x" onerror="window.hacked=1"><script>window.hacked=1</script>`;

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
  await frame.locator('#editor').waitFor();
  assert.equal(await frame.locator('.brand').count(), 0);
  for (const name of ['打开文件夹', '新建', '保存', '另存为', '草稿', '编辑', '阅读', '分栏']) {
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
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
  await frame.locator('#folder').click();
  await frame.getByRole('button', { name: 'example.md', exact: true }).click();
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
  }
  for (const name of ['example.xml', 'example.yaml']) {
    await frame.getByRole('button', { name, exact: true }).click();
    await frame.locator('#format').click();
    await frame.locator('#save').click();
    await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
    const value = await readFile(join(directory, name), 'utf8');
    assert.match(value, name.endsWith('xml') ? /Hello <b>world<\/b>!/ : /# comment/);
  }
  await frame.getByRole('button', { name: 'example.json', exact: true }).click();
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
  await frame.locator('#drafts').click();
  await frame.locator('.draft button').filter({ hasText: 'example.json' }).click();
  assert.equal(await frame.locator('#editor').inputValue(), 'unfinished draft');
  await writeFile(join(directory, 'example.json'), '{"external":true}');
  await frame.locator('#save').click();
  await frame.locator('#status.error').filter({ hasText: '已被修改' }).waitFor();
  assert.equal(await readFile(join(directory, 'example.json'), 'utf8'), '{"external":true}');
  await frame.locator('#filename').fill('copy.txt');
  await frame.locator('#save-as').click();

  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(directory, 'copy.txt'), 'utf8'), 'unfinished draft');
  await frame.locator('#new').click();
  await frame.locator('#filename').fill('bad.md');
  await frame.locator('#filename').press('Tab');
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
  await frame.locator('#drafts').click();
  await frame.locator('.draft button').filter({ hasText: 'bad.md' }).click();
  assert.match(await frame.locator('#editor').inputValue(), /example.invalid/);
  await frame.getByRole('button', { name: 'example.md', exact: true }).click();
  await frame.locator('button[data-mode="split"]').click();
  await frame.locator('[data-rendered="mermaid"] svg').waitFor({ timeout: 60000 });
  assert.match(await frame.locator('[data-rendered="mermaid"] svg').textContent(), /开始/);
  assert.match(await frame.locator('[data-rendered="mermaid"] svg').textContent(), /完成/);
  await frame.locator('[data-rendered="plantuml"] svg').nth(1).waitFor({ timeout: 60000 });
  assert.equal(network.length, 0);
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await writeFile(resolve('.test-results/text-editor/packaged.log'), logs.join(''));
  await page.screenshot({ path: resolve('.test-results/text-editor/packaged.png') });
});
