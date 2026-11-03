import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture() {
  const elements = Object.fromEntries(['editor', 'source', 'save', 'filename'].map(id => [id, {
    value: '', hidden: false, classList: { toggle() {} }, focus() {}, setSelectionRange() {}
  }]));
  const timers = new Map();
  const writes = [];
  const messages = [];
  let fail = false;
  let blocker;
  let release;
  const context = vm.createContext({
    document: { querySelector: selector => elements[selector.slice(1)], addEventListener() {}, dispatchEvent() {} },
    CustomEvent: class {}, getComputedStyle: () => ({ lineHeight: '20' }), console,
    setTimeout: callback => { const id = {}; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    confirmAction: async () => false,
    invoke: async (method, input) => {
      if (method === 'edit') {
        return { path: 'Main.java', text: 'initial', revision: '1' };
      }
      await blocker;
      if (fail) {
        throw Error('文件已被修改');
      }
      writes.push(input);
      return { ...input, revision: String(writes.length + 1) };
    }
  });
  const source = (await readFile(new URL('../src/renderer/editor.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace('export function', 'function');
  vm.runInContext(`${source}\nthis.setupEditor = setupEditor;`, context);
  const editor = context.setupEditor(() => ({ path: 'Main.java', startLine: 1 }), (...args) => messages.push(args), fn => fn());
  await editor.open();
  const input = text => { elements.editor.value = text; elements.editor.oninput(); };
  return { editor, elements, writes, messages, input, timers, fail: () => { fail = true; },
    hold: () => { blocker = new Promise(resolve => { release = resolve; }); },
    release: () => release(),
    flush: async () => { const callbacks = [...timers.values()]; timers.clear(); await Promise.all(callbacks.map(fn => fn())); } };
}

test('autosave coalesces typing and flushes the latest draft before leaving', async () => {
  const f = await fixture();
  f.input('first');
  f.input('latest');
  assert.equal(f.timers.size, 1);
  assert.equal(f.writes.length, 0);
  await f.flush();
  assert.equal(f.writes[0].text, 'latest');
  assert.equal(f.editor.dirty(), false);
  f.input('before switching');
  assert.equal(await f.editor.canLeave(), true);
  assert.equal(f.writes[1].text, 'before switching');
  assert.equal(f.writes[1].revision, '2');
});

test('autosave failures retain the draft and cancel navigation', async () => {
  const f = await fixture();
  f.fail();
  f.input('conflict draft');
  await f.flush();
  assert.equal(f.editor.dirty(), true);
  assert.equal(f.elements.editor.value, 'conflict draft');
  assert.equal(await f.editor.canLeave(), false);
  assert.match(f.messages.at(-1)[0], /文件已被修改/);
  assert.equal(f.writes.length, 0);
});

test('typing during a pending save keeps the new text and saves sequential revisions', async () => {
  const f = await fixture();
  f.hold();
  f.input('first write');
  const pending = f.flush();
  f.input('typed while saving');
  const leaving = f.editor.canLeave();
  f.release();
  await pending;
  assert.equal(await leaving, true);
  assert.deepEqual(f.writes.map(write => [write.text, write.revision]), [['first write', '1'], ['typed while saving', '2']]);
  assert.equal(f.elements.editor.value, 'typed while saving');
  assert.equal(f.editor.dirty(), false);
});
