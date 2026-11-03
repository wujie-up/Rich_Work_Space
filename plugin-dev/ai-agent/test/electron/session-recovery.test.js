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

test('nine windows recover sequentially without terminal replay competing with startup', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-recovery-ui-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import './desk/src/resource/controls.css';
    import '@xterm/xterm/css/xterm.css';
    import './plugin-dev/ai-agent/src/renderer/workspace.css';
    import './plugin-dev/ai-agent/src/renderer/session-groups.css';
    import './plugin-dev/ai-agent/src/renderer/session-status.css';
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    import { mountWorkspace } from './plugin-dev/ai-agent/src/renderer/workspace.js';
    window.postMessage = () => {};
    const records = Array.from({ length: 9 }, (_, index) => ({ id: 's' + index, name: '窗口' + index,
      pluginId: 'one', adapterId: 'codex', cwd: '/project', groupId: 'group', windowId: 'host', sequence: 0 }));
    const state = { groups: [{ id: 'group', name: '测试组' }], sessions: [], archives: records };
    const listeners = new Set();
    window.calls = []; window.attached = 0;
    api.host.getWindowContext = async () => ({ id: 'host' });
    api.host.listWindows = async () => [];
    conversationApi.call = async () => {};
    api.storage.getLayout = async () => ({});
    api.storage.saveLayout = async () => {};
    api.storage.getAdapterConfig = async () => ({});
    api.sessions.recover = async (_, windowId) => {
      records.forEach(record => { record.windowId = windowId; });
      return { windowId, sessions: [], archives: records };
    };
    api.sessions.list = async () => state;
    api.sessions.restore = async (_, id) => {
      if (state.sessions.some(session => session.activity === 'unknown')) { throw Error('overlapping startup'); }
      window.calls.push(id);
      const restored = { ...records.find(record => record.id === id), protocol: 'managed-terminal', activity: 'unknown' };
      state.sessions.push(restored);
      listeners.forEach(callback => callback(state));
      return restored;
    };
    window.release = () => { state.sessions.at(-1).activity = 'idle'; };
    api.sessions.attach = async () => { window.attached++; return { sequence: 0, data: '› Ask Codex to do anything' }; };
    api.sessions.resize = api.sessions.composer = async () => {};
    api.events.output = () => () => {};
    api.events.sessionsChanged = callback => { listeners.add(callback); return () => listeners.delete(callback); };
    window.mount = mountWorkspace(document.querySelector('main'), { pluginId: 'one', adapters: [{ id: 'codex', name: 'Codex',
      capabilities: { inputProtocol: 'codex' }, permissionModes: [] }] }).then(() => { window.ready = true; });
  `, resolveDir: repository }, bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><html data-theme="dark"><meta charset="UTF-8"><link rel="stylesheet" href="app.css"><main id="workspace"></main><div id="toast" hidden></div><script type="module" src="app.js"></script></html>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.setDefaultTimeout(5000);
  for (let count = 1; count <= 9; count++) {
    await page.waitForFunction(count => window.calls?.length === count, count);
    assert.equal(await page.evaluate(() => window.attached), 0);
    assert.equal(await page.locator('.xterm').count(), 0);
    assert.equal(await page.locator('#workspace').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.page-heading').evaluate(node => node.inert), true);
    await page.evaluate(() => window.release());
  }
  await page.waitForFunction(() => window.ready);
  await page.waitForFunction(() => window.attached === 9);
  assert.deepEqual(await page.evaluate(() => window.calls), Array.from({ length: 9 }, (_, index) => 's' + index));
  assert.equal(await page.locator('#workspace').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('.page-heading').evaluate(node => node.inert), false);
  assert.equal(await page.locator('.xterm').count(), 9);
  assert.equal(await page.locator('.group-member.active').count(), 0);
  assert.deepEqual(errors, []);
});
