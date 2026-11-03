import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launch, openConfiguration } from '../../../../desk/test/electron/helpers.js';

test('packaged AI settings manage two engines without changing legacy data; conversation selection stays with history', { timeout: 150000 }, async t => {
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json'), 'utf8'));
  const previousId = '11111111-1111-4111-8111-111111111111';
  const { app, page, data } = await launch(t, { openPlugin: false, prepareData: async data => {
    await writeFile(join(data, 'plugins.json'), '[]');
    const history = join(data, 'plugin-data/ai-agent-sessions/conversations');
    await mkdir(history, { recursive: true });
    await writeFile(join(history, `${previousId}.json`), JSON.stringify({
      id: previousId, name: '保留的历史对话', engineId: 'codex', cwd: '/tmp', state: 'idle',
      createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
      events: [{ method: 'user/message', params: { text: '仅在选择历史后显示的内容' } }]
    }));
  } });
  // Register before sandbox listeners; holding a request must precede the host invocation.
  await page.addInitScript(() => {
    const pending = [];
    let released = false;
    window.releaseTestCatalog = () => {
      released = true;
      for (const { data, source, origin } of pending) {
        window.dispatchEvent(new MessageEvent('message', { data: { ...data, testDelayed: true }, source, origin }));
      }
    };
    window.testPendingCatalog = pending;
    window.addEventListener('message', event => {
      if (!window.holdTestCatalog || released || event.data?.type !== 'desk:invoke' || event.data.method !== 'plugin.invoke'
        || event.data.args?.[0] !== 'mcp.catalog' || event.data.testDelayed) { return; }
      event.stopImmediatePropagation();
      pending.push({ data: event.data, source: event.source, origin: event.origin });
    }, { capture: true });
  });
  await page.reload();
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); },
    resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`));
  await page.evaluate(() => workDesk.plugins.install());
  await page.evaluate(() => workDesk.plugins.enable('ai-agent-sessions'));
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('ai-agent-sessions', method, args), { method, args });
  await invoke('storage.saveAdapterConfig', { custom: { command: 'keep-command', args: ['keep'] } });
  const legacyBefore = await readFile(join(data, 'plugin-data/ai-agent-sessions/config.json'));
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="ai-agent-sessions"]').getByRole('button', { name: '插件配置', exact: true }).click();
  const dialog = page.locator('dialog.plugin-settings');
  const settings = dialog.locator('iframe').contentFrame();
  await settings.locator('#installation').waitFor({ state: 'attached' });
  await page.waitForTimeout(1500);
  await settings.locator('#installation').getByText(/尚未安装|Not installed/).waitFor();
  assert.equal(await settings.locator('[data-step]').count(), 3);
  assert.equal(await settings.locator('[data-step-panel="install"]').isVisible(), true);
  assert.equal(await settings.locator('#provider-form').isVisible(), false);
  await settings.locator('[data-tab="appearance"]').click();
  assert.equal(await settings.locator('#config-engine').isVisible(), false);
  assert.equal(await settings.locator('#conversation-font-size').inputValue(), '14');
  await settings.locator('#conversation-font-size').selectOption('18');
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'appearance.get', [])).fontSize === 18);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-data/ai-agent-sessions/appearance.json'), 'utf8')), { fontSize: 18 });
  await settings.locator('[data-tab="engine"]').click();
  await settings.locator('#config-engine').selectOption('claude');
  await settings.locator('#engine-info').getByText('Claude Code 2.1.310', { exact: false }).waitFor();
  await settings.locator('#default-engine').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).defaultEngine === 'claude');
  await settings.locator('[data-tab="cli"]').click();
  await settings.locator('#reuse-skills').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).engines.claude.reuseSkills);
  await settings.locator('#reuse-rules').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).engines.claude.reuseRules);
  await settings.locator('[data-tab="engine"]').click();
  await settings.locator('[data-step="connect"]').click();
  assert.equal(await settings.locator('#device-login').isVisible(), false);
  assert.equal(await settings.locator('#login').isDisabled(), true);
  assert.equal(await settings.locator('#notice').innerText(), '');
  await settings.locator('[data-tab="mcp"]').click();
  await settings.locator('#mcp-all').uncheck();
  await settings.locator('#save-services').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).engines.claude.mcp?.mode === 'selected');
  await page.evaluate(() => { window.holdTestCatalog = true; });
  await settings.locator('#config-engine').selectOption('codex');
  await page.waitForFunction(() => window.testPendingCatalog.length > 0);
  await settings.locator('#settings[aria-busy="true"]').waitFor();
  assert.equal(await settings.locator('#settings').evaluate(element => element.inert), true);
  await page.evaluate(() => window.releaseTestCatalog());
  await settings.locator('#settings[aria-busy="false"]').waitFor();
  assert.equal(await settings.locator('#mcp-all').isChecked(), true);
  assert.equal((await invoke('engines.config')).engines.claude.mcp.mode, 'selected');
  await settings.locator('#config-engine').selectOption('claude');
  await settings.locator('#settings[aria-busy="false"]').waitFor();
  assert.equal(await settings.locator('#mcp-all').isChecked(), false);
  await settings.locator('[data-tab="engine"]').click();
  await settings.locator('[data-step="connect"]').click();
  await settings.locator('#provider-add').click();
  assert.equal(await settings.locator('#new-connection #provider-form').isVisible(), true);
  await settings.locator('[data-step="model"]').click();
  assert.equal(await settings.locator('[data-step-panel="connect"]').isVisible(), true);
  await settings.locator('#provider-template').selectOption('deepseek');
  assert.equal(await settings.locator('#provider-url').inputValue(), 'https://api.deepseek.com/anthropic');
  await settings.locator('#provider-name').fill('Preserved provider');
  await settings.locator('#provider-secret').fill('synthetic-ui-key');
  await settings.locator('[data-step="model"]').click();
  await settings.locator('[data-step="connect"]').click();
  assert.equal(await settings.locator('#provider-secret').inputValue(), 'synthetic-ui-key');
  await settings.locator('[data-step="model"]').click();
  await settings.locator('#provider-model').fill('deepseek-chat');
  await settings.locator('#provider-save').click();
  await settings.locator('#summary-model').getByText('deepseek-chat', { exact: true }).waitFor();
  await settings.locator('[data-step="connect"]').click();
  await settings.locator('#provider-list article').waitFor();
  assert.equal(await settings.locator('#provider-secret').inputValue(), '');
  const profiles = await invoke('providers.list');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].hasSecret, true);
  assert.equal(JSON.stringify(profiles).includes('synthetic-ui-key'), false);
  assert.equal(await settings.locator('#active-provider').inputValue(), profiles[0].id);
  const savedConnection = settings.locator('#configured-connections #provider-list article');
  assert.equal(await savedConnection.getAttribute('data-active'), 'true');
  assert.equal(await savedConnection.locator('.connection-url').innerText(), 'https://api.deepseek.com/anthropic');
  assert.equal(await savedConnection.locator('.connection-badge').isVisible(), true);
  assert.equal(await settings.locator('#account').isVisible(), true);
  assert.equal(await settings.locator('#account-selected').isVisible(), false);
  assert.equal(await settings.locator('#provider-form').isVisible(), false);
  await settings.locator('#active-provider').selectOption('');
  await settings.locator('#account-card[data-active="true"]').waitFor();
  assert.equal(await savedConnection.locator('.connection-badge').isVisible(), false);
  await settings.locator('#active-provider').selectOption(profiles[0].id);
  await savedConnection.locator('.connection-badge').waitFor();
  await page.waitForFunction(async id => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).engines.claude.providerId === id, profiles[0].id);
  await settings.locator('#provider-list article button').first().click();
  await settings.locator('[data-step="model"]').click();
  await settings.locator('#provider-model').fill('deepseek-reasoner');
  await settings.locator('#provider-save').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'providers.list', []))[0].model === 'deepseek-reasoner');
  assert.equal((await invoke('providers.list'))[0].hasSecret, true);
  await settings.locator('#summary-model').getByText('deepseek-reasoner', { exact: true }).waitFor();
  await mkdir(resolve(`plugin-dev/dist/verification/ai-agent-${version}`), { recursive: true });
  await settings.locator('[data-step="connect"]').click();
  await settings.locator('#configured-connections').scrollIntoViewIfNeeded();
  for (const theme of ['light', 'dark']) {
    await settings.locator('html').evaluate((element, value) => { element.dataset.theme = value; }, theme);
    await settings.locator('#provider-list article').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(`plugin-dev/dist/verification/ai-agent-${version}/providers-${theme}.png`) });
    await settings.locator('#new-connection').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(`plugin-dev/dist/verification/ai-agent-${version}/new-connection-${theme}.png`) });
  }
  await settings.locator('[data-step="install"]').click();

  await mkdir(resolve(`plugin-dev/dist/verification/ai-agent-${version}`), { recursive: true });
  await settings.locator('#config-engine').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(`plugin-dev/dist/verification/ai-agent-${version}/settings.png`) });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.locator('.shelf-app[data-plugin="ai-agent-sessions"]').click();
  const workspace = page.locator('iframe.plugin-view[title="AI Agent 会话"]').contentFrame();
  await workspace.locator('.workspace-tools').waitFor();
  await workspace.locator('html[style*="--agent-font-size: 18px"]').waitFor();
  await workspace.locator('body').evaluate(() => window.parent.postMessage({ type: 'desk:invoke', id: 'test-open-conversation',
    method: 'host.openView', args: ['global-conversation'] }, 'desk-host://desktop'));
  const conversation = page.locator('iframe.plugin-view[title="AI 对话"]').contentFrame();
  await conversation.locator('#conversation-engine').getByRole('option', { name: 'Claude Code' }).waitFor({ state: 'attached' });
  assert.equal(await conversation.locator('#transcript').evaluate(node => getComputedStyle(node).fontSize), '18px');
  await page.waitForTimeout(200);
  assert.equal(await conversation.locator('#conversation-engine').inputValue(), 'claude');
  assert.equal(await conversation.locator('#send').isDisabled(), true);
  assert.equal(await conversation.locator('#history').inputValue(), '');
  assert.equal(await conversation.getByText('仅在选择历史后显示的内容', { exact: true }).count(), 0);
  await conversation.locator('#history').selectOption(previousId);
  await conversation.getByText('仅在选择历史后显示的内容', { exact: true }).waitFor();
  await conversation.locator('#history').selectOption('');
  assert.equal(await conversation.getByText('仅在选择历史后显示的内容', { exact: true }).count(), 0);
  await conversation.locator('#conversation-engine').selectOption('codex');
  await conversation.locator('#settings-toggle').click();
  await conversation.locator('[data-tab="appearance"]').click();
  await conversation.locator('#conversation-font-size').selectOption('20');
  await workspace.locator('html[style*="--agent-font-size: 20px"]').waitFor({ state: 'attached' });
  await conversation.locator('[data-tab="engine"]').click();
  await conversation.locator('#config-engine').selectOption('claude');
  assert.equal(await conversation.locator('#conversation-engine').inputValue(), 'codex');
  assert.deepEqual(await readFile(join(data, 'plugin-data/ai-agent-sessions/config.json')), legacyBefore);
  assert.equal(await conversation.locator('#conversation-notice').innerText(), '');
});
