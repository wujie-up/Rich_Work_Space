import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../src/main/common/index.js';

async function editor(t, history = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'editor-groups-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = new Map([['plugin-data/text-editor/history.json', history]]);
  const methods = new Map();
  const storage = {
    readJson: async (key, fallback) => structuredClone(stored.get(key) ?? fallback),
    writeJson: async (key, value) => stored.set(key, structuredClone(value))
  };
  await activate({ pluginId: 'text-editor', storage, methods: { register: (name, handler) => methods.set(name, handler) },
    views: { register() {} }, lifecycle: { register() {} } });
  const call = (name, ...args) => {
    assert.ok(methods.has(`editor.${name}`), `editor.${name} must be registered`);
    return methods.get(`editor.${name}`)(...args);
  };
  return { call, root, stored, storage };
}

test('old history migrates once and equivalent paths occupy one group only', async t => {
  const { call } = await editor(t, [
    { root: '/work', path: 'a.md', name: 'a.md', updated: 3 },
    { root: '/', path: 'work/a.md', name: 'a.md', updated: 2 },
    { root: '/work', path: 'b.md', name: 'b.md', updated: 1 }
  ]);
  const initial = await call('groups');
  assert.deepEqual(initial.groups.map(group => [group.name, group.files.map(file => file.name)]), [['未分组', ['a.md', 'b.md']]]);
  await call('organize', { action: 'remove', file: { root: '/work', path: 'a.md' } });
  assert.deepEqual((await call('groups')).groups[0].files.map(file => file.name), ['b.md']);
  assert.equal((await call('history')).length, 3, 'organization does not rewrite access history');
});

test('manual ordering and single membership survive access, rename and group deletion', async t => {
  const { call, root } = await editor(t);
  await call('workspace', 'one', root);
  await call('save', 'one', { path: 'a.md', text: 'a', revision: null });
  await call('save', 'one', { path: 'b.md', text: 'b', revision: null });
  const added = await call('organize', { action: 'create', name: '项目' });
  const groupId = added.groups[1].id;
  const a = { root, path: 'a.md' };
  const b = { root, path: 'b.md' };
  await Promise.all([call('organize', { action: 'move', groupId, file: a }), call('organize', { action: 'move', groupId, file: b })]);
  await call('organize', { action: 'move', groupId, file: b, before: a });
  await call('openDocument', 'two', { path: join(root, 'b.md'), groupId: 'ungrouped' });
  const opened = await call('read', 'one', 'a.md');
  await call('save', 'one', { path: 'a.md', text: 'edited', revision: opened.revision });
  let state = await call('groups');
  assert.deepEqual(state.groups.map(group => group.files.map(file => file.name)), [[], ['b.md', 'a.md']]);
  await call('save', 'one', { path: 'c.md', text: 'c', revision: null, groupId });
  await call('renameFile', a, 'renamed.md');
  state = await call('organize', { action: 'rename', groupId, name: '项目资料' });
  assert.equal(state.groups[1].name, '项目资料');
  assert.deepEqual(state.groups[1].files.map(file => file.name), ['b.md', 'renamed.md', 'c.md']);
  state = await call('organize', { action: 'delete', groupId });
  assert.deepEqual(state.groups.map(group => group.files.map(file => file.name)), [['b.md', 'renamed.md', 'c.md']]);
  assert.equal(await readFile(join(root, 'renamed.md'), 'utf8'), 'edited');
  await call('removeHistory', { root, path: 'renamed.md' });
  await call('deleteFile', b);
  assert.deepEqual((await call('groups')).groups[0].files.map(file => file.name), ['c.md']);
  assert.equal(await readFile(join(root, 'renamed.md'), 'utf8'), 'edited');
  const fallback = await call('save', 'one', { path: 'stale.md', text: 'stale group', revision: null, groupId });
  assert.equal(fallback.organizationWarning, undefined, 'another window may still reference a deleted group');
  assert.deepEqual((await call('groups')).groups[0].files.map(file => file.name), ['c.md', 'stale.md']);
});

test('invalid changes leave persisted groups untouched and group failures preserve file access', async t => {
  const { call, root, stored, storage } = await editor(t);
  await call('groups');
  const snapshot = structuredClone(stored.get('plugin-data/text-editor/file-groups.json'));
  for (const change of [
    { action: 'create', name: '  ' }, { action: 'delete', groupId: 'ungrouped' },
    { action: 'move', groupId: 'missing', file: { root, path: 'a.md' } }, { action: 'unknown' }
  ]) {
    await assert.rejects(call('organize', change));
    assert.deepEqual(stored.get('plugin-data/text-editor/file-groups.json'), snapshot);
  }
  await writeFile(join(root, 'a.md'), '# text');
  const read = storage.readJson;
  storage.readJson = (key, fallback) => key.endsWith('/file-groups.json') ? Promise.reject(Error('storage unavailable')) : read(key, fallback);
  const file = await call('openDocument', 'one', { path: join(root, 'a.md') });
  assert.equal(file.text, '# text');
  assert.match(file.organizationWarning, /分组/);
  assert.equal((await call('history'))[0].name, 'a.md');
});

test('rename keeps source membership and replaces stale destination references', async t => {
  const { call, root } = await editor(t);
  await call('workspace', 'one', root);
  await call('save', 'one', { path: 'a.md', text: 'a', revision: null });
  await call('save', 'one', { path: 'b.md', text: 'b', revision: null });
  const created = await call('organize', { action: 'create', name: '项目' });
  await call('organize', { action: 'move', groupId: created.groups[1].id, file: { root, path: 'a.md' } });
  await unlink(join(root, 'b.md'));
  await call('renameFile', { root, path: 'a.md' }, 'b.md');
  assert.deepEqual((await call('groups')).groups.map(group => group.files.map(file => file.name)), [[], ['b.md']]);
  assert.equal(await readFile(join(root, 'b.md'), 'utf8'), 'a');
});

test('missing files are described without persisting status, changing order or removing history', async t => {
  const { call, root, stored } = await editor(t);
  await writeFile(join(root, 'a.sql'), 'SELECT 1;');
  await writeFile(join(root, 'b.txt'), 'keep');
  await call('openDocument', 'one', { path: join(root, 'a.sql') });
  await call('openDocument', 'one', { path: join(root, 'b.txt') });
  await unlink(join(root, 'a.sql'));
  const saved = structuredClone([...stored]);
  assert.deepEqual((await call('groups')).groups[0].files.map(file => [file.name, file.missing]),
    [['a.sql', true], ['b.txt', false]]);
  assert.deepEqual((await call('history')).map(file => [file.name, file.missing]), [['b.txt', false], ['a.sql', true]]);
  assert.deepEqual([...stored], saved, 'existence is transient and does not change saved organization or history');
  const organized = await call('organize', { action: 'create', name: '项目' });
  assert.equal(organized.groups[0].files[0].missing, true, 'organization responses retain current file status');
  await writeFile(join(root, 'a.sql'), 'SELECT 2;');
  assert.equal((await call('groups')).groups[0].files[0].missing, false);
  assert.equal((await call('history'))[1].missing, false);
});

test('missing parent directories are marked but other stat failures do not imply deletion', async t => {
  const { call, root, stored } = await editor(t);
  await writeFile(join(root, 'parent'), 'not a directory');
  await symlink('loop', join(root, 'loop'));
  stored.set('plugin-data/text-editor/history.json', [
    { root: join(root, 'removed-directory'), path: 'a.md', name: 'a.md' },
    { root, path: 'parent/b.md', name: 'b.md' },
    { root, path: 'loop', name: 'loop' }
  ]);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  assert.deepEqual((await call('history')).map(file => file.missing), [true, true, false]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].pluginId, 'text-editor');
  assert.equal(errors[0][1].path, 'loop');
  assert.equal(errors[0][2].code, 'ELOOP');
  assert.match(errors[0][2].stack, /Error/);
});
