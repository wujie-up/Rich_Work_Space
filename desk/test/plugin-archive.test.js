import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { create, Header } from 'tar';
import { Plugins } from '../src/main/common/plugins.js';
import { gzipSync } from 'node:zlib';
import { temporaryStore, fixture } from './helpers.js';
import { packPackage, importPackage, withPackageSource } from '../src/main/common/plugin-package.js';

test('gzip tar .plg round trip preserves plugin files and existing data', async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  await storage.writeJson('plugin-data/test-agent/history.json', { retained: true });
  const archive = join(storage.root, 'test-agent.plg');
  await assert.rejects(packPackage(source, join(source, 'inside.plg')), /目录外/);
  await packPackage(source, archive);
  assert.deepEqual([...(await readFile(archive)).subarray(0, 2)], [31, 139]);
  await importPackage(storage, archive);
  assert.equal((await storage.readJson('plugins/test-agent/plugin.json')).id, 'test-agent');
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/history.json'), { retained: true });
  assert.equal(await readFile(join(storage.root, 'plugins/test-agent/index.mjs'), 'utf8'), await readFile(join(source, 'index.mjs'), 'utf8'));
});

test('archives reject traversal, links, corrupt content and incorrect suffix', async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  const archive = join(storage.root, 'unsafe.plg');
  const header = new Header({ path: '../escaped', size: 1, type: 'File', mode: 0o644 });
  header.encode();
  await writeFile(archive, gzipSync(Buffer.concat([header.block, Buffer.from('x'), Buffer.alloc(1535)])));
  await assert.rejects(importPackage(storage, archive), /越界/);
  await assert.rejects(readFile(join(storage.root, 'escaped')));
  const link = new Header({ path: 'hard-link', linkpath: '/tmp/outside', size: 0, type: 'Link', mode: 0o644 });
  link.encode();
  await writeFile(archive, gzipSync(Buffer.concat([link.block, Buffer.alloc(1024)])));
  await assert.rejects(importPackage(storage, archive), /链接|特殊文件/);
  await symlink('/tmp', join(source, 'link'));
  await create({ gzip: true, cwd: source, file: archive }, ['.']);
  await assert.rejects(importPackage(storage, archive), /链接|特殊文件/);
  await assert.rejects(packPackage(source, archive), /符号链接/);
  await writeFile(archive, 'not a tar');
  await assert.rejects(importPackage(storage, archive));
  const wrong = join(storage.root, 'wrong.zip');
  await writeFile(wrong, await readFile(archive));
  await assert.rejects(withPackageSource(wrong, () => {}), /\.plg/);
  assert.equal((await readdir(storage.root)).some((name) => name === 'escaped'), false);
});

test('temporary extraction is removed when installation callback fails', async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  const archive = join(storage.root, 'plugin.plg');
  await packPackage(source, archive);
  let extracted;
  await assert.rejects(withPackageSource(archive, async (directory) => {
    extracted = directory;
    throw Error('installation failed');
  }), /installation failed/);
  await assert.rejects(readdir(extracted), { code: 'ENOENT' });
});

test('plugin lifecycle reinstalls .plg with the same ID and retained history', async (t) => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => {
    for (const runtime of plugins.loaded.values()) {
      await runtime.close();
    }
  });
  const source = await fixture(storage);
  const archive = join(storage.root, 'plugin.plg');
  await packPackage(source, archive);
  await plugins.install(archive);
  await storage.writeJson('plugin-data/test-agent/history.json', { retained: true });
  const preview = await plugins.preview('test-agent', 'remove');
  await plugins.remove('test-agent', 'keep', preview.confirmationToken);
  await plugins.install(archive);
  assert.equal(plugins.record('test-agent').state, 'enabled');
  assert.deepEqual(await storage.readJson('plugin-data/test-agent/history.json'), { retained: true });
});
