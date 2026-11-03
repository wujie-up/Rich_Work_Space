import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Files } from '../src/main/common/files.js';
import { formatText } from '../src/renderer/format.js';
import { Storage } from '../../../desk/src/main/common/storage.js';

test('new documents save on the workbench desktop while explicit destinations and original files retain their roots', async t => {
  const { activate } = await import('../src/main/common/index.js');
  const data = await mkdtemp(join(tmpdir(), 'editor-desktop-save-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const methods = new Map();
  await activate({ pluginId: 'text-editor', storage: new Storage(data),
    methods: { register: (name, handler) => methods.set(name, handler) },
    views: { register() {} }, lifecycle: { register() {} } });
  const call = (name, ...args) => methods.get(`editor.${name}`)(...args);
  await call('draft', { id: 'draft', name: 'new.txt', text: 'unfinished', saved: '' });
  const metadata = await call('drafts', { metadata: true });
  assert.equal(metadata[0].name, 'new.txt');
  assert.equal('text' in metadata[0], false);
  assert.equal('saved' in metadata[0], false);
  assert.equal((await call('drafts'))[0].text, 'unfinished');
  const desktop = await call('save', 'a', { desktop: true, path: 'new.txt', text: 'desktop', revision: null });
  assert.equal(desktop.root, await realpath(join(data, 'desktop-files')));
  assert.equal(await readFile(join(data, 'desktop-files/new.txt'), 'utf8'), 'desktop');
  const copy = await call('save', 'a', { root: data, path: 'copy.txt', text: 'copy', revision: null });
  assert.equal(copy.root, await realpath(data));
  assert.equal(await readFile(join(data, 'copy.txt'), 'utf8'), 'copy');
  await call('save', 'a', { root: desktop.root, path: desktop.path, text: 'updated', revision: desktop.revision });
  assert.equal(await readFile(join(data, 'desktop-files/new.txt'), 'utf8'), 'updated');
  await assert.rejects(call('save', 'a', { desktop: true, path: 'new.txt', text: 'overwrite', revision: null }), /已存在/);
  assert.equal(await readFile(join(data, 'desktop-files/new.txt'), 'utf8'), 'updated');
});

test('formats JSON without losing integer precision; preserves YAML comments and XML mixed text', () => {
  assert.match(formatText('{"n":9007199254740993123}', 'json'), /9007199254740993123/);
  assert.match(formatText('# note\na: [1,2]', 'yaml'), /# note/);
  assert.match(formatText('<r><p>Hello <b>world</b>!</p></r>', 'xml'), /Hello <b>world<\/b>!/);
  for (const [text, type] of [['{bad}', 'json'], ['a: [', 'yaml'], ['<r><a></r>', 'xml']]) {
    assert.throws(() => formatText(text, type));
  }
});

test('YAML formatting preserves integer and floating-point source precision', () => {
  const source = 'id: 9007199254740993123\nratio: 1.234567890123456789\nexp: 1.23456e+99\n';
  assert.equal(formatText(source, 'yaml'), source);
});

test('unified JSON formatting accepts JSONC comments and trailing commas without losing source precision', () => {
  for (const type of ['json', 'jsonc']) {
    const formatted = formatText('{// note\n"n":9007199254740993123,}', type);
    assert.match(formatted, /\/\/ note/);
    assert.match(formatted, /9007199254740993123/);
    assert.match(formatted, /,\s*}/);
    assert.throws(() => formatText('{"n": }', type), /JSON 格式错误/);
  }
});

test('file saves preserve BOM/CRLF, detect conflicts, reject traversal and external symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'editor-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Files();
  await files.workspace(root);
  await writeFile(join(root, 'a.txt'), '\ufeffone\r\ntwo\r\n');
  const file = await files.read('a.txt');
  assert.equal(file.text, 'one\ntwo\n');
  await files.save({ path: file.path, text: 'new\n', revision: file.revision });
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '\ufeffnew\r\n');
  await assert.rejects(files.save({ path: file.path, text: 'stale', revision: file.revision }), /已被修改/);
  await assert.rejects(files.read('../outside'), /工作目录/);
  await symlink('/etc/hosts', join(root, 'link'));
  await assert.rejects(files.read('link'), /工作目录/);
  await assert.rejects(files.save({ path: 'a.txt', text: 'overwrite', revision: null }), /已存在/);
  await writeFile(join(root, 'binary'), Buffer.from([0xff, 0x00]));
  await assert.rejects(files.read('binary'), /UTF-8|二进制/);
});

test('concurrent draft and file operations queue; separate windows retain separate roots', async t => {
  const { activate } = await import('../src/main/common/index.js');
  const root = await mkdtemp(join(tmpdir(), 'editor-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const root2 = await mkdtemp(join(tmpdir(), 'editor-other-'));
  t.after(() => rm(root2, { recursive: true, force: true }));
  const registered = new Map();
  const stored = new Map();
  await activate({ pluginId: 'text-editor', storage: {
    readJson: async (key, fallback) => structuredClone(stored.get(key) ?? fallback),
    writeJson: async (key, value) => { await new Promise(resolve => setTimeout(resolve, 5)); stored.set(key, value); }
  }, methods: { register: (name, handler, options) => registered.set(name, { handler, options }) },
  views: { register() {} }, lifecycle: { register() {} } });
  const call = (name, ...args) => registered.get(`editor.${name}`).handler(...args);
  assert.notEqual(registered.get('editor.draft').options?.exclusive, true);
  await Promise.all([call('workspace', 'a', root), call('workspace', 'b', root2)]);
  await Promise.all([call('draft', { id: 'one', text: 'one' }), call('draft', { id: 'two', text: 'two' }),
    call('save', 'a', { path: 'a.txt', text: 'a', revision: null }), call('save', 'b', { path: 'a.txt', text: 'b', revision: null })]);
  assert.equal(stored.get('plugin-data/text-editor/drafts.json').length, 2);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(await readFile(join(root2, 'a.txt'), 'utf8'), 'b');
  const opened = await call('openDocument', 'document-window', { path: 'a.txt', cwd: root });
  assert.equal(opened.text, 'a');
  assert.equal(opened.root, await realpath(root), 'direct opens must return the original directory without requiring a listing');
  assert.equal((await call('read', 'b', 'a.txt')).text, 'b', 'opening a document must preserve the other window root');
  await writeFile(join(root, 'binary.txt'), Buffer.from([0xff]));
  await assert.rejects(call('openDocument', 'document-window', { path: join(root, 'binary.txt') }), /UTF-8/);
  await writeFile(join(root2, 'invalid.txt'), Buffer.from([0xff]));
  await assert.rejects(call('openDocument', 'document-window', { path: join(root2, 'invalid.txt') }), /UTF-8/);
  assert.equal((await call('read', 'document-window', 'a.txt')).text, 'a', 'a failed history open must preserve the current root');
  await writeFile(join(root, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  const large = await call('openDocument', 'document-window', { path: join(root, 'large.txt') });
  assert.equal(large.text, 'x'.repeat(256 * 1024 + 1));
  await call('save', 'document-window', { path: large.path, text: `${large.text}edited`, revision: large.revision });
  assert.equal(await readFile(join(root, 'large.txt'), 'utf8'), `${large.text}edited`);
});

test('files up to 16 MiB can be opened and saved; oversized writes leave files intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'editor-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Files();
  await files.workspace(root);
  const text = 'x'.repeat(16 * 1024 * 1024);
  const created = await files.save({ path: 'boundary.txt', text, revision: null });
  assert.equal(created.text, text);
  const opened = await files.read('boundary.txt');
  const edited = `y${text.slice(1)}`;
  const saved = await files.save({ path: opened.path, text: edited, revision: opened.revision });
  assert.equal(saved.text, edited);
  await assert.rejects(files.save({ path: saved.path, text: `${edited}x`, revision: saved.revision }), /16 MiB/);
  assert.equal(await readFile(join(root, 'boundary.txt'), 'utf8'), edited);
  await assert.rejects(files.save({ path: 'oversized.txt', text: '中'.repeat(6 * 1024 * 1024), revision: null }), /16 MiB/);
  await assert.rejects(readFile(join(root, 'oversized.txt')), { code: 'ENOENT' });
  await writeFile(join(root, 'oversized.txt'), `${text}x`);
  await assert.rejects(files.read('oversized.txt'), /16 MiB/);
});


test('history retains every successfully opened file across workspaces and plugin restarts', async t => {
  const { activate } = await import('../src/main/common/index.js');
  const root = await mkdtemp(join(tmpdir(), 'editor-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = new Map();
  const methods = new Map();
  const context = { pluginId: 'text-editor', storage: {
    readJson: async (key, fallback) => structuredClone(stored.get(key) ?? fallback),
    writeJson: async (key, value) => stored.set(key, structuredClone(value))
  }, methods: { register: (name, handler) => methods.set(name, handler) },
  views: { register() {} }, lifecycle: { register() {} } };
  const call = (name, ...args) => methods.get(`editor.${name}`)(...args);
  await activate(context);
  await writeFile(join(root, 'first.md'), '# First');
  await call('openDocument', 'a', { path: join(root, 'first.md') });
  await call('read', 'a', 'first.md');
  await assert.rejects(call('read', 'a', 'missing.md'), /ENOENT/);
  await call('save', 'a', { path: 'second.txt', text: 'Second', revision: null });
  await call('openDocument', 'b', { path: join(root, 'second.txt') });
  await activate(context);
  const history = await call('history');
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(file => file.path), ['second.txt', 'first.md']);
  assert.equal(history[0].name, 'second.txt');
  const reopened = await call('openDocument', 'restored', { cwd: history[1].root, path: history[1].path });
  assert.equal(reopened.text, '# First');
  assert.equal((await call('history')).length, 2);
});

test('file actions rename without overwriting, remove only history, and delete only the selected file', async t => {
  const { activate } = await import('../src/main/common/index.js');
  const root = await mkdtemp(join(tmpdir(), 'editor-file-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const methods = new Map();
  const stored = new Map();
  await activate({ pluginId: 'text-editor', storage: {
    readJson: async (key, fallback) => structuredClone(stored.get(key) ?? fallback),
    writeJson: async (key, value) => stored.set(key, structuredClone(value))
  }, methods: { register: (name, handler) => methods.set(name, handler) },
  views: { register() {} }, lifecycle: { register() {} } });
  const call = (name, ...args) => methods.get(`editor.${name}`)(...args);
  await writeFile(join(root, 'original.md'), '# Original');
  await writeFile(join(root, 'occupied.md'), '# Keep');
  const opened = await call('openDocument', 'a', { cwd: root, path: 'original.md' });
  const file = (await call('history'))[0];
  await call('draft', { id: 'draft', root: file.root, path: file.path, name: file.name, revision: opened.revision,
    text: '# Unfinished', saved: '# Original', type: 'md' });
  await assert.rejects(call('renameFile', file, 'occupied.md'), /EEXIST/);
  await assert.rejects(call('renameFile', file, '../outside.md'), /名称/);
  await assert.rejects(call('deleteFile', { root: file.root, path: '../outside.md' }), /工作目录/);
  const renamed = await call('renameFile', file, 'renamed.md');
  assert.equal(renamed.path, 'renamed.md');
  assert.equal(await readFile(join(root, 'renamed.md'), 'utf8'), '# Original');
  await assert.rejects(readFile(join(root, 'original.md')), /ENOENT/);
  assert.deepEqual((await call('history')).map(entry => entry.name), ['renamed.md']);
  assert.equal((await call('drafts'))[0].path, 'renamed.md');
  await call('removeHistory', { root: file.root, path: 'renamed.md' });
  assert.deepEqual(await call('history'), []);
  assert.equal(await readFile(join(root, 'renamed.md'), 'utf8'), '# Original');
  await call('read', 'a', 'renamed.md');
  await call('deleteFile', { root: file.root, path: 'renamed.md' });
  await assert.rejects(readFile(join(root, 'renamed.md')), /ENOENT/);
  assert.deepEqual(await call('history'), []);
  const draft = (await call('drafts'))[0];
  assert.equal(draft.path, null, 'deleting a file must detach its recoverable draft from the deleted path');
  assert.equal(draft.text, '# Unfinished');
  assert.equal(await readFile(join(root, 'occupied.md'), 'utf8'), '# Keep');
  await call('removeHistory', { root: file.root, path: 'already-missing.md' });
});
