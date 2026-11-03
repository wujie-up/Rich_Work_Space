import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/main/common/storage.js';
import { createHandlers } from '../src/main/common/ipc.js';
import { DesktopFiles } from '../src/main/common/desktop-files.js';

test('desktop selection reads bounded bytes without allowing paths, links or directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-file-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new DesktopFiles(new Storage(root));
  await files.create('需求.md');
  await writeFile(await files.resolve('需求.md'), '需求正文');
  const selected = await files.read('需求.md');
  assert.equal(selected.name, '需求.md');
  assert.equal(selected.size, Buffer.byteLength('需求正文'));
  assert.equal(new TextDecoder().decode(selected.bytes), '需求正文');
  await assert.rejects(files.read('../outside'), { code: 'INVALID_ARGUMENT' });
  await symlink(await files.resolve('需求.md'), join(await files.directory(), 'link.md'));
  await assert.rejects(files.read('link.md'));
  await mkdir(join(await files.directory(), 'folder'));
  await assert.rejects(files.read('folder'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(files.read('missing.md'), { code: 'FILE_NOT_FOUND' });
  await files.create('large.txt');
  await truncate(await files.resolve('large.txt'), 2 * 1024 * 1024);
  assert.equal((await files.read('large.txt')).bytes.length, 2 * 1024 * 1024);
  await truncate(await files.resolve('large.txt'), 2 * 1024 * 1024 + 1);
  await assert.rejects(files.read('large.txt'), { code: 'FILE_TOO_LARGE' });
  const handlers = createHandlers({ storage: new Storage(root) });
  assert.equal(new TextDecoder().decode((await handlers['desktop.read']('需求.md')).bytes), '需求正文');
});

test('desktop files preserve originals, avoid collisions and survive a new service', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'notes.md');
  await writeFile(source, '# original');
  const files = new DesktopFiles(new Storage(root));
  assert.equal((await files.create('notes.md')).name, 'notes.md');
  const imported = await files.import([source, source]);
  assert.deepEqual(imported.map(item => item.name), ['notes (1).md', 'notes (2).md']);
  assert.equal(await readFile(source, 'utf8'), '# original');
  assert.equal(await readFile(await files.resolve('notes.md'), 'utf8'), '');
  assert.equal(await readFile(await files.resolve(imported[0].name), 'utf8'), '# original');
  assert.equal((await new DesktopFiles(new Storage(root)).list()).length, 3);
  const longName = `${'a'.repeat(196)}.txt`;
  await files.create(longName);
  const duplicate = await files.create(longName);
  assert.equal(duplicate.name, `${'a'.repeat(192)} (1).txt`);
  assert.equal(await readFile(await files.resolve(longName), 'utf8'), '');
});

test('desktop files reject traversal, links and non-files without overwriting data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-files-safe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new DesktopFiles(new Storage(root));
  for (const name of ['../outside', '/tmp/outside', '..', 'a/b', 'a\\b', 'a\n.txt']) {
    await assert.rejects(() => files.create(name));
  }
  await assert.rejects(() => files.import([root]));
  await writeFile(join(root, 'source.txt'), 'retain');
  await symlink(join(root, 'source.txt'), join(root, 'link.txt'));
  await assert.rejects(() => files.import([join(root, 'link.txt')]));
  await files.list();
  await symlink(join(root, 'source.txt'), join(root, 'desktop-files', 'unsafe.txt'));
  await assert.rejects(() => files.resolve('unsafe.txt'));
  assert.deepEqual(await files.list(), []);
  await assert.rejects(() => files.resolve('missing.txt'), { code: 'FILE_NOT_FOUND', message: '文件已被移走或删除' });
});


test('desktop IPC opens only owned files and reports system opening errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-files-ipc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let opened;
  const handlers = createHandlers({ storage: new Storage(root), openPath: async path => { opened = path; return ''; } });
  await handlers['desktop.create']('note.txt');
  await handlers['desktop.openExternal']('note.txt');
  assert.equal(opened, join(root, 'desktop-files', 'note.txt'));
  await assert.rejects(() => handlers['desktop.openExternal']('../outside'));
  const failed = createHandlers({ storage: new Storage(root), openPath: async () => 'No application available' });
  await assert.rejects(() => failed['desktop.openExternal']('note.txt'), /No application/);
});

test('desktop rename preserves bytes and rejects collisions and paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-files-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new DesktopFiles(new Storage(root));
  await files.create('before.txt');
  await writeFile(await files.resolve('before.txt'), 'retained');
  await files.create('occupied.txt');
  await assert.rejects(files.rename('before.txt', 'occupied.txt'), { code: 'EEXIST' });
  await assert.rejects(files.rename('before.txt', '../escape.txt'));
  await files.rename('before.txt', 'after.md');
  assert.equal(await readFile(await files.resolve('after.md'), 'utf8'), 'retained');
  await assert.rejects(files.resolve('before.txt'), { code: 'FILE_NOT_FOUND' });
  await files.rename('after.md', 'after.md');
});

test('desktop deletion uses system trash only for an owned regular file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-files-trash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trashed = [];
  const handlers = createHandlers({ storage: new Storage(root), trashItem: async path => { trashed.push(path); await rm(path); } });
  await handlers['desktop.create']('note.txt');
  await assert.rejects(() => handlers['desktop.trash']('../outside'));
  assert.equal(trashed.length, 0);
  await handlers['desktop.trash']('note.txt');
  assert.deepEqual(trashed, [join(root, 'desktop-files', 'note.txt')]);
  assert.deepEqual(await handlers['desktop.list'](), []);
});

test('desktop properties and clipboard preserve bytes, duplicate names and ownership boundaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desk-files-clipboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clipboard = [];
  const handlers = createHandlers({ storage: new Storage(root), fileClipboard: {
    write: async paths => { clipboard = paths; }, read: async () => clipboard
  } });
  await handlers['desktop.create']('copy.txt');
  const path = join(root, 'desktop-files', 'copy.txt');
  await writeFile(path, 'copied bytes');
  const properties = await handlers['desktop.properties']('copy.txt');
  assert.equal(properties.path, path);
  assert.equal(properties.size, 12);
  assert.equal(properties.name, 'copy.txt');
  assert.ok(Number.isFinite(properties.modified));
  await assert.rejects(() => handlers['desktop.copy']('../outside'));
  await handlers['desktop.copy']('copy.txt');
  assert.deepEqual(clipboard, [path]);
  assert.deepEqual(await handlers['desktop.paste'](), [{ name: 'copy (1).txt' }]);
  assert.equal(await readFile(join(root, 'desktop-files', 'copy (1).txt'), 'utf8'), 'copied bytes');
  clipboard = [];
  assert.deepEqual(await handlers['desktop.paste'](), []);
  clipboard = [root];
  await assert.rejects(() => handlers['desktop.paste'](), { code: 'INVALID_ARGUMENT' });
});
