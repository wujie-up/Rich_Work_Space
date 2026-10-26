import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../src/main/common/storage.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers, dispatch } from '../src/main/common/ipc.js';

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

test('removed development IPC methods remain unavailable', async () => {
  const sender = { mainFrame: {} };
  const handlers = createHandlers({});
  assert.equal(Object.keys(handlers).some(method => method.startsWith('development.')), false);
  const result = await dispatch({ sender, senderFrame: sender.mainFrame }, sender, handlers, 'development.create', []);
  assert.equal(result.error.code, 'IPC_FORBIDDEN');
});
