import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore, fixture } from './helpers.js';
import { inspectPackage, importPackage } from '../src/main/common/plugin-package.js';

test('package validates manifest entry and every symlink before importing', async (t) => {
  const storage = await temporaryStore(t);
  const source = await fixture(storage);
  assert.equal((await inspectPackage(source)).id, 'test-agent');
  await importPackage(storage, source);
  assert.equal((await storage.readJson('packages/test-agent/plugin.json')).apiVersion, 2);
  await symlink('/tmp', join(source, 'escape'));
  await assert.rejects(inspectPackage(source), /符号链接/);
  const bad = await fixture(storage, 'bad-agent');
  await writeFile(join(bad, 'plugin.json'), JSON.stringify({ id: '../outside', main: '../../x', apiVersion: 2 }));
  await assert.rejects(inspectPackage(bad));
});
