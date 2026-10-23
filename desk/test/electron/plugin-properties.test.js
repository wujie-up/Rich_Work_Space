import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openConfiguration } from './helpers.js';

test('hidden pure UI application stays manageable and opens without a backend', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false, executablePath: process.env.WORK_DESK_TEST_EXECUTABLE
  });
  const source = join(data, 'pure-ui-source');
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({
    id: 'pure-ui', name: 'Pure UI', version: '1.0.0', apiVersion: 2, dataVersion: 1,
    type: 'application', showIcon: false, loadOnStartup: false, background: 'none',
    views: [{ id: 'main', title: 'Pure UI', entry: 'index.html' }]
  }));
  await writeFile(join(source, 'index.html'), '<!doctype html><h1>Pure UI without backend</h1>');
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  }, source);
  await page.evaluate(() => workDesk.plugins.install());
  assert.equal(await page.locator('.shelf-app[data-plugin="pure-ui"]').count(), 0);
  await openConfiguration(page);
  const card = page.locator('[data-plugin="pure-ui"]');
  await card.locator('[data-plugin-properties="pure-ui"]').getByText(/无需后台/).waitFor();
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await page.frameLocator('iframe[title="Pure UI"]').getByRole('heading', { name: 'Pure UI without backend' }).waitFor();
  const record = await page.evaluate(async () => (await workDesk.plugins.list()).find(item => item.id === 'pure-ui'));
  assert.equal(record.background, 'none');
  assert.equal(record.state, 'enabled');
});


test('release plugin archives upgrade with retained private data and integrated MCP entry', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false, executablePath: process.env.WORK_DESK_TEST_EXECUTABLE
  });
  for (const [id, version] of [['ai-agent-sessions', '0.2.2'], ['mcp-services', '0.2.0']]) {
    const marker = join(data, 'plugin-data', id, 'retention-check.json');
    await mkdir(join(data, 'plugin-data', id), { recursive: true });
    await writeFile(marker, JSON.stringify({ retained: id }));
    await page.evaluate(async id => {
      const preview = await workDesk.plugins.preview(id, 'remove');
      await workDesk.plugins.remove(id, 'keep', preview.confirmationToken);
    }, id);
    await app.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
    }, resolve(`plugins/dist/${id}-${version}.plg`));
    await page.evaluate(() => workDesk.plugins.install());
    const record = await page.evaluate(async id => (await workDesk.plugins.list()).find(item => item.id === id), id);
    assert.equal(record.version, version);
    assert.deepEqual([record.type, record.showIcon, record.loadOnStartup, record.background],
      ['application', true, true, 'service']);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { retained: id });
  }
  assert.equal(await page.locator('.shelf-app[data-plugin="ai-mcp-adapter"]').count(), 0);
  const config = await page.evaluate(() => workDesk.plugins.invoke('mcp-services', 'mcp.ai.list'));
  assert.deepEqual(config.selected, []);
  const sessions = await page.evaluate(() => workDesk.plugins.invoke('ai-agent-sessions', 'sessions.list'));
  assert.deepEqual(sessions, { sessions: [], archives: [] });
});
