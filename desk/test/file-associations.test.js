import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginProperties } from '../src/main/common/plugin-manifest.js';
import { fileProvider } from '../src/renderer/file-associations.js';

test('desktop files use declared enabled providers and fall back without one', () => {
  const plugin = { id: 'editor', state: 'enabled', views: [{ id: 'editor', contributes: { entries: ['text-document'], fileExtensions: ['md', 'txt'] } }] };
  assert.equal(fileProvider([plugin], 'Notes.MD').plugin, plugin);
  assert.equal(fileProvider([plugin], 'image.png'), undefined);
  assert.equal(fileProvider([{ ...plugin, state: 'disabled' }], 'notes.md'), undefined);
  assert.equal(fileProvider([{ ...plugin, operation: 'disable' }], 'notes.md'), undefined);
  assert.throws(() => fileProvider([plugin, { ...plugin, id: 'other' }], 'notes.md'), /多个/);
});


test('file extension contributions validate package declarations without changing legacy views', () => {
  const manifest = { background: 'none', views: [{ id: 'editor', title: 'Editor', entry: 'index.html' }] };
  assert.equal(pluginProperties(manifest).views[0].contributes, undefined);
  const contributes = { entries: ['text-document'], fileExtensions: ['txt', 'md'] };
  assert.deepEqual(pluginProperties({ ...manifest, views: [{ ...manifest.views[0], contributes }] }).views[0].contributes, contributes);
  for (const fileExtensions of ['txt', ['.txt'], ['TXT'], ['../txt'], [null]]) {
    assert.throws(() => pluginProperties({ ...manifest, views: [{ ...manifest.views[0], contributes: { ...contributes, fileExtensions } }] }), /fileExtensions/);
  }
});
