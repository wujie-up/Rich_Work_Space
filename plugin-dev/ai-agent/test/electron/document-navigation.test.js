import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, output, owner } from '../../../../desk/test/electron/helpers.js';

test('Agent wrapped links reopen a removed document in the retained text window', { timeout: 60000 }, async t => {
  const { app, page, data } = await launch(t, {
    openPlugin: false, prepareData: data => writeFile(join(data, 'plugins.json'), '[]')
  });
  for (const directory of ['ai-agent', 'text-editor']) {
    const { id, version } = JSON.parse(await readFile(resolve(`plugin-dev/${directory}/plugin.json`), 'utf8'));
    await app.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
    }, resolve(`plugin-dev/dist/${id}-${version}.plg`));
    await page.evaluate(async id => { await workDesk.plugins.install(); await workDesk.plugins.enable(id); }, id);
  }
  const relative = `${'nested-directory/'.repeat(18)}target.md`;
  const target = join(data, relative);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, '# Exact target\n\nAgent navigation regression.');
  const other = join(data, 'previous.md');
  await writeFile(other, '# Previous history');
  const cli = join(data, 'document-cli.cjs');
  await writeFile(cli, `process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write('READY\\r\\n');
    process.stdin.on('data', () => process.stdout.write('\\x1b[2J\\x1b[H[Target](${relative})\\r\\n'));`);
  const session = await page.evaluate(async ({ owner, cwd, cli, command }) => {
    await workDesk.plugins.setMultipleWindows('text-editor', false);
    await agentDesk.storage.saveAdapterConfig(owner, { custom: { command, args: [cli] } });
    return agentDesk.sessions.create(owner, { adapterId: 'custom', name: 'Document link fixture', cwd });
  }, { owner, cwd: data, cli, command: process.execPath });
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  await output(page, session.id, 'READY');
  const agent = page.frameLocator('iframe.plugin-view[title="AI Agent 会话"]');
  const card = agent.locator(`[data-session="${session.id}"]`);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, 'document'), { owner, id: session.id });
  await output(page, session.id, `[Target](${relative})`);
  const clickLink = async () => {
    await page.locator('.application-window').evaluateAll(elements =>
      Promise.all(elements.flatMap(element => element.getAnimations().map(animation => animation.finished))));
    const screen = await card.locator('.xterm-screen').boundingBox();
    await page.mouse.move(screen.x + 20, screen.y + 7);
    await card.locator('.xterm-cursor-pointer').waitFor();
    await page.mouse.click(screen.x + 20, screen.y + 7);
  };
  await clickLink();
  const text = page.frameLocator('iframe.plugin-view[title="文本编辑器"]');
  await text.locator('#document-name').filter({ hasText: 'target.md' }).waitFor();
  assert.equal(await text.locator('#editor').inputValue(), '# Exact target\n\nAgent navigation regression.');
  const identity = await text.locator('body').evaluate(() => window.navigationIdentity = crypto.randomUUID());
  await text.locator('#group-files button[data-path="target.md"]').click({ button: 'right' });
  await text.getByRole('menuitem', { name: '移除记录', exact: true }).click();
  await text.locator('#status').filter({ hasText: '已移除记录' }).waitFor();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, other);
  await text.locator('#open').click();
  await text.locator('#document-name').filter({ hasText: 'previous.md' }).waitFor();
  await page.getByRole('tab', { name: 'AI Agent 会话', exact: true }).click();
  await clickLink();
  await text.locator('#document-name').filter({ hasText: 'target.md' }).waitFor();
  assert.equal(await text.locator('#editor').inputValue(), '# Exact target\n\nAgent navigation regression.');
  assert.equal(await text.locator('body').evaluate(() => window.navigationIdentity), identity);
  assert.equal(await page.locator('iframe.plugin-view[title="文本编辑器"]').count(), 1);
  assert.equal(await readFile(target, 'utf8'), '# Exact target\n\nAgent navigation regression.');
});
