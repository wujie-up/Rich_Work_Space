import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { inspectPackage, importPackage } from '../src/main/common/plugin-package.js';

test('package validates manifest entry and every symlink before importing', async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  assert.equal((await inspectPackage(source)).id, 'test-agent');
  await importPackage(storage, source);
  assert.equal((await storage.readJson('plugins/test-agent/plugin.json')).apiVersion, 2);
  await symlink('/tmp', join(source, 'escape'));
  await assert.rejects(inspectPackage(source), /符号链接/);
  const bad = await fixture(storage, 'bad-agent');
  await writeFile(join(bad, 'plugin.json'), JSON.stringify({ id: '../outside', main: '../../x', apiVersion: 2 }));
  await assert.rejects(inspectPackage(bad));
});

test('integrity covers multi-chunk binary files and rejects a changed payload', async t => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 91);
  await writeFile(join(source, 'payload.bin'), payload);
  const files = {};
  for (const name of ['index.mjs', 'payload.bin', 'plugin.json']) {
    files[name] = createHash('sha256').update(await readFile(join(source, name))).digest('hex');
  }
  await writeFile(join(source, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files }));
  assert.equal((await inspectPackage(source)).id, 'test-agent');
  payload[payload.length - 1] = 0;
  await writeFile(join(source, 'payload.bin'), payload);
  await assert.rejects(inspectPackage(source), /完整性校验失败/);
});
