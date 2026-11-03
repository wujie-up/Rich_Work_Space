import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/text-editor/plugin.json'), 'utf8'));

test('split Markdown keeps corresponding sections aligned when either pane scrolls', { timeout: 90000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(resolve(data, 'plugins.json'), '[]') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 900));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve(`plugin-dev/dist/text-editor-${version}.plg`));
  await page.evaluate(async () => { await workDesk.plugins.install(); await workDesk.plugins.enable('text-editor'); });
  await page.locator('.shelf-app[data-plugin="text-editor"]').click();
  const frame = page.frameLocator('iframe.plugin-view[title="文本编辑器"]:visible');
  await frame.locator('#new').click();
  await frame.getByRole('button', { name: '确认', exact: true }).click();
  const source = '# 起点\n\n| 字段 | 说明 |\n| --- | --- |\n' + '| 字段 | 说明内容 |\n'.repeat(45)
    + '\n## 中间章节\n\n' + '段落内容\n\n'.repeat(50)
    + '## 后半章节\n\n```text\n' + '代码行\n'.repeat(35) + '```\n\n' + '结尾内容\n\n'.repeat(50);
  await frame.locator('#editor').fill(source);
  await frame.locator('#preview h2').nth(1).waitFor();
  // The fixture source lines fit at this width; Markdown table rows have a different rendered height.
  const sourceTop = text => frame.locator('#editor').evaluate((editor, text) => {
    const line = editor.value.slice(0, editor.value.indexOf(text)).split('\n').length - 1;
    return line * parseFloat(getComputedStyle(editor).lineHeight) + parseFloat(getComputedStyle(editor).paddingTop);
  }, text);
  const middle = await sourceTop('## 中间章节');
  await frame.locator('#editor').evaluate((node, top) => { node.scrollTop = top; }, middle);
  await frame.locator('#preview h2').first().evaluate(node => new Promise((resolve, reject) => {
    const deadline = performance.now() + 2000;
    const check = () => {
      const pane = node.parentElement;
      const distance = node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      if (Math.abs(distance) < 35) { resolve(); }
      else if (performance.now() > deadline) { reject(Error(`preview section is ${distance}px from source section`)); }
      else { requestAnimationFrame(check); }
    };
    check();
  }));
  await frame.locator('#preview h2').nth(1).evaluate(node => node.scrollIntoView({ block: 'start' }));
  const later = await sourceTop('## 后半章节');
  await frame.locator('#editor').evaluate((node, top) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 2000;
    const check = () => Math.abs(node.scrollTop - top) < 35 ? resolve()
      : performance.now() > deadline ? reject(Error(`source offset ${node.scrollTop}, expected ${top}`)) : requestAnimationFrame(check);
    check();
  }), later);
  for (const pane of ['editor', 'preview']) {
    await frame.locator(`#${pane}`).evaluate(node => { node.scrollTop = node.scrollHeight; });
    await frame.locator('#panes').evaluate(node => new Promise((resolve, reject) => {
      const deadline = performance.now() + 2000;
      const check = () => [...node.querySelectorAll('#editor,#preview')].every(pane => pane.scrollHeight - pane.clientHeight - pane.scrollTop < 2)
        ? resolve() : performance.now() > deadline ? reject(Error('panes did not reach the bottom together')) : requestAnimationFrame(check);
      check();
    }));
    await frame.locator(`#${pane}`).evaluate(node => { node.scrollTop = 0; });
    await frame.locator('#panes').evaluate(node => new Promise((resolve, reject) => {
      const deadline = performance.now() + 2000;
      const check = () => [...node.querySelectorAll('#editor,#preview')].every(pane => pane.scrollTop < 2)
        ? resolve() : performance.now() > deadline ? reject(Error('panes did not return to the top together')) : requestAnimationFrame(check);
      check();
    }));
  }
  await frame.getByRole('button', { name: '编辑', exact: true }).click();
  await frame.locator('#editor').evaluate((node, top) => { node.scrollTop = top; }, middle);
  await frame.getByRole('button', { name: '分栏', exact: true }).click();
  await frame.locator('#preview').evaluate(node => new Promise((resolve, reject) => {
    const deadline = performance.now() + 2000;
    const check = () => Math.abs(node.querySelector('h2').getBoundingClientRect().top - node.getBoundingClientRect().top) < 35
      ? resolve() : performance.now() > deadline ? reject(Error('switching to split mode lost the source position')) : requestAnimationFrame(check);
    check();
  }));
  await frame.getByRole('button', { name: '阅读', exact: true }).click();
  await frame.locator('#preview h2').nth(1).evaluate(node => node.scrollIntoView({ block: 'start' }));
  await frame.getByRole('button', { name: '分栏', exact: true }).click();
  await frame.locator('#editor').evaluate((node, top) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 2000;
    const check = () => Math.abs(node.scrollTop - top) < 35 ? resolve()
      : performance.now() > deadline ? reject(Error('returning from reading lost the preview position')) : requestAnimationFrame(check);
    check();
  }), later);
  // Presentation changes pane visibility; preview-only scrolling must preserve the editor's return position.
  const beforePresentation = await frame.locator('#editor').evaluate(node => node.scrollTop);
  await frame.locator('body').evaluate(async body => {
    body.dataset.presenting = 'true';
    await new Promise(requestAnimationFrame);
    document.querySelector('#preview').scrollTop = 0;
    await new Promise(requestAnimationFrame);
    delete body.dataset.presenting;
  });
  await page.waitForTimeout(150);
  assert.ok(Math.abs(await frame.locator('#editor').evaluate(node => node.scrollTop) - beforePresentation) < 2,
    'preview-only presentation must not reset the source position');
  await frame.getByRole('spinbutton', { name: '字号' }).fill('20');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(0, 0);
    window.setSize(680, 650);
  });
  const updated = source.replace('## 中间章节', '```mermaid\ngraph TD\n A --> B --> C\n```\n\n## 更新章节')
    .replaceAll('段落内容', '较长的段落用于验证窄窗口下原文换行和预览换行高度不同的情况。'.repeat(4));
  await frame.locator('#editor').fill(updated);
  await frame.locator('#preview [data-rendered="mermaid"] svg').waitFor();
  await frame.locator('#preview h2').first().filter({ hasText: '更新章节' }).waitFor();
  // Use native textarea layout as an independent check of wrapped source line positions.
  const wrappedTop = await frame.locator('#editor').evaluate(editor => {
    const probe = editor.cloneNode();
    Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', flex: 'none',
      width: `${editor.getBoundingClientRect().width}px`, height: '1px', minHeight: '0' });
    probe.value = editor.value.slice(0, editor.value.indexOf('## 更新章节')) + '## 更新章节';
    editor.parentElement.append(probe);
    try {
      const style = getComputedStyle(probe);
      return probe.scrollHeight - parseFloat(style.paddingBottom) - parseFloat(style.lineHeight);
    } finally {
      probe.remove();
    }
  });
  await frame.locator('#editor').evaluate((node, top) => { node.scrollTop = top; }, wrappedTop);
  await frame.locator('#preview').evaluate(node => new Promise((resolve, reject) => {
    const deadline = performance.now() + 2000;
    const check = () => {
      const distance = node.querySelector('h2').getBoundingClientRect().top - node.getBoundingClientRect().top;
      if (Math.abs(distance) < 35) { resolve(); }
      else if (performance.now() > deadline) { reject(Error(`wrapped section differs by ${distance}px`)); }
      else { requestAnimationFrame(check); }
    };
    check();
  }));
  await mkdir(resolve('.test-results/text-editor'), { recursive: true });
  await frame.locator('body').screenshot({ path: resolve('.test-results/text-editor/scroll-sync.png') });
  assert.deepEqual(errors, []);
});
