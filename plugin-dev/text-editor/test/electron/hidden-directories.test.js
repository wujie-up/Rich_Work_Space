import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('file picker requests hidden directories and their documents remain editable', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, archive);
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#open').waitFor();

  const hidden = join(data, '.hidden-workspace');
  await mkdir(join(hidden, '.nested'), { recursive: true });
  await writeFile(join(hidden, '.nested', 'note.md'), '# Hidden document');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.hiddenDirectoryDialog = options;
      return { canceled: false, filePaths: [directory] };
    };
  }, join(hidden, '.nested', 'note.md'));
  await frame.locator('#open').click();
  assert.deepEqual(await app.evaluate(() => globalThis.hiddenDirectoryDialog.properties), ['openFile', 'showHiddenFiles']);
  await frame.locator('#document-name').filter({ hasText: 'note.md' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '# Hidden document');
  await frame.locator('#editor').fill('# Saved hidden document');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(hidden, '.nested', 'note.md'), 'utf8'), '# Saved hidden document');

  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await frame.locator('#open').click();
  assert.equal(await frame.locator('#editor').inputValue(), '# Saved hidden document');
  assert.equal(await frame.locator('#group-files').getByRole('button', { name: 'note.md', exact: true }).count(), 1);
});
