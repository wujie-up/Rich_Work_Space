import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { clipboardPaths } from '../src/shared/file-references.js';
import { resolveFileReferences } from '../src/main/common/file-references.js';

test('clipboard paths accept quoted, escaped, relative and file URI paths without treating prose as files', () => {
  assert.deepEqual(clipboardPaths("'/project/需求 文档.md'\n./src/main.js\n~/notes.txt"),
    ['/project/需求 文档.md', './src/main.js', '~/notes.txt']);
  assert.deepEqual(clipboardPaths('/project/my\\ notes.md'), ['/project/my notes.md']);
  assert.deepEqual(clipboardPaths('# files\r\nfile:///project/%E9%9C%80%E6%B1%82.md\r\n', 'text/uri-list'), ['/project/需求.md']);
  for (const text of ['普通粘贴 中文', '请读取 /project/a.md', 'https://example.com/a.md', '/tmp/a.md\n然后修改它', 'file://server/tmp/a.md']) {
    assert.deepEqual(clipboardPaths(text), []);
  }
});

test('file references resolve existing files only, deduplicate paths and preserve ordinary text fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "需求 'v2'.md");
  await writeFile(path, 'local context');
  await mkdir(join(root, 'folder'));
  assert.deepEqual(await resolveFileReferences([path, "./需求 'v2'.md", pathToFileURL(path).href], root),
    [{ path, name: "需求 'v2'.md" }]);
  assert.deepEqual(await resolveFileReferences([join(root, 'missing.md')], root), []);
  assert.deepEqual(await resolveFileReferences([join(root, 'folder')], root), []);
  assert.deepEqual(await resolveFileReferences([path, join(root, 'missing.md')], root), []);
  await assert.rejects(resolveFileReferences(['/tmp/file\x1b.md'], root), { code: 'INVALID_ARGUMENT' });
});
