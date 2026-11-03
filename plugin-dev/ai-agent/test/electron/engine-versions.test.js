import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

test('version checks select the newest release, retain choices and keep wizard navigation usable', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-engine-versions-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountSettings } from './plugin-dev/ai-agent/src/renderer/settings.js';
    // This renderer fixture has no host window or registered desk-host protocol.
    window.postMessage = () => {};
    api.storage.getPreferences = async () => ({ language: 'zh-CN', theme: 'light' });
    const config = { defaultEngine: 'codex', engines: {} };
    const engines = ['codex', 'claude'].map(id => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code',
      state: 'missing', pin: { version: '1.0.0', platform: 'darwin-arm64', url: 'https://example.com/engine', sha256: 'a'.repeat(64) },
      installation: { state: 'idle' }, sources: { auth: '/fixture/auth', skills: [], rules: [] } }));
    window.versionFailure = false;
    conversationApi.call = async (method, ...args) => {
      switch (method) {
        case 'engines.list': return engines;
        case 'engines.config': return config;
        case 'providers.list': case 'mcp.catalog': return [];
        case 'engines.versions':
          if (window.versionFailure) { throw Error('Command failed: /usr/bin/curl --proxy http://127.0.0.1:7897; HTTP 403'); }
          return [{ version: '1.2.3' }, { version: '1.10.0' }];
        case 'engines.install': window.installArgs = args; return { state: 'installing' };
        default: throw Error('Unexpected method: ' + method);
      }
    };
    window.controls = mountSettings(document.querySelector('main'), { pluginId: 'ai-agent-sessions' });
    await window.controls.ready;
    window.ready = true;
  `, resolveDir: fileURLToPath(new URL('../../../../', import.meta.url)), sourcefile: 'engine-versions.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main></main><script>window.addEventListener("error", event => { window.fixtureError = String(event.error?.stack || event.error || event.message); });</script><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/status-artwork.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  await page.locator('#load-versions').click();
  await page.locator('#target-version option[value="1.2.3"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#target-version').inputValue(), '1.10.0');
  await page.locator('#install').click();
  await page.waitForFunction(() => window.installArgs);
  assert.deepEqual(await page.evaluate(() => window.installArgs), ['codex', undefined, '1.10.0']);
  await page.locator('#target-version').selectOption('1.2.3');
  await page.locator('#load-versions').click();
  await page.waitForFunction(() => !document.querySelector('#load-versions').disabled);
  assert.equal(await page.locator('#target-version').inputValue(), '1.2.3');
  await page.evaluate(() => { window.versionFailure = true; });
  await page.locator('#load-versions').click();
  await page.waitForFunction(() => !document.querySelector('#load-versions').disabled);
  assert.match(await page.locator('#versions-status').innerText(), /失败.*内置校验版本.*离线包/);
  assert.equal(await page.locator('#notice').innerText(), '');
  assert.equal(await page.locator('#target-version').inputValue(), '1.2.3');
  assert.equal(await page.locator('#install').isEnabled(), true);
  await page.locator('[data-step="connect"]').click();
  await page.locator('#provider-add').click();
  assert.equal(await page.locator('#provider-name').isEditable(), true);
  await page.locator('#provider-reset').click();
  await page.locator('[data-step="model"]').click();
  assert.equal(await page.locator('.wizard-actions').count(), 0);
  const shots = resolve('plugin-dev/dist/verification/engine-versions');
  await mkdir(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(440, 700));
    await page.screenshot({ path: join(shots, `${theme}-model.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.locator('[data-step="install"]').click();
  await page.locator('#config-engine').selectOption('claude');
  await page.waitForFunction(() => document.querySelector('#settings').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#versions-status').innerText(), '');
  await page.locator('#config-engine').selectOption('codex');
  await page.waitForFunction(() => document.querySelector('#settings').getAttribute('aria-busy') === 'false');
  await page.locator('#install').click();
  await page.waitForFunction(() => window.installArgs?.[2] === undefined);
  assert.deepEqual(await page.evaluate(() => window.installArgs), ['codex', undefined, undefined]);
  await page.evaluate(() => { window.versionFailure = false; });
  await page.locator('#load-versions').click();
  await page.locator('#target-version option[value="1.2.3"]').waitFor({ state: 'attached' });
  assert.match(await page.locator('#versions-status').innerText(), /已获取 2/);
});
