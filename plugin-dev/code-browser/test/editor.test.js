import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/main/common/workspace.js';
import { editFile, saveFile } from '../src/main/common/editor.js';

test('editing preserves BOM, newline, permissions and rejects external changes without overwriting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await Workspace.open(root);
  await writeFile(join(root, 'Main.java'), '\ufeffclass Main {}\r\n', { mode: 0o640 });
  const file = await editFile(workspace, { path: 'Main.java' });
  assert.equal(file.text, 'class Main {}\n');
  const saved = await saveFile(workspace, { ...file, text: 'class Main { int x; }\n' });
  assert.equal(await readFile(join(root, 'Main.java'), 'utf8'), '\ufeffclass Main { int x; }\r\n');
  assert.equal((await stat(join(root, 'Main.java'))).mode & 0o777, 0o640);
  await writeFile(join(root, 'Main.java'), 'external');
  await assert.rejects(saveFile(workspace, { ...saved, text: 'draft' }), /已被修改/);
  assert.equal(await readFile(join(root, 'Main.java'), 'utf8'), 'external');
});

test('editing bounds content and paths and supports an empty file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await Workspace.open(root);
  await writeFile(join(root, 'empty.js'), '');
  const file = await editFile(workspace, { path: 'empty.js' });
  assert.equal((await saveFile(workspace, { ...file, text: 'const a = 1;\n' })).text, 'const a = 1;\n');
  await assert.rejects(editFile(workspace, { path: '../outside' }), /路径/);
  await mkdir(join(root, 'directory'));
  await assert.rejects(editFile(workspace, { path: 'directory' }), /普通|文本/);
  await assert.rejects(saveFile(workspace, { ...file, text: 'x'.repeat(128 * 1024 + 1) }), /128 KiB/);
});
