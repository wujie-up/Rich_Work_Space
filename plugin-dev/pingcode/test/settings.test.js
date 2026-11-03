import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../src/main/common/settings.js';

test('settings preserve, explicitly clear and never return secrets; snapshots and permissions survive reopening', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pingcode-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(root);
  await store.save({ accessToken: 'do-not-return', authMode: 'token' });
  assert.equal((await stat(join(root, 'connection.json'))).mode & 0o777, 0o600);
  assert.equal((await store.read()).hasAccessToken, true);
  assert.equal(JSON.stringify(await store.read()).includes('do-not-return'), false);
  const old = await store.snapshot();
  await store.save({ accessToken: '', projectId: 'new-project' });
  assert.equal((await store.snapshot()).accessToken, 'do-not-return');
  assert.notEqual(old.projectId, (await store.snapshot()).projectId);
  assert.equal((await new SettingsStore(root).read()).hasAccessToken, true);
  await store.save({ clearAccessToken: true });
  assert.equal((await store.read()).hasAccessToken, false);
  assert.equal(old.accessToken, 'do-not-return');
  await assert.rejects(store.save({ apiRoot: 'https://secret@example.com' }), /地址/);
});
