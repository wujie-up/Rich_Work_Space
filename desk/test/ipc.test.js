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
