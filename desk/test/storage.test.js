import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../src/main/common/storage.js';

test('atomic write keeps previous value on failure with unicode and spaced data root', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), '工作台 storage '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Storage(root);
  await store.writeJson('preferences.json', { theme: 'dark' });
  store.io = { ...fs, rename: async () => { throw new Error('disk failure'); } };
  await assert.rejects(store.writeJson('preferences.json', { theme: 'light' }), /disk failure/);
  assert.deepEqual(await store.readJson('preferences.json'), { theme: 'dark' });
});

test('plugin cleanup stays within owner and rejects invalid ids or symlink escape', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'desk-clean-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Storage(root);
  await store.writeJson('plugin-data/one/layout.json', { keep: false });
  await store.writeJson('plugin-data/two/layout.json', { keep: true });
  await fs.mkdir(join(root, 'outside'));
  await fs.writeFile(join(root, 'outside', 'credentials'), 'untouched');
  await store.clearPluginData('one');
  assert.deepEqual(await store.readJson('plugin-data/two/layout.json'), { keep: true });
  assert.throws(() => store.pluginDir('../outside'), /插件/);
  await fs.symlink(join(root, 'outside'), join(root, 'plugin-data', 'evil'));
  await assert.rejects(store.clearPluginData('evil'), /链接/);
  assert.equal(await fs.readFile(join(root, 'outside', 'credentials'), 'utf8'), 'untouched');
});
