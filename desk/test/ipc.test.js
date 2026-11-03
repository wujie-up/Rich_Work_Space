import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../src/main/common/storage.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers, dispatch } from '../src/main/common/ipc.js';

test('plugin scan IPC persists only its directory and defaults to no scan', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-update-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  const handlers = createHandlers({ storage, plugins: { list: () => [] } });
  assert.deepEqual(await handlers['plugins.checkUpdates'](), { directory: '', updates: [], errors: [] });
  await storage.writeJson('preferences.json', { theme: 'dark', retained: 'history' });
  await handlers['plugins.configureUpdates'](root);
  await handlers['plugins.configureUpdates'](join(root, 'not-created'));
  assert.deepEqual(await handlers['plugins.checkUpdates'](), { directory: join(root, 'not-created'), updates: [], errors: [] });
  await handlers['plugins.configureUpdates'](root);
  assert.deepEqual(await storage.readJson('preferences.json'), { theme: 'dark', retained: 'history', pluginPackageDirectory: root });
  await assert.rejects(handlers['plugins.configureUpdates']('relative/path'), { code: 'INVALID_ARGUMENT' });
});

test('plugin package scans run only through an explicit list check', async () => {
  let scans = 0;
  const snapshot = { directory: '/packages', updates: [], errors: [] };
  const handlers = createHandlers({ updates: {
    snapshot: async () => snapshot,
    scan: async () => { scans++; return snapshot; }
  } });
  await handlers['plugins.checkUpdates']();
  assert.equal(scans, 0);
  assert.deepEqual(await handlers['plugins.scanUpdates'](), snapshot);
  assert.equal(scans, 1);
  await handlers['plugins.checkUpdates']();
  assert.equal(scans, 1);
});

test('IPC rejects foreign sender, child frame and unknown method before calling handler', async () => {
  const frame = { url: 'file:///test/index.html' };
  const sender = { mainFrame: frame };
  const handlers = { 'plugins.list': () => ['safe'] };
  assert.deepEqual(await dispatch({ sender, senderFrame: frame }, sender, handlers, 'plugins.list', []), { ok: true, value: ['safe'] });
  assert.equal((await dispatch({ sender: {}, senderFrame: frame }, sender, handlers, 'plugins.list', [])).ok, false);
  assert.equal((await dispatch({ sender, senderFrame: {} }, sender, handlers, 'plugins.list', [])).ok, false);
  assert.equal((await dispatch({ sender, senderFrame: frame }, sender, handlers, '__proto__', [])).ok, false);
});


test('desktop preferences retain existing values while updating grid, icon size and theme', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'desk-preferences-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  await storage.writeJson('preferences.json', { theme: 'light', retained: 'existing' });
  const handlers = createHandlers({ storage });
  await handlers['storage.savePreferences']({ theme: 'light', gridSize: 32, shelfIconSize: 48 });
  await handlers['storage.savePreferences']({ theme: 'dark' });
  assert.deepEqual(await handlers['storage.getPreferences'](), { theme: 'dark', themePreferenceVersion: 1, retained: 'existing', gridSize: 32, shelfIconSize: 48 });
  await assert.rejects(async () => handlers['storage.savePreferences']({ theme: 'dark', gridSize: 0 }), /网格/);
  await assert.rejects(async () => handlers['storage.savePreferences']({ theme: 'dark', shelfIconSize: 64 }), /图标/);
});

test('theme preferences default to system and can return to system after a manual override', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'desk-system-theme-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  const handlers = createHandlers({ storage });
  assert.equal((await handlers['storage.getPreferences']()).theme, 'system');
  await storage.writeJson('preferences.json', { theme: 'light', gridSize: 32, retained: 'history' });
  assert.equal((await handlers['storage.getPreferences']()).theme, 'system');
  await handlers['storage.savePreferences']({ theme: 'light' });
  assert.equal((await handlers['storage.getPreferences']()).theme, 'light');
  await handlers['storage.savePreferences']({ theme: 'system' });
  assert.equal((await handlers['storage.getPreferences']()).theme, 'system');
});

test('desktop language is validated and retained when other preferences change', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'desk-language-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  const handlers = createHandlers({ storage });
  await storage.writeJson('preferences.json', { theme: 'system', retained: 'history' });
  await handlers['storage.savePreferences']({ theme: 'system', language: 'en' });
  await handlers['storage.savePreferences']({ theme: 'dark', gridSize: 32 });
  assert.equal((await handlers['storage.getPreferences']()).language, 'en');
  assert.equal((await handlers['storage.getPreferences']()).retained, 'history');
  await assert.rejects(() => handlers['storage.savePreferences']({ theme: 'dark', language: 'invalid' }), /语言/);
  assert.equal((await handlers['storage.getPreferences']()).language, 'en');
  await handlers['storage.savePreferences']({ theme: 'dark', language: 'zh-CN' });
  assert.equal((await handlers['storage.getPreferences']()).language, 'zh-CN');
});

test('external browser route accepts only credential-free web URLs', async () => {
  const opened = [];
  const handlers = createHandlers({ openExternal: async url => opened.push(url) });
  await handlers['host.openExternal']('https://auth.openai.com/authorize?state=test');
  assert.equal(opened.length, 1);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com']) {
    await assert.rejects(async () => handlers['host.openExternal'](url));
  }
});

test('clipboard file lookup returns original paths without importing them into the desktop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-clipboard-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new Storage(root);
  const handlers = createHandlers({ storage, fileClipboard: { read: async () => ['/external/需求 v2.txt', '/external/API.md'] } });
  assert.deepEqual(await handlers['host.readClipboardFiles'](), ['/external/需求 v2.txt', '/external/API.md']);
  assert.deepEqual(await handlers['desktop.list'](), []);
});

test('clipboard read failures return a failure instead of pretending there are no files', async t => {
  t.mock.method(console, 'error', () => {});
  const handlers = createHandlers({ fileClipboard: { read: async () => { throw Error('clipboard unavailable'); } } });
  const sender = { mainFrame: {} };
  const result = await dispatch({ sender, senderFrame: sender.mainFrame }, sender, handlers, 'host.readClipboardFiles', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CLIPBOARD_READ_FAILED');
});

test('removed development IPC methods remain unavailable', async () => {
  const sender = { mainFrame: {} };
  const handlers = createHandlers({});
  assert.equal(Object.keys(handlers).some(method => method.startsWith('development.')), false);
  const result = await dispatch({ sender, senderFrame: sender.mainFrame }, sender, handlers, 'development.create', []);
  assert.equal(result.error.code, 'IPC_FORBIDDEN');
});


test('plugin multi-import continues after a failed package and reports its name', async () => {
  const installed = [];
  const handlers = createHandlers({ selectPackage: async () => ['/tmp/first.plg', '/tmp/broken.plg', '/tmp/last.plg'],
    plugins: { install: async path => {
      installed.push(path);
      if (path.endsWith('broken.plg')) {
        throw Error('invalid archive');
      }
    } } });
  await assert.rejects(handlers['plugins.install'](), /broken.plg: invalid archive/);
  assert.deepEqual(installed, ['/tmp/first.plg', '/tmp/broken.plg', '/tmp/last.plg']);
});

test('plugin multi-import cancellation does not install anything', async () => {
  const handlers = createHandlers({ selectPackage: async () => [], plugins: { install: () => assert.fail('canceled') } });
  await handlers['plugins.install']();
});

 test('directory picker forwards the supplied starting directory and preserves no-argument use', async () => {
  const calls = [];
  const handlers = createHandlers({ selectDirectory: async (...args) => { calls.push(args); return '/tmp/chosen'; } });
  assert.equal(await handlers['host.chooseDirectory']({ defaultPath: '/tmp/current' }), '/tmp/chosen');
  await handlers['host.chooseDirectory']();
  assert.deepEqual(calls, [['选择工作目录', '/tmp/current', false], ['选择工作目录', undefined, false]]);
});

test('file picker validates the opt-in hidden-file option without changing existing calls', async () => {
  const calls = [];
  const handlers = createHandlers({ selectFile: async options => { calls.push(options); return '/tmp/.hidden/API.md'; } });
  const options = { title: '打开文本文件', extensions: [], showHiddenFiles: true };
  assert.equal(await handlers['host.chooseFile'](options), '/tmp/.hidden/API.md');
  await handlers['host.chooseFile']({ title: '旧文件选择', extensions: ['md'] });
  assert.deepEqual(calls, [options, { title: '旧文件选择', extensions: ['md'] }]);
  assert.throws(() => handlers['host.chooseFile']({ ...options, showHiddenFiles: 'true' }), /文件选择参数无效/);
  assert.equal(calls.length, 2, 'invalid options must not open a dialog');
});

test('directory picker forwards an opt-in hidden-file option and rejects invalid values', async () => {
  const calls = [];
  const handlers = createHandlers({ selectDirectory: async (...args) => { calls.push(args); return '/tmp/.hidden'; } });
  assert.equal(await handlers['host.chooseDirectory']({ defaultPath: '/tmp', showHiddenFiles: true }), '/tmp/.hidden');
  await handlers['host.chooseDirectory']({ showHiddenFiles: false });
  assert.deepEqual(calls, [['选择工作目录', '/tmp', true], ['选择工作目录', undefined, false]]);
  assert.throws(() => handlers['host.chooseDirectory']({ showHiddenFiles: 'true' }), /目录选择参数无效/);
  assert.equal(calls.length, 2, 'invalid options must not open a dialog');
});
