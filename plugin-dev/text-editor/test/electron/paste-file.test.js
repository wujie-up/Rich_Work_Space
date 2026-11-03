import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from '../../../../desk/test/electron/helpers.js';
import { createFileClipboard } from '../../../../desk/src/main/os/mac/file-clipboard.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('external file paste opens original paths, preserves drafts and leaves text paste native', { timeout: 90000 }, async t => {
  let app;
  // Restore every clipboard format before application cleanup runs.
  t.after(async () => {
    if (app) {
      await app.evaluate(async ({ clipboard }) => clipboard.write(globalThis.editorPasteClipboard));
    }
  });
  const launched = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  const { page, data } = launched;
  app = launched.app;
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.editorPasteClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(
      Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  const root = join(await realpath(data), 'external');
  await mkdir(root);
  const first = join(root, '外部 v1 #100%.txt');
  const second = join(root, 'second.md');
  await writeFile(first, 'original external text');
  await writeFile(second, '# second document');
  await frame.locator('body').click({ position: { x: 400, y: 200 } });
  await createFileClipboard().write([first]);
  await page.keyboard.press('Meta+v');
  await frame.locator('#document-name').filter({ hasText: '外部 v1 #100%.txt' }).waitFor({ timeout: 8000 });
  assert.equal(await frame.locator('#editor').inputValue(), 'original external text');
  await frame.locator('#editor').fill('unsaved external draft');

  await createFileClipboard().write([second]);
  await frame.locator('#editor').press('Meta+v');
  await frame.locator('#document-name').filter({ hasText: 'second.md' }).waitFor();
  await frame.locator('#draft-list').getByRole('button', { name: '外部 v1 #100%.txt', exact: true }).waitFor();
  assert.equal(await readFile(first, 'utf8'), 'original external text');
  const history = await page.evaluate(() => workDesk.plugins.invoke('text-editor', 'editor.history', []));
  assert.equal(history.some(file => join(file.root, file.path) === first), true);
  assert.equal(history.some(file => join(file.root, file.path) === second), true);

  await frame.locator('button[data-mode="edit"]').click();
  await app.evaluate(({ clipboard }) => clipboard.writeText(' ordinary pasted text'));
  await frame.locator('#editor').evaluate(node => { node.focus(); node.setSelectionRange(node.value.length, node.value.length); });
  await page.keyboard.press('Meta+v');
  assert.equal(await frame.locator('#editor').inputValue(), '# second document ordinary pasted text');

  // Browser and editor file-copy payloads carry URI lists rather than native Files.
  await frame.locator('#editor').evaluate((node, uri) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/uri-list', `# file reference\r\n${uri}`);
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, pathToFileURL(first).href);
  await frame.locator('#document-name').filter({ hasText: '外部 v1 #100%.txt' }).waitFor();
  assert.equal(await readFile(second, 'utf8'), '# second document');

  const invalid = join(root, 'binary.txt');
  await writeFile(invalid, Buffer.from([0xff, 0x00]));
  await createFileClipboard().write([invalid]);
  await frame.locator('#editor').press('Meta+v');
  await frame.locator('#status.error').waitFor();
  assert.equal(await frame.locator('#document-name').textContent(), '外部 v1 #100%.txt');

  const third = join(root, 'batch.json');
  await writeFile(third, '{"batch":true}');
  await createFileClipboard().write([second, third]);
  await frame.locator('#editor').press('Meta+v');
  await frame.locator('#document-name').filter({ hasText: 'batch.json' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '{"batch":true}');
  await frame.locator('#status:not(.error)').waitFor();
  const entries = await page.evaluate(() => workDesk.plugins.invoke('text-editor', 'editor.history', []));
  assert.equal(entries.some(file => join(file.root, file.path) === third), true);
  assert.equal(entries.some(file => join(file.root, file.path) === invalid), false);
  assert.equal((await page.evaluate(() => workDesk.desktop.list())).length, 0, 'paste must not import files onto the desktop');
});
