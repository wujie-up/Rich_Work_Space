import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openWorkspace, output, owner } from '../../../../desk/test/electron/helpers.js';

test('packaged heating kettle retains status semantics and respects reduced motion', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  const { version } = JSON.parse(await readFile(resolve('plugin-dev/ai-agent/plugin.json'), 'utf8'));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve(`plugin-dev/dist/ai-agent-sessions-${version}.plg`));
  await page.evaluate(async owner => {
    await workDesk.plugins.install();
    await workDesk.plugins.enable(owner);
  }, owner);
  await openWorkspace(page);
  await page.evaluate(({ owner, command, args }) => agentDesk.storage.saveAdapterConfig(owner,
    { codex: { mode: 'legacy', command, args } }),
  { owner, command: process.execPath, args: [resolve('plugin-dev/ai-agent/test/fixtures/activity-cli.cjs')] });
  const session = await page.evaluate(({ owner, cwd }) => agentDesk.sessions.create(owner,
    { adapterId: 'codex', name: '加热状态', cwd }), { owner, cwd: data });
  await output(page, session.id, 'READY');
  const view = page.locator('iframe[title="AI Agent 会话"]').contentFrame();
  const card = view.locator(`[data-session="${session.id}"]`);
  const write = data => page.evaluate(({ owner, id, data }) => agentDesk.sessions.write(owner, id, data),
    { owner, id: session.id, data });
  await card.locator('.session-status[data-kind="waiting"]').waitFor();
  await write('working');
  const status = card.locator('.session-status[data-kind="working"]');
  await status.waitFor();
  assert.ok(await status.getAttribute('aria-label'));
  assert.equal(await status.locator('svg').getAttribute('viewBox'), '0 0 64 48');
  const heat = status.locator('.kettle-heat');
  assert.equal(await heat.count(), 1);
  const firstPose = await heat.evaluate(node => getComputedStyle(node).opacity);
  await page.waitForTimeout(350);
  assert.notEqual(await heat.evaluate(node => getComputedStyle(node).opacity), firstPose);
  await status.locator('svg').evaluate(node => { node.dataset.retained = 'yes'; });
  await write('working');
  await output(page, session.id, 'READY');
  assert.equal(await status.locator('svg').getAttribute('data-retained'), 'yes');
  const shots = resolve('.test-results/session-animation');
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'workspace.png') });
  // Capture the packaged artwork in both themes at the approved preview size.
  await status.evaluate(node => { node.style.width = '320px'; node.style.height = '240px'; });
  for (const theme of ['light', 'dark']) {
    await status.evaluate((node, theme) => { node.ownerDocument.documentElement.dataset.theme = theme; }, theme);
    await status.screenshot({ path: join(shots, `kettle-${theme}.png`) });
    assert.equal(await status.locator('.kettle-body').count(), 1);
  }
  await status.evaluate(node => { node.style.width = ''; node.style.height = ''; });
  const second = await page.evaluate(({ owner, cwd }) => agentDesk.sessions.create(owner,
    { adapterId: 'codex', name: '并排会话', cwd }), { owner, cwd: data });
  await output(page, second.id, 'READY');
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'working'), { owner, id: second.id });
  await view.locator(`[data-session="${second.id}"] .session-status[data-kind="working"]`).waitFor();
  assert.ok((await view.locator('.session-status[data-kind="working"]').evaluateAll(nodes => nodes.map(node => {
    const status = node.getBoundingClientRect();
    const card = node.closest('.session').getBoundingClientRect();
    return status.left >= card.left && status.right <= card.right && status.top >= card.top && status.bottom <= card.bottom;
  }))).every(Boolean));
  await page.screenshot({ path: join(shots, 'tiled.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok((await heat.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName)))
    .every(name => name === 'none'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await write('blocked');
  await card.locator('.session-status[data-kind="blocked"]').waitFor();
  await write('1');
  await card.locator('.session-status[data-kind="waiting"]').waitFor();
  await view.getByRole('button', { name: '工作台操作', exact: true }).click();
  await view.locator('.workspace-menu').getByRole('menuitem', { name: 'CLI 配置', exact: true }).click();
  await view.locator('#settings[aria-busy="false"]').waitFor();
  assert.equal(await view.locator('.configuration-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: join(shots, 'configuration.png') });
});
