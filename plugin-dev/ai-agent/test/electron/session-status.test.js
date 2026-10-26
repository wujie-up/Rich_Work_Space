import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { launch, configure, create, output, owner, openWorkspace } from '../../../../desk/test/electron/helpers.js';

test('session status drawings follow the name without duplicate visible status text', { timeout: 60000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false, disabledPlugins: ['resource-monitor'] });
  await page.evaluate(async owner => {
    const preview = await workDesk.plugins.preview(owner, 'remove');
    await workDesk.plugins.remove(owner, 'keep', preview.confirmationToken);
  }, owner);
  await app.evaluate(({ dialog }, archive) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
  }, resolve('plugin-dev/dist/ai-agent-sessions-0.6.2.plg'));
  await page.evaluate(() => workDesk.plugins.install());
  await openWorkspace(page);
  await configure(page);
  const session = await create(page, '状态位置验证');
  await output(page, session.id, 'READY 中文');
  const card = page.frameLocator('iframe.plugin-view[title="AI Agent 会话"]').locator('.session');
  await card.waitFor();
  // UI fixtures exercise each drawing without starting a real AI request.
  for (const [activity, kind] of [['idle', 'waiting'], ['working', 'working'], ['done', 'waiting']]) {
    await page.evaluate(({ session, activity }) => {
      document.querySelector('iframe.plugin-view').contentWindow.postMessage({ type: 'desk:event', channel: 'sessions.changed',
        value: { sessions: [{ ...session, activity }] } }, '*');
    }, { session, activity });
    await card.locator(`.session-status[data-state="${activity}"]`).waitFor();
    assert.equal(await card.locator('.activity').isVisible(), false);
    assert.equal(await card.locator(`.session-name + .session-status[data-kind="${kind}"] svg`).count(), 1);
    assert.ok(await card.locator('.session-status').getAttribute('aria-label'));
  }
  assert.equal((await page.evaluate(owner => workDesk.plugins.list(), owner)).find(p => p.id === owner).version, '0.6.2');
});
