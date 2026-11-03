import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('upgraded editor loads current file highlighting after the previous view was used', { timeout: 120000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, resolve('plugin-dev/dist/text-editor-0.1.32.plg'));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  const path = join(data, 'current.txt');
  await writeFile(path, 'current file');
  await page.evaluate(async path => {
    await workDesk.plugins.invoke('text-editor', 'editor.openDocument', ['fixture', { path }]);
  }, path);
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#history button').click();
  await frame.locator('#document-name').filter({ hasText: 'current.txt' }).waitFor();
  assert.equal(await frame.locator('#history button[aria-current="page"]').count(), 1);
  await page.evaluate(async source => {
    const preview = await workDesk.plugins.preview('text-editor', 'upgrade');
    await workDesk.plugins.upgrade('text-editor', source, preview.confirmationToken);
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await frame.locator('#group-files button').click();
  await frame.locator('#document-name').filter({ hasText: 'current.txt' }).waitFor();
  assert.equal(await frame.locator('body').evaluate(() => [...document.styleSheets]
    .flatMap(sheet => [...sheet.cssRules]).some(rule => rule.cssText.includes('aria-current'))), true);
  assert.deepEqual(await frame.locator('#group-files button[aria-current="page"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['current.txt']);
  await frame.locator('#document-name').hover();
  assert.equal(await frame.locator('#group-files button').evaluate(element => getComputedStyle(element).fontWeight), '600');
  assert.notEqual(await frame.locator('#group-files button').evaluate(element => getComputedStyle(element).boxShadow), 'none');
});
