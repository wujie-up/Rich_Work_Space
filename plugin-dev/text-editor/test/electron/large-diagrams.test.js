import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);
const source = ['@startuml', ...Array.from({ length: 320 }, (_, index) => `Alice -> Bob : Step ${index + 1}`), '@enduml'].join('\n');

test('long PlantUML diagrams render completely in Markdown and standalone files', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, archive);
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await page.emulateMedia({ colorScheme: null });
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  for (const [name, content, theme] of [
    ['long.md', `# Long sequence\n\n\`\`\`plantuml\n${source}\n\`\`\``, 'light'],
    ['long.puml', source, 'dark']
  ]) {
    const path = join(data, name);
    await writeFile(path, content);
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await frame.locator(`html[data-theme="${theme}"]`).waitFor();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await frame.locator('#open').click();
    await frame.locator('#document-name').filter({ hasText: name }).waitFor();
    await frame.locator('#preview figure svg, #preview .diagram-error').first().waitFor({ timeout: 30000 });
    assert.deepEqual(await frame.locator('#preview .diagram-error').allTextContents(), []);
    const figure = frame.locator('figure[data-rendered="plantuml"]');
    const svg = figure.locator('svg');
    assert.ok(await svg.evaluate(element => element.viewBox.baseVal.height) > 9642,
      'the regression fixture must exceed both the reported diagram height and the engine default limit');
    const labels = await svg.locator('text').allTextContents();
    assert.ok(labels.includes('Step 1'));
    assert.ok(labels.includes('Step 320'));
    await figure.focus();
    await figure.press('Enter');
    const viewer = frame.locator('#diagram-viewer');
    await viewer.waitFor();
    await viewer.locator('[data-zoom="in"]').click();
    await viewer.locator('[data-zoom="in"]').click();
    assert.equal(await viewer.locator('.diagram-viewport').evaluate(element => element.scrollHeight > element.clientHeight), true);
    await viewer.locator('.diagram-viewport').evaluate(element => element.scrollTo(0, element.scrollHeight));
    assert.equal(await viewer.getByText('Step 320', { exact: true }).evaluate(element => {
      const label = element.getBoundingClientRect();
      const viewport = element.closest('.diagram-viewport').getBoundingClientRect();
      return label.top >= viewport.top && label.bottom <= viewport.bottom;
    }), true, 'the final sequence step must remain accessible by scrolling');
    await viewer.screenshot({ path: resolve(`.test-results/text-editor/long-plantuml-${theme}.png`) });
    await viewer.locator('[data-zoom="close"]').click();
    assert.equal(await frame.locator('#editor').inputValue(), content);
  }
});
