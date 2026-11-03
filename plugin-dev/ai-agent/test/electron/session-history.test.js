import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));

test('history restores all sequentially, keeps failures retryable and shows empty state', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-history-ui-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import { api } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { showHistory } from './plugin-dev/ai-agent/src/renderer/history.js';
    window.postMessage = () => {};
    const records = ['one', 'two', 'three'].map(id => ({ id, name: id, cwd: '/project', adapterId: 'codex',
      contextId: id, coordinator: id === 'one', groupId: id === 'three' ? undefined : 'team', closedAt: new Date().toISOString() }));
    window.calls = []; window.focused = []; window.running = 0; window.maximum = 0; window.fail = true; window.release = null; window.busy = true;
    api.sessions.list = async () => ({ archives: records, groups: [{ id: 'team', name: '归档工作组', archivedAt: '2026-11-01' }] });
    window.directoryUpdates = [];
    api.host.chooseDirectory = async () => '/moved/project';
    api.sessions.updateArchiveDirectory = async (plugin, id, cwd) => {
      window.directoryUpdates.push({ plugin, id, cwd });
      const record = records.find(record => record.id === id);
      record.cwd = cwd;
      return record;
    };
    api.sessions.restore = async (plugin, id, windowId) => {
      window.calls.push({ id, windowId }); window.running++; window.maximum = Math.max(window.maximum, window.running);
      if (id === 'one' && window.busy) { window.busy = false; window.running--; throw Object.assign(Error('插件正在创建任务'), { code: 'PLUGIN_BUSY' }); }
      if (id === 'one') { await new Promise(resolve => { window.release = resolve; }); }
      await new Promise(resolve => setTimeout(resolve, 40)); window.running--;
      if (id === 'two' && window.fail) { throw Error('test engine unavailable'); }
      records.splice(records.findIndex(record => record.id === id), 1);
      return { id: 'restored-' + id };
    };
    window.openHistory = () => showHistory('one', [{ id: 'codex', capabilities: { restore: true } }],
      async id => window.focused.push(id), 'target-window');
    window.openHistory();`, resolveDir: repository }, bundle: true, format: 'esm', loader: { '.html': 'text' },
    outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<html data-theme="dark"><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><button id="outside">外部操作</button><div id="toast" hidden></div><script type="module" src="app.js"></script></html>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const restore = page.getByRole('button', { name: '恢复全部历史会话', exact: true });
  assert.equal(await page.locator('.history-group').count(), 2);
  const team = page.locator('.history-group').filter({ has: page.getByText('归档工作组', { exact: true }) });
  assert.equal(await team.locator('.history-row').count(), 2);
  await team.getByRole('button', { name: '收起归档工作组归档会话', exact: true }).click();
  assert.equal(await team.locator('.history-row').first().isVisible(), false);
  await team.getByRole('button', { name: '展开归档工作组归档会话', exact: true }).click();
  const edit = team.getByRole('button', { name: '修改工作目录', exact: true }).first();
  assert.equal(await edit.isEnabled(), true, 'fixed group administrator can relocate its directory');
  await edit.click();
  let editor = page.locator('dialog').filter({ has: page.getByRole('heading', { name: '修改工作目录', exact: true }) });
  await editor.getByRole('textbox', { name: '工作目录', exact: true }).fill('/cancelled');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.directoryUpdates), []);
  await edit.click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForFunction(() => {
      const node = [...document.querySelectorAll('dialog')].at(-1);
      const box = node.getBoundingClientRect();
      return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 2
        && Math.abs(box.y + box.height / 2 - innerHeight / 2) < 2;
    });
  }
  await editor.getByRole('button', { name: '选择工作目录', exact: true }).click();
  assert.equal(await editor.getByRole('textbox', { name: '工作目录', exact: true }).inputValue(), '/moved/project');
  await editor.getByRole('button', { name: '保存工作目录', exact: true }).click();
  await page.waitForFunction(() => window.directoryUpdates.length === 1);
  assert.deepEqual(await page.evaluate(() => window.directoryUpdates), [{ plugin: 'one', id: 'one', cwd: '/moved/project' }]);
  assert.ok((await team.locator('.history-row').first().textContent()).includes('/moved/project'));
  await restore.click({ timeout: 3000 });
  await page.waitForFunction(() => window.release !== null);
  assert.equal(await page.locator('.history-dialog').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('.restore-progress [role="progressbar"]').getAttribute('aria-valuenow'), '0');
  assert.equal(await page.locator('.restore-count').textContent(), '0 / 3');
  assert.equal(await page.locator('.restore-current').textContent(), '正在恢复「one」');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const surface = await page.locator('.restore-progress').evaluate(node => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderWidth, shadow: style.boxShadow };
    });
    assert.deepEqual(surface, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' });
    assert.equal(await page.locator('.restore-progress').evaluate(node => getComputedStyle(node, '::backdrop').backgroundColor),
      theme === 'light' ? 'rgb(247, 247, 247)' : 'rgb(24, 24, 24)');
    const bounds = await page.locator('.restore-progress').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) < 2);
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2);
    await page.screenshot({ path: `/tmp/agent-restore-${theme}.png` });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(360, 520));
  await page.waitForFunction(() => {
    const bounds = document.querySelector('.restore-progress').getBoundingClientRect();
    return innerWidth === 360 && bounds.left >= 0 && bounds.right <= innerWidth
      && Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2) < 2;
  });
  assert.equal(await page.getByRole('button', { name: '关闭', exact: true }).first().isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.mouse.click(2, 2);
  assert.equal(await page.locator('.history-dialog').isVisible(), true);
  assert.equal(await page.locator('#outside').evaluate(node => node.inert), true);
  await page.evaluate(() => window.release());
  await page.waitForFunction(() => document.querySelector('.history-dialog').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('.history-dialog').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#outside').evaluate(node => node.inert), false);
  await page.getByText('test engine unavailable', { exact: false }).waitFor();
  assert.equal(await page.locator('.history-row').count(), 1);
  assert.equal(await page.evaluate(() => window.maximum), 1);
  assert.deepEqual(await page.evaluate(() => window.focused), [], 'bulk restore preserves the saved collapsed and maximized state');
  assert.ok(await page.evaluate(() => window.calls.every(call => call.windowId === 'target-window')));
  await page.evaluate(() => { window.fail = false; });
  await team.getByRole('button', { name: '恢复归档工作组全部会话', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.restore-percent')?.textContent === '100');
  assert.equal(await page.locator('#outside').evaluate(node => node.inert), true);
  await page.getByText('还没有归档会话。关闭的会话会保存在这里。', { exact: true }).waitFor();
  assert.equal(await restore.isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.calls.map(call => call.id)), ['one', 'one', 'two', 'three', 'two']);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForFunction(() => {
      const bounds = document.querySelector('.history-dialog').getBoundingClientRect();
      return Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2) < 2;
    });
    const bounds = await page.locator('dialog').boundingBox();
    const viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) < 2);
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2);
  }
});
