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

test('native composers accept direct input while preserving placeholders and model navigation', { timeout: 45000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-input-mode-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import '@xterm/xterm/css/xterm.css';
    import { api } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountTerminal } from './plugin-dev/ai-agent/src/renderer/terminal.js';
    window.postMessage = () => {};
    window.writes = [];
    window.reports = [];
    let output;
    let sequence = 0;
    api.events.output = callback => { output = callback; return () => {}; };
    api.sessions.attach = async () => ({ data: '\\x1b[?1049h', sequence: 0 });
    api.sessions.resize = async (plugin, id, cols, rows) => { window.fill?.(rows); };
    api.sessions.write = async (plugin, id, data) => { window.writes.push(data); };
    api.sessions.fileReferences = async (plugin, id, paths) => paths.map(path => ({ path, name: path.split('/').at(-1) }));
    api.sessions.composer = async (plugin, id, report) => { window.reports.push(report); };
    window.view = mountTerminal(document.querySelector('main'), {
      session: { id: 'member', pluginId: 'ai-agent-sessions', adapterId: 'codex', cwd: '/project' }, protocol: 'codex', onModel: value => { window.model = value; document.querySelector('.session-model').textContent = value; }
    });
    document.querySelector('.session-model').onclick = event => window.view.switchModel(event.currentTarget);
    window.paint = data => { output({ pluginId: 'ai-agent-sessions', sessionId: 'member', sequence: ++sequence, data }); return sequence; };
    window.paintComposer = () => window.paint('\\x1b[2J\\x1b[HCONTENT RETAINED\\x1b[5;1H> \\x1b[48;2;66;68;72m\\x1b[2mAsk Codex to do anything\\x1b[0m\\x1b[7;1HGPT-model · /project\\x1b[5;3H');
    window.view.fit();
    window.ready = true;
  `, resolveDir: repository, sourcefile: 'input-mode-fixture.js' }, bundle: true, format: 'esm', outfile: join(fixture, 'app.js') });
  const header = '<div class="session-header"><div class="session-caption"><strong class="session-name">测试会话</strong></div><span class="session-status"></span><div class="session-header-details"><button type="button" class="session-model" aria-label="切换模型"></button><div class="card-actions">'
    + Array.from({ length: 6 }, () => '<button class="icon icon-button" aria-label="测试操作"><svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 12h16"/></svg></button>').join('') + '</div></div></div>';
  await writeFile(join(fixture, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><style>body{width:600px}.session-header{height:34px}main{width:100%;height:300px;display:flex;flex-direction:column}</style>' + header + '<main></main><div id="toast" hidden></div><script type="module" src="app.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), env,
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`] });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready && window.reports.length);
  const firstSequence = await page.evaluate(() => window.paintComposer());
  await page.waitForFunction(sequence => window.reports.at(-1).sequence === sequence && window.reports.at(-1).nativeEmpty === true, firstSequence);
  await page.waitForFunction(() => window.model === 'GPT-model');
  assert.equal(await page.locator('.terminal-input-cursor').isVisible(), false, 'ordinary input uses only the native caret');
  assert.equal(await page.evaluate(() => window.view.terminal.options.cursorBlink), true);
  await page.evaluate(() => window.paint('\x1b[7;1H\x1b[2KGPT-6.1-Sol high · /project\x1b[5;3H'));
  await page.waitForFunction(() => window.model === 'GPT-6.1-Sol high');
  await page.locator('.terminal-metadata-mask').waitFor({ state: 'visible' });
  assert.match(await page.evaluate(() => window.view.terminal.buffer.active.getLine(6).translateToString(true)), /GPT-6.1-Sol high/);
  assert.equal(await page.locator('.xterm-helper-textarea').evaluate(node => node.readOnly), false);
  assert.equal(await page.locator('.terminal-input-mask').count(), 0);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('direct input');
  await page.keyboard.press('Shift+Enter');
  await page.waitForFunction(() => window.writes.join('') === 'direct input\x1b[13;2u');
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '/tmp/member.md');
    document.querySelector('main').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.getByRole('list', { name: '待发送的文件引用' }).waitFor({ state: 'visible' });
  await page.evaluate(() => { window.writes = []; window.view.clear(); window.view.newline(); });
  await page.waitForFunction(() => window.writes.join('') === '\x1b[200~ \x1b[201~\x03\x1b[13;2u');
  await page.getByRole('list', { name: '待发送的文件引用' }).waitFor({ state: 'hidden' });
  await page.evaluate(() => window.paint('\x1b[6n'));
  await page.waitForFunction(() => window.writes.some(data => /\x1b\[\d+;\d+R/.test(data)));
  assert.equal(await page.evaluate(() => window.reports.at(-1).nativeEmpty), true);
  assert.match(await page.evaluate(() => window.view.terminal.buffer.active.getLine(0).translateToString(true)), /CONTENT RETAINED/);
  await page.evaluate(() => window.view.setInputMode({ placeholder: '输入团队任务…' }));
  const hint = page.locator('.terminal-input-hint');
  await hint.waitFor({ state: 'visible' });
  assert.equal(await hint.textContent(), '输入团队任务…');
  await page.locator('.terminal-input-cursor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.terminal-input-cursor').evaluate(node => {
    const hint = document.querySelector('.terminal-input-hint');
    return node.getBoundingClientRect().left === hint.getBoundingClientRect().left
      && Number(getComputedStyle(node).zIndex) > Number(getComputedStyle(hint).zIndex)
      && parseFloat(getComputedStyle(hint).paddingLeft) >= 6
      && getComputedStyle(node).animationName !== 'none'
      && node.getBoundingClientRect().width >= 2;
  }), true, 'caret stays visible above the leader placeholder at the native input position');
  await page.evaluate(() => { window.writes = []; });
  await page.getByRole('button', { name: '切换模型' }).click();
  await page.waitForFunction(() => window.writes.join('').includes('/model\r'));
  await page.evaluate(() => window.paint('\x1b[2J\x1b[HSelect Model and Effort\x1b[3;1H› 1. Model A (current)  First model\x1b[4;1H  2. Model B  Second model'));
  await page.locator('.terminal-input-cursor').waitFor({ state: 'hidden' });
  const picker = page.getByRole('menu', { name: '切换模型' });
  await picker.waitFor({ state: 'visible' });
  assert.equal(await picker.evaluate(node => Math.abs(node.getBoundingClientRect().top
    - document.querySelector('.session-model').getBoundingClientRect().top) < 2), true, 'model menu stays beside its title trigger');
  const screenshots = join(repository, '.test-results');
  await mkdir(screenshots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.view.setTheme(theme); }, theme);
    await page.screenshot({ path: join(screenshots, `session-model-menu-${theme}.png`) });
  }
  await picker.getByRole('menuitem', { name: /Model B/ }).click();
  await page.waitForFunction(() => window.writes.join('').includes('\x1b[B\r'));
  await page.evaluate(() => window.paint('\x1b[2J\x1b[HSelect Reasoning Level for Model B\x1b[3;1H  1. Low  Fast\x1b[4;1H› 2. Medium (current)  Balanced'));
  await picker.getByRole('menuitem', { name: /Low/ }).click();
  await page.waitForFunction(() => window.writes.join('').includes('\x1b[A\r'));
  await page.evaluate(() => window.paintComposer());
  await hint.waitFor({ state: 'visible' });
  await page.evaluate(() => window.paint('\x1b[5;1H\x1b[2K> draft\x1b[5;8H'));
  await hint.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.terminal-input-cursor').isVisible(), false,
    'typed drafts use the native cursor without a second overlay caret');
  await page.evaluate(() => { window.writes = []; });
  await page.getByRole('button', { name: '切换模型' }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.writes), [], 'model command preserves unsent drafts');
  await page.evaluate(() => window.paintComposer());
  await hint.waitFor({ state: 'visible' });
  const covered = await hint.evaluate(node => {
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    return Math.abs(node.getBoundingClientRect().right - screen.right) < 2;
  });
  assert.equal(covered, true, 'leader hint covers the full original placeholder');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.view.setTheme(theme); }, theme);
    assert.equal(await page.evaluate(() => window.view.terminal.buffer.active.getLine(4).getCell(4).getBgColor()), 255);
    assert.equal(await page.evaluate(() => window.view.terminal.options.theme.extendedAnsi[239]), theme === 'light' ? '#f5f5f5' : '#30343c');
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.terminal-input-hint')).backgroundColor === color,
      theme === 'light' ? 'rgb(245, 245, 245)' : 'rgb(48, 52, 60)');
    assert.equal(await hint.evaluate(node => getComputedStyle(node).backgroundColor),
      theme === 'light' ? 'rgb(245, 245, 245)' : 'rgb(48, 52, 60)', 'leader hint keeps the native composer surface continuous');
    assert.equal(await page.locator('.terminal-input-cursor').evaluate(node => getComputedStyle(node).backgroundColor),
      theme === 'light' ? 'rgb(105, 80, 185)' : 'rgb(196, 181, 253)');
    await page.screenshot({ path: join(screenshots, `session-leader-input-${theme}.png`) });
    await page.evaluate(() => { window.paint('\x1b[5;1H\x1b[2K> 将发送报告改为发送飞书的机器人通知，\x1b[?25h'); window.view.focus(); });
    await hint.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.terminal-input-cursor').isVisible(), false, 'Chinese drafts keep only the native caret');
    await page.screenshot({ path: join(screenshots, `session-single-cursor-${theme}.png`) });
    await page.evaluate(() => window.paintComposer());
    await hint.waitFor({ state: 'visible' });
  }
  await page.evaluate(() => { window.writes = []; window.view.switchModel(document.querySelector('.session-model')); });
  await page.waitForFunction(() => window.writes.join('').includes('/model\r'));
  await page.evaluate(() => window.paint('\x1b[2J\x1b[HSelect Model and Effort\x1b[3;1H› 1. Model A (current)  First model'));
  await page.keyboard.type('unwanted');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.writes.includes('\x1b'));
  assert.equal(await page.evaluate(() => window.writes.join('').includes('unwanted')), false, 'model navigation cannot submit task text');
  await page.evaluate(() => window.paintComposer());
  await page.waitForFunction(() => !document.querySelector('.xterm-helper-textarea').readOnly);
  await page.evaluate(() => { window.view.setInputMode({}); document.body.style.width = '400px'; });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.session-header-details').evaluate(node => {
    const model = node.querySelector('.session-model').getBoundingClientRect();
    const actions = node.querySelector('.card-actions').getBoundingClientRect();
    return model.right <= actions.left && actions.right <= node.getBoundingClientRect().right + 1;
  }), true, 'model truncates before the header action buttons in narrow windows');
  const resizedSequence = await page.evaluate(() => window.paintComposer());
  await page.waitForFunction(sequence => window.reports.at(-1).sequence === sequence && window.reports.at(-1).nativeEmpty === true, resizedSequence);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.view.terminal.buffer.active.cursorY), 4);
  await page.screenshot({ path: join(screenshots, 'session-member-input-dark.png') });
  await page.evaluate(() => window.paint('\x1b[2J\x1b[HRunning task'));
  await page.evaluate(() => { window.writes = []; window.view.setInputMode({}); window.view.focus(); });
  await page.keyboard.type('allowed');
  await page.waitForFunction(() => window.writes.join('') === 'allowed');
  // Cached native palettes must change the painted canvas too, without a placeholder overlay or a native redraw.
  for (const shade of ['249;249;249', '67;69;73']) {
    const sequence = await page.evaluate(shade => window.paint(`\x1b[48;2;${shade}m\x1b[4;1H\x1b[2K\x1b[5;1H\x1b[2K> draft\x1b[6;1H\x1b[2K\x1b[0m\x1b[5;8H`), shade);
    await page.waitForFunction(sequence => window.reports.at(-1).sequence === sequence, sequence);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.view.setTheme(theme); }, theme);
      assert.equal(await hint.isVisible(), false);
      assert.equal(await page.evaluate(() => window.view.terminal.buffer.active.getLine(4).getCell(4).getBgColor()), 255);
      const point = await page.locator('.xterm-screen').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return { x: Math.floor(bounds.left + bounds.width / 2), y: Math.floor(bounds.top + bounds.height * 3.5 / window.view.terminal.rows) };
      });
      await page.waitForTimeout(100);
      const pixel = await app.evaluate(async ({ BrowserWindow }, point) => {
        const bitmap = (await BrowserWindow.getAllWindows()[0].webContents.capturePage({ ...point, width: 1, height: 1 })).toBitmap();
        return [bitmap[2], bitmap[1], bitmap[0]];
      }, point);
      assert.deepEqual(pixel, theme === 'dark' ? [48, 52, 60] : [245, 245, 245], `${shade} paints the ${theme} composer surface`);
      await page.screenshot({ path: join(screenshots, `session-native-surface-${shade.replaceAll(';', '-')}-${theme}.png`) });
    }
  }
  const normalRows = await page.evaluate(() => {
    const rows = window.view.terminal.rows;
    window.fill = rows => window.paint(`\x1b[2J\x1b[HCONTENT RETAINED\x1b[${rows - 6};1HLAST OUTPUT\x1b[${rows - 4};1H> \x1b[2mAsk Codex to do anything\x1b[0m\x1b[${rows - 1};1HGPT-model · /project\x1b[${rows - 4};3H`);
    window.fill(rows);
    return rows;
  });
  await page.waitForFunction(() => window.reports.at(-1).nativeEmpty === true);
  assert.equal(await page.evaluate(() => window.view.terminal.rows), normalRows);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; window.view.setTheme(theme); }, theme);
    await page.screenshot({ path: join(screenshots, `session-member-input-${theme}.png`) });
  }
  // A native history/working redraw can occupy the entire PTY and omit the composer.
  await page.evaluate(() => {
    window.fill = rows => window.paint(`\x1b[2J\x1b[HOUTPUT HISTORY\x1b[${rows};1HLAST OUTPUT ROW`);
    window.fill(window.view.terminal.rows);
  });
  await page.waitForFunction(rows => window.view.terminal.rows === rows, normalRows, { timeout: 3000 });
  assert.equal(await page.locator('.xterm-screen').evaluate(node => {
    const viewport = document.querySelector('.terminal-screen').getBoundingClientRect();
    return node.getBoundingClientRect().bottom <= viewport.bottom + 1;
  }), true, 'the final output row stays above the session footer when the native composer is absent');
  await page.waitForFunction(() => window.view.terminal.buffer.active.getLine(window.view.terminal.rows - 1).translateToString(true).includes('LAST OUTPUT ROW'), null, {timeout:2000});
  await page.evaluate(() => window.view.setInputMode({}));
  await page.waitForFunction(rows => window.view.terminal.rows === rows, normalRows);

});
