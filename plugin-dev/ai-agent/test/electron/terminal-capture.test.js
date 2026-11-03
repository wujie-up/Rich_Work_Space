import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, configure, owner } from '../../../../desk/test/electron/helpers.js';

test('packaged terminal workspace publishes current windows and sessions to the capture selector', { timeout: 90000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, [resolve('plugin-dev/dist/ai-agent-sessions-0.6.15.plg'), resolve('plugin-dev/dist/codex-capture-0.2.5.plg')]);
  await page.evaluate(() => workDesk.plugins.install());
  // Reproduce old empty history groups before the first real desktop Agent window opens.
  await page.evaluate(async owner => {
    for (let index = 0; index < 3; index++) {
      await workDesk.plugins.invoke(owner, 'conversation.registerWindow', [{ id: crypto.randomUUID() }]);
    }
  }, owner);
  await page.locator(`.shelf-app[data-plugin="${owner}"]`).click();
  const agent = page.locator('iframe[title="AI Agent 会话"]').contentFrame();
  await agent.locator('.workspace-tools').waitFor();
  await configure(page);
  await agent.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await agent.locator('select[name="adapter"]').selectOption('custom');
  await agent.locator('input[name="sessionName"]').fill('当前终端目标');
  await agent.locator('input[name="cwd"]').fill(resolve('.'));
  await agent.getByRole('button', { name: '启动会话', exact: true }).click();
  await agent.locator('.session').waitFor();
  const records = await page.evaluate(owner => agentDesk.sessions.list(owner), owner);
  assert.match(records.sessions[0].windowId, /^[a-f0-9-]{36}$/);
  await page.locator('.shelf-app[data-plugin="codex-capture"]').click();
  const capture = page.locator('iframe[title="Agent 抓包"]').contentFrame();
  await capture.locator('#agent-window option').nth(1).waitFor({ state: 'attached' });
  const options = await capture.locator('#agent-window option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
  const current = options.find(option => option.text === '窗口1');
  assert.ok(current, 'current terminal window must be discoverable');
  assert.equal(options.length, 2, 'only the real desktop Agent window is listed');
  await capture.locator('#agent-window').selectOption(current.value);
  await capture.locator('#conversation').selectOption(records.sessions[0].id);
  assert.match(await capture.locator('#conversation option:checked').textContent(), /当前终端目标/);
  assert.equal(await capture.locator('#toggle').isDisabled(), true, 'custom CLI is listed but never claims network capture support');
  await page.evaluate(() => {
    const frame = document.querySelector('iframe[title="Agent 抓包"]');
    frame.contentWindow.postMessage({ type: 'desk:event', channel: 'capture.event',
      value: { type: 'capture.unavailable', code: 'AGENT_UNAVAILABLE', message: '插件服务调用超时' } }, '*');
  });
  await capture.locator('#error').filter({ hasText: 'Agent 连接暂时不可用：插件服务调用超时' }).waitFor();
  await capture.locator('#error').filter({ hasText: /^$/ }).waitFor({ state: 'attached' });
  await mkdir('.test-results', { recursive: true });
  await page.screenshot({ path: resolve('.test-results/terminal-capture-current-window.png') });
  await page.getByRole('tab', { name: 'AI Agent 会话', exact: true }).dblclick();
  await capture.locator('#agent-window option').nth(2).waitFor({ state: 'attached' });
  assert.deepEqual(await capture.locator('#agent-window option').allTextContents(), ['选择 Agent 窗口', '窗口1', '窗口2']);
  await page.getByRole('tab', { name: 'AI Agent 会话', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.locator('dialog input').fill('接口排查');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await capture.locator('#agent-window option', { hasText: '接口排查' }).waitFor({ state: 'attached' });
  await page.getByRole('tab', { name: 'AI Agent 会话', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭窗口', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.application-window').length === 2);
  await capture.locator('#agent-window option', { hasText: '接口排查' }).waitFor({ state: 'detached' });
  assert.deepEqual(await capture.locator('#agent-window option').allTextContents(), ['选择 Agent 窗口', '窗口1']);
  assert.equal(await capture.locator('#conversation option').count(), 1, 'closed window selection is cleared without mixing retained sessions');
});
