import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('字号立即同步已有终端、会话组和结构化会话，保存后重开保留', { timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-appearance-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bridge = `
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountAppearance } from './plugin-dev/ai-agent/src/renderer/appearance.js';
    window.postMessage = () => {};
    const subscribers = new Set();
    conversationApi.onAppearance = fn => { subscribers.add(fn); return () => subscribers.delete(fn); };
    window.broadcast = value => subscribers.forEach(fn => fn(value));
    window.addEventListener('storage', event => {
      if (event.key === 'appearance') { window.broadcast(JSON.parse(event.newValue)); }
    });
    api.storage.getPreferences = async () => ({ theme: 'dark', language: 'zh-CN' });
    conversationApi.call = async (method, value) => {
      if (method === 'appearance.get') { return JSON.parse(localStorage.getItem('appearance')) || { fontSize: 14 }; }
      if (method === 'appearance.save') {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (window.failSave) { throw Error('保存字号失败'); }
        localStorage.setItem('appearance', JSON.stringify(value)); window.broadcast(value); return value;
      }
      if (method === 'engines.list') { return ['codex', 'claude'].map(id => ({ id, name: id,
        pin: { version: '1', platform: 'test', url: 'test', sha256: 'test' }, sources: { auth: '', skills: [], rules: [] },
        installation: {}, state: 'missing' })); }
      if (method === 'engines.config') { return { defaultEngine: 'codex', engines: {} }; }
      if (method === 'providers.list' || method === 'mcp.catalog') { return []; }
      throw Error('Unexpected method ' + method);
    };
    conversationApi.onAccount = () => () => {};
    window.disposeAppearance = mountAppearance();
  `;
  for (const [name, source] of Object.entries({
    workspace: `
      import './desk/src/resource/controls.css';
      import './plugin-dev/ai-agent/src/renderer/workspace.css';
      import './plugin-dev/ai-agent/src/renderer/session-groups.css';
      import '@xterm/xterm/css/xterm.css';
      import { mountSettings } from './plugin-dev/ai-agent/src/renderer/settings.js';
      import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
      ${bridge}
      document.body.innerHTML = '<main id="settings-root"></main><aside class="session-groups"><div class="group-heading"><strong>会话组</strong></div><button class="group-choice"><span>开发会话组</span><small>2</small></button><button class="group-member"><span>后端开发成员</span></button></aside><div class="session-concise"><div class="session-concise-body">简洁视图会话正文</div></div><div class="connection-draft"><textarea aria-label="会话草稿">保留的草稿</textarea></div><div class="question-popup"><div class="desk-intervention-composer"><textarea aria-label="回答">多行回答</textarea></div></div><div id="terminal" class="terminal-mount"></div><div id="toast" hidden></div>';
      api.sessions.attach = async () => ({ data: '\\x1b[?1049h\\x1b[H> 未发送草稿', sequence: 0 });
      api.events.output = () => () => {};
      window.resizes = [];
      api.sessions.resize = async (...args) => { window.resizes.push(args.slice(-2)); };
      api.sessions.composer = async () => {};
      window.view = mountTerminal(document.querySelector('#terminal'), {
        session: { id: 'existing', pluginId: 'ai-agent-sessions', cwd: '/project' }, protocol: 'codex' });
      window.view.fit();
      window.settings = mountSettings(document.querySelector('#settings-root'));
      await window.settings.ready;
      window.ready = true;
    `,
    conversation: `
      import './desk/src/resource/controls.css';
      import './plugin-dev/ai-agent/src/renderer/conversation.css';
      ${bridge}
      document.body.innerHTML = '<main><div id="transcript"><article class="message user">结构化会话正文</article><article class="message tool">工具输出内容</article><article class="message mcp-elicitation"><textarea aria-label="工具表单">保留的工具回答</textarea></article></div><div id="composer"><textarea aria-label="消息">未发送消息</textarea></div></main>';
      window.ready = true;
    `
  })) {
    await build({ stdin: { contents: source, resolveDir: repository, sourcefile: `appearance-${name}.js` }, bundle: true,
      format: 'esm', outfile: join(fixture, `${name}.js`), loader: { '.html': 'text' } });
  }
  await writeFile(join(fixture, 'index.html'), `<!doctype html><meta charset="UTF-8"><script>
    const name = location.search.includes('conversation') ? 'conversation' : 'workspace';
    document.write('<link rel="stylesheet" href="'+name+'.css"><script type="module" src="'+name+'.js"><'+'/script>');
    </script><style>body{padding:12px}#settings-root{height:auto;padding:0;margin:0 0 12px}.session-groups{position:static;width:100%;padding:0;background:transparent;border:0}.session-concise{position:static;padding:12px}.connection-draft{margin:12px 0}#terminal{height:200px}</style>`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), env,
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`] });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready);
  await page.getByRole('button', { name: '显示', exact: true }).click();
  const select = page.getByRole('combobox', { name: '会话字号', exact: true });
  assert.equal(await select.inputValue(), '14');
  const initialCols = await page.evaluate(() => window.view.terminal.cols);
  const secondWindow = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, fixture) => {
    const window = new BrowserWindow({ width: 420, height: 600, webPreferences: { sandbox: true } });
    window.loadFile(`${fixture}/index.html`, { query: { view: 'conversation' } });
  }, fixture);
  const conversation = await secondWindow;
  await conversation.waitForFunction(() => window.ready);
  await select.selectOption('18');
  assert.equal(await select.isDisabled(), true, 'saving disables repeated changes');
  await page.waitForFunction(() => window.view.terminal.options.fontSize === 18);
  await conversation.waitForFunction(() => getComputedStyle(document.querySelector('.message.user')).fontSize === '18px');
  assert.equal(await conversation.locator('.message.tool').evaluate(node => getComputedStyle(node).fontSize), '18px');
  await conversation.waitForFunction(() => getComputedStyle(document.querySelector('textarea')).fontSize === '18px');
  assert.equal(await conversation.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '未发送消息');
  for (const selector of ['.group-choice', '.group-member', '.session-concise-body', '.connection-draft textarea', '.question-popup textarea']) {
    await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).fontSize === '18px', selector);
    assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).fontSize), '18px', selector);
  }
  assert.equal(await page.evaluate(cols => window.view.terminal.cols < cols, initialCols), true);
  assert.equal(await page.evaluate(() => window.resizes.length > 1), true, 'font changes resize the PTY');
  assert.match(await page.evaluate(() => window.view.terminal.buffer.active.getLine(0).translateToString(true)), /未发送草稿/);
  assert.equal(await page.getByRole('textbox', { name: '会话草稿' }).inputValue(), '保留的草稿');
  await page.reload();
  await page.waitForFunction(() => window.ready && window.view.terminal.options.fontSize === 18);
  await page.getByRole('button', { name: '显示', exact: true }).click();
  assert.equal(await select.inputValue(), '18');
  await page.evaluate(() => { window.failSave = true; });
  await select.selectOption('20');
  await page.waitForFunction(() => document.querySelector('#notice').textContent === '保存字号失败');
  assert.equal(await select.inputValue(), '18');
  assert.equal(await page.evaluate(() => window.view.terminal.options.fontSize), 18);
  await page.evaluate(() => { window.failSave = false; });
  const screenshots = join(repository, 'plugin-dev/dist/verification/agent-font-size');
  await mkdir(screenshots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.bringToFront();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.view.setTheme(theme); }, theme);
    await select.focus();
    for (const size of [10, 24]) {
      await select.selectOption(String(size));
      await page.waitForFunction(size => window.view.terminal.options.fontSize === size, size);
    }
    // Resize the native window so Electron keeps the screen's real pixel ratio for the WebGL terminal.
    const nativeWindow = await app.browserWindow(page);
    await nativeWindow.evaluate(window => window.setContentSize(360, 800));
    await page.waitForFunction(() => innerWidth === 360);
    await page.waitForFunction(() => document.querySelector('.xterm-screen').getBoundingClientRect().width / window.view.terminal.cols > 13);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await select.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const label = document.querySelector('label[for="conversation-font-size"]').getBoundingClientRect();
      return bounds.right <= innerWidth && bounds.left > label.right && document.activeElement === node;
    }), true, 'select stays on the right and keyboard focus survives saving in a narrow view');
    for (const [surface, selector] of [[page, '.connection-draft textarea'], [page, '.question-popup textarea'],
      [conversation, '#composer textarea'], [conversation, '.mcp-elicitation textarea']]) {
      const input = surface.locator(selector);
      await input.fill('第一行内容\n第二行内容');
      await input.focus();
      await surface.waitForFunction(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return Number.parseFloat(style.lineHeight) > Number.parseFloat(style.fontSize);
      }, selector);
      await input.fill('一段自动换行的输入内容LongUnbrokenInput'.repeat(12));
      assert.equal(await input.evaluate(node => node.scrollWidth <= node.clientWidth
        && node.scrollHeight > Number.parseFloat(getComputedStyle(node).lineHeight) * 2), true, 'long input wraps vertically');
      await input.fill('第一行内容\n第二行内容');
      await input.evaluate(node => { node.disabled = true; });
      assert.equal(await input.isDisabled(), true);
      await input.evaluate(node => { node.disabled = false; });
    }
    await select.focus();
    await page.screenshot({ path: join(screenshots, `workspace-${theme}-24px.png`) });
    await conversation.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await conversation.bringToFront();
    await conversation.waitForFunction(theme => getComputedStyle(document.querySelector('#composer textarea')).backgroundColor
      === (theme === 'dark' ? 'rgb(39, 40, 43)' : 'rgb(244, 245, 246)'), theme);
    await conversation.screenshot({ path: join(screenshots, `conversation-${theme}-24px.png`) });
  }
});
