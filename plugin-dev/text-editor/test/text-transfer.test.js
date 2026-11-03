import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activate } from '../src/main/common/index.js';
import { invokeText } from '../src/renderer/text-transfer.js';

async function editor(t) {
  const root = await mkdtemp(join(tmpdir(), 'editor-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const methods = new Map();
  const stored = new Map();
  const calls = [];
  let lifecycle;
  const storage = {
    readJson: async (key, fallback) => structuredClone(stored.get(key) ?? fallback),
    writeJson: async (key, value) => stored.set(key, structuredClone(value))
  };
  await activate({ pluginId: 'text-editor', storage,
    methods: { register: (name, handler) => methods.set(name, handler) }, views: { register() {} },
    lifecycle: { register: value => { lifecycle = value; } } });
  t.after(() => lifecycle.stop());
  const call = async (method, args) => {
    assert.ok(Buffer.byteLength(JSON.stringify(['text-editor', method, args])) <= 1024 * 1024, 'each host request fits 1 MiB');
    calls.push(method);
    return methods.get(method)(...args);
  };
  const invoke = (method, ...args) => invokeText(call, method, args);
  await invoke('editor.workspace', 'window', root);
  return { root, call, invoke, calls, storage, lifecycle };
}

test('large drafts and saves preserve Unicode, escaping, file conflicts and small direct calls', async t => {
  const { root, invoke, calls } = await editor(t);
  const text = `${'x'.repeat(65535)}😀${'中文\u0000"\\\n'.repeat(80000)}`;
  await invoke('editor.draft', { id: 'draft', text, saved: text.slice(0, -1) });
  assert.equal((await invoke('editor.drafts'))[0].text, text);
  assert.equal((await invoke('editor.drafts'))[0].saved, text.slice(0, -1));
  const fileText = text.replaceAll('\u0000', '');
  const file = await invoke('editor.save', 'window', { path: 'large.txt', text: fileText, revision: null });
  assert.equal(await readFile(join(root, 'large.txt'), 'utf8'), fileText);
  await invoke('editor.save', 'window', { path: file.path, text: `${fileText}edited`, revision: file.revision });
  await assert.rejects(invoke('editor.save', 'window', { path: file.path, text: fileText, revision: file.revision }), /已被修改/);
  assert.equal(await readFile(join(root, 'large.txt'), 'utf8'), `${fileText}edited`);
  const before = calls.length;
  await invoke('editor.draft', { id: 'draft', remove: true });
  assert.deepEqual(calls.slice(before), ['editor.draft']);
  assert.deepEqual(await invoke('editor.drafts'), []);
});

test('16 MiB text transfers succeed and oversized UTF-8 fields do not persist', async t => {
  const { root, invoke } = await editor(t);
  const text = '😀'.repeat(4 * 1024 * 1024);
  await invoke('editor.draft', { id: 'boundary', text, saved: text });
  assert.equal((await invoke('editor.drafts'))[0].text, text);
  await invoke('editor.save', 'window', { path: 'boundary.txt', text, revision: null });
  assert.equal(await readFile(join(root, 'boundary.txt'), 'utf8'), text);
  await assert.rejects(invoke('editor.draft', { id: 'oversized', text: `${text}x`, saved: '' }), /16 MiB/);
  assert.deepEqual((await invoke('editor.drafts')).map(draft => draft.id), ['boundary']);
});

test('a staged save keeps its original directory when the same client opens another workspace', async t => {
  const { root, call, invoke } = await editor(t);
  const other = join(root, 'other');
  await mkdir(other);
  await writeFile(join(root, 'same.txt'), 'original');
  await writeFile(join(other, 'same.txt'), 'original');
  const file = await invoke('editor.read', 'window', 'same.txt');
  const id = await call('editor.transfer.start', ['editor.save', ['window', { path: file.path, text: '', revision: file.revision }], { text: 3 }]);
  await call('editor.transfer.append', [id, 'text', 'new']);
  await invoke('editor.openDocument', 'window', { cwd: other, path: 'same.txt' });
  await call('editor.transfer.finish', [id]);
  assert.equal(await readFile(join(root, 'same.txt'), 'utf8'), 'new');
  assert.equal(await readFile(join(other, 'same.txt'), 'utf8'), 'original');
  assert.equal((await invoke('editor.read', 'window', 'same.txt')).text, 'original', 'saving must not change the current workspace');
});

test('partial, aborted and interleaved uploads never write partial drafts; failures remain recoverable', async t => {
  const { call, invoke, storage, lifecycle } = await editor(t);
  const start = id => call('editor.transfer.start', ['editor.draft', [{ id, text: '', saved: '' }], { text: 3, saved: 0 }]);
  const first = await start('first');
  const second = await start('second');
  await call('editor.transfer.append', [first, 'text', 'one']);
  assert.deepEqual(await invoke('editor.drafts'), []);
  await call('editor.transfer.append', [second, 'text', 'two']);
  await call('editor.transfer.finish', [second]);
  assert.equal((await invoke('editor.drafts'))[0].text, 'two');
  await call('editor.transfer.abort', [first]);
  await assert.rejects(call('editor.transfer.finish', [first]), /传输/);
  const incomplete = await start('incomplete');
  await assert.rejects(call('editor.transfer.finish', [incomplete]), /完整/);
  const invalid = await start('invalid');
  await assert.rejects(call('editor.transfer.append', [invalid, 'id', 'bad']), /分片/);
  const writeJson = storage.writeJson;
  storage.writeJson = async () => { throw Error('disk full'); };
  await assert.rejects(invoke('editor.draft', { id: 'failed', text: 'x'.repeat(80000), saved: '' }), /disk full/);
  storage.writeJson = writeJson;
  await invoke('editor.draft', { id: 'recovered', text: 'x'.repeat(80000), saved: '' });
  assert.deepEqual((await invoke('editor.drafts')).map(draft => draft.id), ['second', 'recovered']);
  const abandoned = await start('abandoned');
  await lifecycle.stop();
  await assert.rejects(call('editor.transfer.append', [abandoned, 'text', 'one']), /传输/);
});
