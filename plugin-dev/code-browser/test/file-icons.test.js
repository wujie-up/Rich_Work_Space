import test from 'node:test';
import assert from 'node:assert/strict';
import { fileIcon } from '../src/renderer/source.js';

test('file icons use names only, group common types and fall back for unknown files', () => {
  for (const [path, expected] of [
    ['package.json', 'braces'], ['src/tsconfig.node.json', 'braces'], ['Main.java', 'java'],
    ['src/App.vue', 'vue'], ['index.HTML', 'code'], ['app.ts', 'code'], ['app.js', 'code'],
    ['styles.css', 'style'], ['README.md', 'markdown'], ['AGENTS.md', 'markdown'],
    ['.gitignore', 'ignore'], ['src/.gitignore', 'ignore'], ['photo.png', 'file'], ['Dockerfile', 'file'], ['constructor', 'file']
  ]) {
    assert.equal(fileIcon(path), expected, path);
  }
});
