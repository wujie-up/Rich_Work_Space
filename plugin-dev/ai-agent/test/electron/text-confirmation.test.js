import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { prepareClaudeActivity } from '../../src/main/common/adapters/claude-activity.js';

test('plain questions use a centered intervention popup while native terminal and permission choices stay intact', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-text-confirmation-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './plugin-dev/ai-agent/src/renderer/session-status.css';
    import '@xterm/xterm/css/xterm.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    window.postMessage = () => {};
    const pluginId = 'ai-agent-sessions';
    window.session = { id: 'question', pluginId, adapterId: 'claude', name: '方案确认', cwd: '/project', activity: 'working' };
    window.writes = [];
    api.host.getWindowContext = async () => ({ id: 'fixture-window' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => ({});
    api.storage.getAdapterConfig = async () => ({});
    api.storage.saveLayout = async () => {};
    api.sessions.recover = async () => ({ sessions: [], archives: [] });
    api.sessions.list = async () => ({ sessions: [window.session] });
    api.sessions.attachWindow = async () => {};
    api.sessions.attach = async () => ({ data: 'TOOL_OUTPUT /project GPT Worked for 2m', sequence: 0 });
    api.sessions.resize = async () => {};
    api.sessions.write = async (owner, id, data) => {
      if (window.failWrite) { throw Error('回复发送失败'); }
      window.writes.push(data);
    };
    api.events.sessionsChanged = changed => { window.refreshSessions = changed; return () => {}; };
    window.dispose = await mountWorkspace(document.querySelector('main'), { pluginId, adapters: [{ id: 'claude', capabilities: {} }] });
    window.ready = true;`, resolveDir: fileURLToPath(new URL('../../../../', import.meta.url)), sourcefile: 'confirmation-fixture.js' },
  bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/status-artwork.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready);
  const monitor = await prepareClaudeActivity(state => page.evaluate(state => {
    Object.assign(window.session, state);
    window.refreshSessions({ sessions: [window.session] });
  }, state));
  t.after(() => monitor.close());
  const send = async event => {
    const response = await fetch(monitor.settings.hooks.Stop[0].hooks[0].url, { method: 'POST',
      body: JSON.stringify({ session_id: 'question', ...event }) });
    assert.equal(response.status, 200);
  };
  const icon = page.locator('.session-header .session-status');
  const popup = page.locator('.question-popup');
  const answer = popup.getByRole('textbox', { name: '回答' });
  const submit = popup.getByRole('button', { name: '发送回答' });
  await page.locator('.xterm').evaluate(node => { window.terminal = node; });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.writes = []; }, theme);
    await send({ hook_event_name: 'Stop', last_assistant_message: '目标环境是 DEV 还是 FAT？' });
    await page.locator('.session-header .session-status[data-kind="blocked"]').waitFor();
    assert.equal(await icon.getAttribute('aria-label'), '等待用户确认');
    assert.equal(await icon.locator('.kettle-steam').count(), 3);
    assert.equal(await icon.evaluate(node => getComputedStyle(node).color), theme === 'light' ? 'rgb(188, 84, 84)' : 'rgb(231, 126, 126)');
    await popup.waitFor({ state: 'visible' });
    assert.equal((await popup.locator('.question-text').textContent()).trim(), '目标环境是 DEV 还是 FAT？');
    assert.equal(await popup.locator('.xterm, .session-footer, .native-confirmation, h2').count(), 0);
    assert.doesNotMatch(await popup.textContent(), /TOOL_OUTPUT|\/project|GPT|Worked for/);
    assert.equal(await page.locator('.native-confirmation').isVisible(), false);
    const longQuestion = '收到，问题场景是在手机 H5 联登旧系统后进入登录页。\n\n'
      + '已检查后端链路，目前还不能确定是换取 Token 失败，还是 H5 接收登录态失败。'
      + '请补充正式 / 测试环境、操作时间，以及手机浏览器还是 App / 飞书内打开，便于继续核对日志。';
    await send({ hook_event_name: 'Stop', last_assistant_message: longQuestion });
    await page.waitForFunction(question => document.querySelector('.question-text')?.textContent.replace(/\s+/g, '') === question.replace(/\s+/g, ''), longQuestion);
    assert.ok((await popup.boundingBox()).width >= 560, 'long questions have a wider reading area');
    assert.equal(await submit.isDisabled(), true, 'an empty answer cannot be sent');
    const markdown = '请确认 **恢复方案**：\n\n- 保留展期\n- 恢复还款中\n\n1. 核对订单\n2. 执行恢复\n\n> 仅查询\n\n使用 \u0060order_id\u0060。\n\n\u0060\u0060\u0060sql\nSELECT 1;\n\u0060\u0060\u0060\n\n| 字段 | 值 |\n| --- | --- |\n| id | 42 |\n\n[文档](https://example.com) <img src=x onerror="window.injected=true"> [危险](javascript:alert(1))\n\n请选择方案。';
    await send({ hook_event_name: 'Stop', last_assistant_message: markdown });
    await popup.locator('strong').waitFor();
    assert.equal(await popup.locator('strong').textContent(), '恢复方案');
    assert.equal(await popup.locator('ul li').count(), 2);
    assert.equal(await popup.locator('ol li').count(), 2);
    assert.equal(await popup.locator('blockquote').innerText(), '仅查询');
    assert.equal((await popup.locator('pre code').textContent()).trim(), 'SELECT 1;');
    assert.equal(await popup.locator('table tbody td').count(), 2);
    assert.equal(await popup.locator('img, script, a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => !!window.injected), false);
    assert.equal(await popup.locator('a[href="https://example.com"]').getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await answer.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    assert.equal(await answer.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    const composerColor = await popup.locator('.desk-intervention-composer').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.equal(composerColor, theme === 'light' ? 'rgb(247, 247, 247)' : 'rgb(24, 24, 24)');
    await answer.fill('第一行');
    await answer.press('Shift+Enter');
    assert.equal(await page.evaluate(() => window.writes.length), 0, 'Shift+Enter never submits');
    assert.match(await answer.inputValue(), /\n/);

    if (process.env.QUESTION_SCREENSHOTS) {
      await mkdir(process.env.QUESTION_SCREENSHOTS, { recursive: true });
      await popup.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
      await page.screenshot({ path: join(process.env.QUESTION_SCREENSHOTS, `${theme}.png`) });
    }
    await answer.fill('FAT');
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'hidden' });
    assert.equal(await icon.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.writes.length), 0, 'dismissal never submits');
    await page.evaluate(() => window.refreshSessions({ sessions: [window.session] }));
    assert.equal(await popup.isVisible(), false, 'status redraws do not reopen dismissed questions');
    await icon.focus();
    await page.keyboard.press('Enter');
    await popup.waitFor({ state: 'visible' });
    assert.equal(await answer.inputValue(), 'FAT');
    await page.evaluate(() => { window.failWrite = true; });
    await submit.click();
    await page.getByText('回复发送失败', { exact: true }).waitFor();
    assert.equal(await popup.isVisible(), true);
    assert.equal(await answer.inputValue(), 'FAT');
    await page.evaluate(() => { window.failWrite = false; });
    await answer.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, isComposing: true
    })));
    assert.equal(await page.evaluate(() => window.writes.length), 0, 'IME confirmation never submits');
    await answer.press('Enter');
    await popup.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.writes), ['\x1b[200~FAT\x1b[201~', '\r']);
    await send({ hook_event_name: 'UserPromptSubmit' });
    await page.locator('.session-header .session-status[data-kind="working"]').waitFor();
    assert.equal(await page.locator('.native-confirmation').isVisible(), false);
    assert.equal(await page.locator('.xterm').evaluate(node => node === window.terminal), true);
    await send({ hook_event_name: 'Stop', last_assistant_message: '已完成并验证通过。' });
    await page.locator('.session-header .session-status[data-kind="waiting"]').waitFor();
  }
  await page.evaluate(() => { window.resizeTo(320, 540); });
  await page.waitForFunction(() => innerWidth <= 320);
  await send({ hook_event_name: 'Stop', last_assistant_message: '请确认以下方案：\n' + '长问题内容 '.repeat(200) + '\n请选择 A 或 B。' });
  await popup.waitFor({ state: 'visible' });
  const bounds = await popup.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
  assert.equal(await popup.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  if (process.env.QUESTION_SCREENSHOTS) {
    await mkdir(process.env.QUESTION_SCREENSHOTS, { recursive: true });
    await popup.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
    await page.screenshot({ path: join(process.env.QUESTION_SCREENSHOTS, 'narrow.png') });
  }
  await page.mouse.click(viewport.width - 4, viewport.height - 4);
  await popup.waitFor({ state: 'hidden' });
  await send({ hook_event_name: 'PermissionRequest' });
  assert.equal(await popup.isVisible(), false, 'native permissions retain their own CLI controls');
  assert.equal(await page.locator('.native-confirmation').isVisible(), true);
  await send({ hook_event_name: 'Stop', last_assistant_message: '请选择 A 或 B。' });
  await popup.waitFor({ state: 'visible' });
  await page.evaluate(() => window.dispose());
  assert.equal(await popup.count(), 0, 'disposing workspace removes its popup');
});
