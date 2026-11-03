import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openWorkspace, output, owner } from '../../../../desk/test/electron/helpers.js';

test('upgrading an open plugin loads the new waiting kettle without restarting the desktop', { timeout: 60000 }, async t => {
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json'), 'utf8'));
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('plugin-dev/dist/ai-agent-sessions-0.6.41.plg'));
  await page.evaluate(async owner => {
    await workDesk.plugins.install();
    await workDesk.plugins.enable(owner);
  }, owner);
  let view = await openWorkspace(page);
  await page.evaluate(({ owner, command, args }) => agentDesk.storage.saveAdapterConfig(owner,
    { codex: { mode: 'legacy', command, args } }),
  { owner, command: process.execPath, args: [resolve('plugin-dev/ai-agent/test/fixtures/activity-cli.cjs')] });
  const session = await page.evaluate(({ owner, cwd }) => agentDesk.sessions.create(owner,
    { adapterId: 'codex', name: '升级水壶资源', cwd }), { owner, cwd: data });
  await output(page, session.id, 'READY');
  await view.locator('.session-status[data-kind="waiting"]').waitFor();
  assert.equal(await view.locator('.session-status .mining-eyes').count(), 2);
  const preview = await page.evaluate(owner => workDesk.plugins.preview(owner, 'upgrade'), owner);
  await page.evaluate(({ owner, path, token }) => workDesk.plugins.upgrade(owner, path, token),
    { owner, path: resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`), token: preview.confirmationToken });
  view = await openWorkspace(page);
  await view.locator('.session-status[data-kind="waiting"]').waitFor();
  assert.equal(await view.locator('.session-status .kettle-body').count(), 1);
  assert.equal(await view.locator('.session-status').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
});
