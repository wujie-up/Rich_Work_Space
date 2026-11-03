import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, openConfiguration } from './helpers.js';

test('disabled plugin can be enabled from its card and opened through the native host', async t => {
  const { page, data } = await launch(t, {
    openPlugin: false,
    prepareData: async data => {
      const directory = join(data, 'plugins/enable-contract');
      const manifest = { id: 'enable-contract', name: '启用契约', version: '1.0.0', apiVersion: 2, dataVersion: 1,
        type: 'application', singleInstance: true, showIcon: true, loadOnStartup: false, background: 'none',
        views: [{ id: 'main', title: '契约页面', entry: 'index.html' }] };
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'plugin.json'), JSON.stringify(manifest));
      await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><h1>启用后页面</h1>');
      await writeFile(join(data, 'plugins.json'), JSON.stringify([{ ...manifest, state: 'disabled', autoStart: false }]));
    }
  });
  await openConfiguration(page);
  const card = page.locator('.plugin-card[data-plugin="enable-contract"]');
  assert.equal(await card.getByRole('button', { name: '打开', exact: true }).count(), 0);
  const enable = card.getByRole('button', { name: '启用', exact: true });
  await enable.waitFor({ timeout: 5000 });
  assert.equal(await enable.getAttribute('title'), '启用');
  assert.equal(await enable.locator('svg[aria-hidden="true"]').count(), 1);
  await page.setViewportSize({ width: 420, height: 680 });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await enable.focus();
    assert.equal(await enable.evaluate(node => node === document.activeElement), true);
    const bounds = await enable.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 420);
    await page.locator('#settings-panel').screenshot({ path: `/tmp/work-desk-enable-${theme}-20261031.png` });
  }
  await enable.click({ timeout: 5000 });
  await card.getByRole('button', { name: '打开', exact: true }).waitFor();
  assert.equal(await enable.count(), 0);
  const saved = JSON.parse(await readFile(join(data, 'plugins.json'), 'utf8'));
  assert.equal(saved.find(record => record.id === 'enable-contract').state, 'enabled');
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await page.frameLocator('iframe.plugin-view[src^="desk-plugin://enable-contract/"]').getByRole('heading', { name: '启用后页面' }).waitFor();
});
