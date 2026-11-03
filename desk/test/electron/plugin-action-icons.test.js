import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launch, openConfiguration } from './helpers.js';

// Exercise fresh plugin packages in disposable data; never change the user's installation.
test('all plugin action icons keep hints, accessible names and working handlers', { timeout: 180000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const manifests = [];
  for (const domain of ['ai-agent', 'mcp', 'text-editor', 'code-browser', 'codex-capture', 'work-flow', 'resource-monitor']) {
    const manifest = JSON.parse(await readFile(resolve(`plugin-dev/${domain}/plugin.json`), 'utf8'));
    manifests.push(manifest);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, resolve(`plugin-dev/dist/${manifest.id}-${manifest.version}.plg`));
    if (domain !== 'resource-monitor') {
      await page.evaluate(() => workDesk.plugins.install());
    }
  }
  const open = async id => {
    await page.locator(`.shelf-app[data-plugin="${id}"]`).click();
    const manifest = manifests.find(item => item.id === id);
    const frame = page.frameLocator(`iframe.plugin-view[title="${manifest.views[0].title}"]:visible`);
    await frame.locator('button').first().waitFor({ state: 'attached' });
    return frame;
  };
  const icon = async (frame, selector) => {
    const button = frame.locator(selector);
    await button.waitFor({ state: 'attached' });
    assert.equal((await button.textContent()).trim(), '', selector);
    assert.ok(await button.getAttribute('title'), `${selector}: hover hint`);
    assert.ok(await button.getAttribute('aria-label'), `${selector}: accessible name`);
    assert.ok(await button.locator('svg').count(), `${selector}: line icon`);
    const size = await button.locator('svg').boundingBox();
    if (size) {
      assert.ok(size.width <= 24 && size.height <= 24, `${selector}: icon dimensions`);
    }
  };
  const mcp = await open('mcp-services');
  await icon(mcp, '#new');
  await mcp.locator('#new').click();
  for (const selector of ['#save', '#debug', '#start', '#stop', '#remove', '#back']) {
    await icon(mcp, selector);
  }
  await mcp.locator('#back').click();
  assert.equal(await mcp.locator('#details').isHidden(), true);

  const editor = await open('text-editor');
  await icon(editor, '#format');
  await editor.locator('#type').selectOption('json');
  await editor.locator('#editor').fill('{"a":1}');
  await editor.locator('#format').click();
  assert.match(await editor.locator('#editor').inputValue(), /a/);
  const browser = await open('code-browser');
  for (const selector of ['#folder', '#search', '#refresh', '#build-start', '#build-stop']) {
    await icon(browser, selector);
  }
  const capture = await open('codex-capture');
  for (const selector of ['#toggle', '#refresh', '#more']) {
    await icon(capture, selector);
  }
  await capture.locator('#refresh').click();
  await icon(capture, '#toggle');
  const flow = await open('work-flow');
  for (const selector of ['#new-workflow', '#save', '#run', '#status', '#zoom-reset']) {
    await icon(flow, selector);
  }
  await flow.locator('#zoom-in').click();
  await icon(flow, '#zoom-reset');
  assert.match(await flow.locator('#zoom-reset').getAttribute('title'), /缩放/);
  const ai = await open('ai-agent-sessions');
  await ai.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await icon(ai, 'dialog button[aria-label="启动会话"]');
  await ai.locator('dialog button[aria-label="取消"]').click();
  await ai.getByRole('button', { name: '工作台操作', exact: true }).click();
  await ai.getByRole('button', { name: 'CLI 配置', exact: true }).click();
  await icon(ai, '#login');
  await ai.locator('#config-engine').selectOption('claude');
  await ai.locator('#login[title*="Claude"]').waitFor({ state: 'attached' });
  await icon(ai, '#login');
  await ai.locator('dialog .dialog-heading button').click();

  await page.evaluate(() => workDesk.plugins.install());
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="resource-monitor"]').getByRole('button', { name: '插件配置', exact: true }).click();
  const settings = page.frameLocator('.plugin-settings-content iframe');
  await icon(settings, 'button[aria-label="保存设置"]');
  await settings.locator('#interval').evaluate(node => new Promise(resolve => {
    const check = () => node.value ? resolve() : setTimeout(check, 20);
    check();
  }));
  await settings.getByLabel('采样间隔').fill('7');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  try {
    await settings.getByText('已保存', { exact: true }).waitFor();
  } catch (error) {
    t.diagnostic(await settings.locator('body').innerText());
    throw error;
  }
  await mkdir('.test-results/plugin-action-icons', { recursive: true });
  await page.screenshot({ path: '.test-results/plugin-action-icons/settings.png' });
  assert.deepEqual(errors, []);
});
