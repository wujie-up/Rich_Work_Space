import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('clearing a saved provider key requires confirmation while ordinary saves retain their existing flow', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'provider-secret-removal-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './desk/src/resource/controls.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountSettings } from './plugin-dev/ai-agent/src/renderer/settings.js';
    window.postMessage = () => {};
    window.calls = [];
    const profiles = [{ id: 'saved-provider', name: 'Existing provider', engineId: 'codex',
      baseUrl: 'https://example.test/v1', model: 'original-model', protocol: 'responses', hasSecret: true }];
    const config = { defaultEngine: 'codex', engines: { codex: { providerId: 'saved-provider' }, claude: {} } };
    const engines = ['codex', 'claude'].map(id => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code',
      state: 'missing', pin: { version: 'fixture', platform: 'fixture', url: 'fixture', sha256: 'fixture' },
      installation: { state: 'idle' }, sources: { auth: 'fixture', skills: [], rules: [] } }));
    api.storage.getPreferences = async () => ({ theme: 'light', language: 'zh-CN' });
    conversationApi.call = async (method, ...args) => {
      window.calls.push({ method, args });
      if (method === 'engines.list') { return engines; }
      if (method === 'engines.config' || method === 'engines.configure') { return config; }
      if (method === 'providers.list') { return profiles; }
      if (method === 'mcp.catalog') { return []; }
      if (method === 'providers.save') { return { ...args[0], id: args[0].id || 'new-provider' }; }
    };
    window.settings = mountSettings(document.querySelector('main'));
    await window.settings.ready;
    window.ready = true;
  `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)), sourcefile: 'provider-secret-fixture.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main></main><script type="module" src="app.js"></script>');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  page.setDefaultTimeout(3000);
  await page.goto(`file://${join(fixture, 'index.html')}`);
  await page.waitForFunction(() => window.ready);
  const edit = async () => {
    await page.locator('[data-step="connect"]').click();
    await page.locator('#provider-list').getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('[data-step="model"]').click();
  };
  const writes = () => page.evaluate(() => window.calls.filter(call => ['providers.save', 'engines.configure'].includes(call.method)));
  const dialog = page.locator('dialog:popover-open');
  await edit();
  await page.locator('#provider-model').fill('draft-model');
  await page.locator('#clear-secret').evaluate(node => { node.checked = true; });
  for (const dismiss of ['cancel', 'escape', 'outside']) {
    await page.locator('#provider-save').click();
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /Existing provider/);
    assert.match(await dialog.textContent(), /密钥/);
    assert.deepEqual(await writes(), []);
    if (dismiss === 'cancel') { await dialog.getByRole('button', { name: '取消', exact: true }).click(); }
    if (dismiss === 'escape') { await page.keyboard.press('Escape'); }
    if (dismiss === 'outside') { await page.mouse.click(898, 798); }
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.id === 'provider-save');
    assert.deepEqual(await writes(), [], 'cancellation must neither save nor change the active provider');
    assert.equal(await page.locator('#provider-model').inputValue(), 'draft-model');
    assert.equal(await page.locator('#clear-secret').isChecked(), true);
    assert.equal(await page.locator('#provider-name').inputValue(), 'Existing provider');
  }
  await page.locator('#provider-save').click();
  await dialog.waitFor();
  await page.locator('#provider-model').evaluate(node => { node.value = 'changed-after-opening'; });
  await page.locator('#config-engine').evaluate(node => { node.value = 'claude'; node.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => document.querySelector('#settings').getAttribute('aria-busy') === 'false');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'engines.configure'));
  assert.deepEqual(await writes(), [
    { method: 'providers.save', args: [{ id: 'saved-provider', name: 'Existing provider', engineId: 'codex',
      protocol: 'responses', baseUrl: 'https://example.test/v1', model: 'draft-model', apiKey: '', clearSecret: true }] },
    { method: 'engines.configure', args: [{ engines: { codex: { providerId: 'saved-provider' } } }] }
  ]);
  await page.locator('#config-engine').selectOption('codex');
  await page.waitForFunction(() => document.querySelector('#settings').getAttribute('aria-busy') === 'false');
  for (const key of ['', 'replacement-test-key']) {
    await edit();
    await page.locator('#provider-secret').evaluate((node, value) => { node.value = value; }, key);
    await page.evaluate(() => { window.calls = []; });
    await page.locator('#provider-save').click();
    await page.waitForFunction(() => window.calls.some(call => call.method === 'engines.configure'));
    assert.equal(await dialog.count(), 0, 'ordinary saves and key replacement need no deletion confirmation');
    const calls = await writes();
    assert.equal(calls[0].args[0].apiKey, key);
    assert.equal(calls[0].args[0].clearSecret, false);
    assert.equal(calls.length, 2);
  }
  assert.equal(await page.locator('#notice').textContent(), '');
  await page.evaluate(() => window.settings.dispose());
});
