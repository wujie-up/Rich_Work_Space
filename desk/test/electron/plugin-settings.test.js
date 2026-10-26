import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, openConfiguration } from './helpers.js';

// An isolated contract plugin exercises the production protocol and worker without business plugins or user data.
test('packaged settings: independent page invokes its own worker and retains installed metadata', async t => {
  const { page } = await launch(t, {
    openPlugin: false, executablePath: process.env.DESK_SETTINGS_EXECUTABLE,
    prepareData: async data => {
      const directory = join(data, 'plugins/settings-contract');
      await mkdir(directory, { recursive: true });
      await writeFile(join(data, 'plugins.json'), '[]');
      await writeFile(join(directory, 'plugin.json'), JSON.stringify({ id: 'settings-contract', name: '配置契约', version: '1.0.0',
        author: '契约作者', apiVersion: 2, dataVersion: 1, type: 'service', showIcon: false, loadOnStartup: false,
        background: 'service', main: 'main.mjs', settings: { entry: 'settings.html' }, requiredHostFeatures: ['desk.settings.v1'] }));
      await writeFile(join(directory, 'main.mjs'), `export function activate(context) {
    context.methods.register('settings.read', () => ({ retained: true }));
  } export function deactivate() {}`);
      await writeFile(join(directory, 'settings.html'), `<!doctype html><meta charset="UTF-8"><script>
    addEventListener('message', event => {
      if (event.data.type === 'desk:result') document.body.textContent = JSON.stringify(event.data);
    });
    addEventListener('DOMContentLoaded', () => parent.postMessage({ type: 'desk:invoke', id: 1,
      method: 'plugin.invoke', args: ['settings.read', []] }, '*'));
    </script><body></body>`);
    }
  });
  page.on('console', message => { if (message.type() === 'error') { console.error(message.text()); } });
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="settings-contract"]').getByRole('button', { name: '插件配置', exact: true }).click();
  const dialog = page.locator('dialog.plugin-settings');
  await dialog.getByText('作者：契约作者', { exact: true }).waitFor();
  const body = dialog.locator('iframe').contentFrame().locator('body');
  await body.getByText('"retained":true', { exact: false }).waitFor();
  const result = JSON.parse(await body.innerText());
  assert.deepEqual(result, { type: 'desk:result', id: 1, value: { retained: true } });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const plugin = (await page.evaluate(() => workDesk.plugins.list())).find(item => item.id === 'settings-contract');
  assert.equal(plugin.state, 'enabled');
  assert.equal(plugin.author, '契约作者');
  assert.equal(plugin.settings.entry, 'settings.html');
});
