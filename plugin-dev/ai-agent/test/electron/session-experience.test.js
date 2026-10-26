import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, output, owner, toggleTheme } from '../../../../desk/test/electron/helpers.js';

test('native activity, confirmation and scrolling preserve terminals; document links open the text plugin', { timeout: 90000 }, async t => {
  const { page, data } = await launch(t, { disabledPlugins: ['resource-monitor'] });
  await page.evaluate(({ owner, command, args }) => agentDesk.storage.saveAdapterConfig(owner,
    { codex: { mode: 'legacy', command, args } }),
  { owner, command: process.execPath, args: [resolve('plugin-dev/ai-agent/test/fixtures/activity-cli.cjs')] });
  await writeFile(join(data, 'report.md'), '# Agent 报告\n\n通过文本插件浏览。');
  const create = name => page.evaluate(({ owner, cwd, name }) => agentDesk.sessions.create(owner,
    { adapterId: 'codex', name, cwd }), { owner, cwd: data, name });
  const first = await create('原生状态验证');
  const second = await create('互不影响');
  await output(page, first.id, 'READY');
  await output(page, second.id, 'READY');
  const view = page.locator('iframe[title="AI Agent 会话"]').contentFrame();
  const card = view.locator(`[data-session="${first.id}"]`);
  const write = data => page.evaluate(({ owner, id, data }) => agentDesk.sessions.write(owner, id, data), { owner, id: first.id, data });
  await card.locator('.session-status[data-kind="waiting"]').waitFor();
  await card.locator('.xterm-screen').evaluate(node => { node.dataset.retained = 'same'; });
  await view.locator('.windows').evaluate(node => {
    window.cardMoves = 0;
    new MutationObserver(records => { window.cardMoves += records.length; }).observe(node, { childList: true });
  });
  await write('history');
  await output(page, first.id, 'history 399');
  const viewport = card.locator('.xterm-viewport');
  await viewport.evaluate(node => { node.scrollTop = 0; });
  await write('working');
  await card.locator('.session-status[data-kind="working"]').waitFor();
  await write('blocked');
  await card.locator('.session-status[data-kind="blocked"]').waitFor();
  await card.locator('.native-confirmation:visible').waitFor();
  assert.equal(await view.locator('.native-confirmation:visible').count(), 1);
  assert.equal(await viewport.evaluate(node => node.scrollTop), 0);
  assert.equal(await view.locator('.windows').evaluate(() => window.cardMoves), 0);
  await card.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('1');
  await output(page, first.id, 'CHOICE="1"');
  await card.locator('.session-status[data-kind="waiting"]').waitFor();
  assert.equal(await card.locator('.native-confirmation').isVisible(), false);
  assert.equal(await card.locator('.xterm-screen').getAttribute('data-retained'), 'same');

  if (await page.locator('html').getAttribute('data-theme') !== 'dark') { await toggleTheme(page); }
  await write('document');
  await output(page, first.id, '[报告](report.md)');
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const screen = await card.locator('.xterm-screen').boundingBox();
  await page.mouse.move(screen.x + 25, screen.y + 7);
  await page.waitForTimeout(250);
  await page.mouse.click(screen.x + 25, screen.y + 7);
  const text = page.locator('iframe[title="文本编辑器"]').contentFrame();
  await text.locator('#preview').getByRole('heading', { name: 'Agent 报告', exact: true }).waitFor();
  await mkdir(resolve('.test-results'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/agent-document-text-plugin.png') });
});
