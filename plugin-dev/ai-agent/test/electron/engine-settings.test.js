import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launch, openConfiguration } from '../../../../desk/test/electron/helpers.js';

test('packaged AI settings manage two engines without changing legacy data; conversation selection stays with history', { timeout: 90000 }, async t => {
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
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); },
    resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`));
  await page.evaluate(() => workDesk.plugins.install());
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('ai-agent-sessions', method, args), { method, args });
  await invoke('storage.saveAdapterConfig', { custom: { command: 'keep-command', args: ['keep'] } });
  const legacyBefore = await readFile(join(data, 'plugin-data/ai-agent-sessions/config.json'));
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="ai-agent-sessions"]').getByRole('button', { name: '插件配置', exact: true }).click();
  const dialog = page.locator('dialog.plugin-settings');
  const settings = dialog.locator('iframe').contentFrame();
  await settings.locator('#installation').getByText('尚未安装').waitFor();
  await settings.locator('#config-engine').selectOption('claude');
  await settings.locator('#engine-info').getByText('Claude Code 2.1.310', { exact: false }).waitFor();
  await settings.locator('#default-engine').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).defaultEngine === 'claude');
  await settings.locator('#reuse-skills').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).engines.claude.reuseSkills);
  await settings.locator('#reuse-rules').click();
  await page.waitForFunction(async () => (await workDesk.plugins.invoke('ai-agent-sessions', 'engines.config', [])).engines.claude.reuseRules);
  assert.equal(await settings.locator('#device-login').isVisible(), false);
  assert.equal(await settings.locator('#login').isDisabled(), true);
  assert.equal(await settings.locator('#notice').innerText(), '');
  await mkdir(resolve(`plugin-dev/dist/verification/ai-agent-${version}`), { recursive: true });
  await settings.locator('#config-engine').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(`plugin-dev/dist/verification/ai-agent-${version}/settings.png`) });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
  const conversation = page.locator('iframe.plugin-view').first().contentFrame();
  await conversation.locator('#conversation-engine').getByRole('option', { name: 'Claude Code' }).waitFor({ state: 'attached' });
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
  await conversation.locator('#config-engine').selectOption('claude');
  assert.equal(await conversation.locator('#conversation-engine').inputValue(), 'codex');
  assert.deepEqual(await readFile(join(data, 'plugin-data/ai-agent-sessions/config.json')), legacyBefore);
  assert.equal(await conversation.locator('#notice').innerText(), '');
});
