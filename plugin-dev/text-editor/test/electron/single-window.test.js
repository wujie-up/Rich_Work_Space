import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/text-editor-${version}.plg`);

test('single text window opens the newly requested desktop file and retains the previous draft', { timeout: 60000 }, async t => {
  const { app, page } = await launch(t, {
    openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, archive);
  await page.evaluate(async () => {
    await workDesk.plugins.install();
    await workDesk.plugins.enable('text-editor');
    await workDesk.plugins.setMultipleWindows('text-editor', false);
    await workDesk.desktop.create('first.md');
    await workDesk.desktop.create('second.md');
    await workDesk.desktop.create('third.txt');
  });
  const paths = await page.evaluate(async () => Promise.all(['first.md', 'second.md', 'third.txt'].map(name => workDesk.desktop.resolve(name))));
  await writeFile(paths[0], '# First document');
  await writeFile(paths[1], '# Second document');
  await writeFile(paths[2], 'Third document');
  await page.reload();
  await page.getByRole('button', { name: '打开文件 first.md', exact: true }).dblclick();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#document-name').filter({ hasText: 'first.md' }).waitFor();
  await frame.locator('#panes[data-mode="read"]').waitFor();
  const identity = await frame.locator('body').evaluate(() => window.testWindowIdentity = crypto.randomUUID());
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.locator('#editor').fill('# Unsaved first document');
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  await page.getByRole('button', { name: '打开文件 second.md', exact: true }).dblclick();
  await frame.locator('#document-name').filter({ hasText: 'second.md' }).waitFor({ timeout: 5000 });
  await frame.locator('#panes[data-mode="read"]').waitFor();
  // Pointer coordinates must settle after the retained window's restore animation.
  await page.locator('.application-window').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  assert.equal(await frame.locator('#editor').inputValue(), '# Second document');
  assert.equal(await page.locator('.application-window').count(), 1);
  assert.equal(await frame.locator('body').evaluate(() => window.testWindowIdentity), identity, 'the retained frame must not reload');
  const drafts = await page.evaluate(() => workDesk.plugins.invoke('text-editor', 'editor.drafts', []));
  assert.ok(drafts.some(draft => draft.text === '# Unsaved first document'));
  assert.equal(await readFile(paths[0], 'utf8'), '# First document');
  assert.equal(await readFile(paths[1], 'utf8'), '# Second document');
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.locator('#editor').fill('# Saved second document', { timeout: 5000 });
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await readFile(paths[1], 'utf8'), '# Saved second document');

  const launchFiles = contexts => frame.locator('body').evaluate((_body, contexts) => Promise.all(contexts.map(context =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => reject(Error('Open request timed out')), 5000);
      window.addEventListener('message', function receive(event) {
        if (event.source === parent && event.origin === 'desk-host://desktop' && event.data?.id === id) {
          clearTimeout(timer);
          window.removeEventListener('message', receive);
          event.data.error ? reject(Error(event.data.error.message)) : resolve(event.data.value);
        }
      });
      parent.postMessage({ type: 'desk:invoke', id, method: 'host.openView', args: ['text-document', context] }, 'desk-host://desktop');
    }))), contexts);
  await launchFiles([{ path: join(paths[0], '..', 'missing.md') }]);
  await frame.locator('#status.error').waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), '# Saved second document', 'a failed launch retains the current document');
  await launchFiles([{ path: paths[0] }, { path: paths[2] }]);
  await frame.locator('#document-name').filter({ hasText: 'third.txt' }).waitFor();
  assert.equal(await frame.locator('#editor').inputValue(), 'Third document', 'the last request wins after an earlier launch fails');
  assert.equal(await page.locator('.application-window').count(), 1);
  assert.equal(await frame.locator('body').evaluate(() => window.testWindowIdentity), identity);
});
