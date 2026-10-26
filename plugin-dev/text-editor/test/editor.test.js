import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Files } from '../src/main/common/files.js';
import { formatText } from '../src/renderer/format.js';

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
  let stored = [];
  await activate({ pluginId: 'text-editor', storage: {
    readJson: async () => structuredClone(stored),
    writeJson: async (_key, value) => { await new Promise(resolve => setTimeout(resolve, 5)); stored = value; }
  }, methods: { register: (name, handler, options) => registered.set(name, { handler, options }) },
  views: { register() {} }, lifecycle: { register() {} } });
  const call = (name, ...args) => registered.get(`editor.${name}`).handler(...args);
  assert.notEqual(registered.get('editor.draft').options?.exclusive, true);
  await Promise.all([call('workspace', 'a', root), call('workspace', 'b', root2)]);
  await Promise.all([call('draft', { id: 'one', text: 'one' }), call('draft', { id: 'two', text: 'two' }),
    call('save', 'a', { path: 'a.txt', text: 'a', revision: null }), call('save', 'b', { path: 'a.txt', text: 'b', revision: null })]);
  assert.equal(stored.length, 2);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(await readFile(join(root2, 'a.txt'), 'utf8'), 'b');
  const opened = await call('openDocument', 'document-window', { path: 'a.txt', cwd: root });
  assert.equal(opened.text, 'a');
  assert.equal((await call('read', 'b', 'a.txt')).text, 'b', 'opening a document must preserve the other window root');
  await writeFile(join(root, 'binary.txt'), Buffer.from([0xff]));
  await assert.rejects(call('openDocument', 'document-window', { path: join(root, 'binary.txt') }), /UTF-8/);
  await writeFile(join(root, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(call('openDocument', 'document-window', { path: join(root, 'large.txt') }), /256 KiB/);
});
