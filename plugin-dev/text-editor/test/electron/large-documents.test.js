import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('large documents switch, retain drafts, restore and save through the desktop bridge', { timeout: 120000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  const root = join(data, 'documents');
  const line = '<p title="中文">report</p>\n';
  const text = line.repeat(Math.floor((16 * 1024 * 1024 - 100) / Buffer.byteLength(line)));
  const edited = `${text}未保存的内容`;
  await mkdir(root);
  await writeFile(join(root, 'report.html'), text);
  await writeFile(join(root, 'other.txt'), 'other document');
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, join(root, 'report.html'));
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'report.html' }).waitFor();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, join(root, 'other.txt'));
  await frame.locator('#open').click();
  await frame.locator('#document-name').filter({ hasText: 'other.txt' }).waitFor({ timeout: 5000 });
  assert.equal(await frame.locator('#editor').inputValue(), 'other document');

  await frame.locator('#group-files button[data-path="report.html"]').click();
  await frame.locator('#document-name').filter({ hasText: 'report.html' }).waitFor();
  await frame.locator('#editor').evaluate((editor, edited) => {
    editor.value = edited;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }, edited);
  await frame.locator('#group-files button[data-path="other.txt"]').click();
  await frame.locator('#document-name').filter({ hasText: 'other.txt' }).waitFor({ timeout: 15000 });
  assert.equal(await readFile(join(root, 'report.html'), 'utf8'), text);
  await page.reload();
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  await frame.locator('.draft button[data-id]').filter({ hasText: 'report' }).click();
  await frame.locator('#status').filter({ hasText: '已恢复草稿' }).waitFor({ timeout: 15000 });
  assert.ok(await frame.locator('#editor').inputValue() === edited, 'restored text matches every character');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor({ timeout: 15000 });
  assert.equal(await readFile(join(root, 'report.html'), 'utf8'), edited);
  await frame.locator('#group-files button[data-path="other.txt"]').click();
  await frame.locator('#document-name').filter({ hasText: 'other.txt' }).waitFor();
  assert.equal(await frame.locator('#status').evaluate(element => element.classList.contains('error')), false);

  const other = join(data, 'second');
  await mkdir(other);
  await writeFile(join(other, 'report.html'), 'second report');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, join(other, 'report.html'));
  await frame.locator('#open').click();
  const second = frame.locator(`#group-files button[data-path="report.html"][data-root="${await realpath(other)}"]`);
  await second.waitFor();
  const first = frame.locator(`#group-files button[data-path="report.html"][data-root="${await realpath(root)}"]`);
  await first.click();
  await frame.locator(`#group-files button[data-root="${await realpath(root)}"][data-path="report.html"][aria-current="page"]`).waitFor();
  // Delay only the save reply so a real history open can finish before its UI completion handler.
  await frame.locator('body').evaluate(() => {
    window.saveReplyHeld = new Promise(resolve => {
      const hold = event => {
        if (event.data?.type !== 'desk:result' || event.data.value?.text?.length < 1024 * 1024
          || event.data.value?.path !== 'report.html') {
          return;
        }
        event.stopImmediatePropagation();
        window.releaseSaveReply = () => {
          window.removeEventListener('message', hold, true);
          window.dispatchEvent(new MessageEvent('message', { data: event.data, source: event.source, origin: event.origin }));
        };
        resolve();
      };
      window.addEventListener('message', hold, true);
    });
  });
  await frame.locator('#save').click();
  await frame.locator('body').evaluate(() => window.saveReplyHeld);
  await second.click();
  await frame.locator(`#group-files button[data-root="${await realpath(other)}"][aria-current="page"]`).waitFor();
  await frame.locator('body').evaluate(async () => {
    window.releaseSaveReply();
    await new Promise(requestAnimationFrame);
  });
  await frame.locator('#editor').fill('second report edited');
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(join(other, 'report.html'), 'utf8'), 'second report edited');
  assert.ok(await readFile(join(root, 'report.html'), 'utf8') === edited, 'late save completion preserves the original file');
});
