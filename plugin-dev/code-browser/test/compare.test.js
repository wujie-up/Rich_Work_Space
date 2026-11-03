import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workspace } from '../src/main/common/workspace.js';
import { GitReader } from '../src/main/common/git.js';
import { diffLines } from '../src/renderer/diff.js';

test('compact listing folds only chains and keeps branching directories and files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-compact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/main/java/com/a/api'), { recursive: true });
  await mkdir(join(root, 'src/main/java/com/a/domain'));
  await writeFile(join(root, 'src/main/java/com/a/Main.java'), 'class Main {}');
  const workspace = await Workspace.open(root);
  assert.equal((await workspace.list()).entries[0].name, 'src');
  const entry = (await workspace.list({ compact: true })).entries[0];
  assert.equal(entry.name, 'src/main/java/com/a');
  assert.equal(entry.path, 'src/main/java/com/a');
  assert.equal((await workspace.list({ path: entry.path, compact: true })).entries.length, 3);
});

test('two branches return exact added/deleted/modified paths including unusual names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-compare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'changed.js'), 'old\n');
  await writeFile(join(root, 'deleted.js'), 'deleted\n');
  git('add', '.');
  git('commit', '-m', 'base');
  git('switch', '-c', 'feature/test');
  await writeFile(join(root, 'changed.js'), 'new\n');
  await writeFile(join(root, '新\nfile.js'), 'added\n');
  await rm(join(root, 'deleted.js'));
  git('add', '.');
  git('commit', '-m', 'target');
  const reader = new GitReader();
  t.after(() => reader.stop());
  const workspace = await Workspace.open(root);
  const branches = await reader.branches(workspace);
  assert.ok(branches.branches.some(branch => branch.revision === 'refs/heads/feature/test'));
  const diff = await reader.diff(workspace, { base: 'refs/heads/main', target: 'refs/heads/feature/test' });
  assert.deepEqual(diff.files.map(({ status, path }) => [status, path]), [
    ['M', 'changed.js'], ['D', 'deleted.js'], ['A', '新\nfile.js']
  ]);
  assert.ok(diff.files.every(file => file.text.startsWith('diff --git ')));
  assert.ok(diff.files[0].text.includes('+new'));
  const sub = await Workspace.open(root);
  assert.equal((await reader.diff(sub, { base: 'main', target: 'feature/test', path: 'deleted.js' })).files[0].status, 'D');
});

test('diff rows distinguish headers, additions and deletions with accurate hunk line numbers', () => {
  const rows = diffLines('--- a/x\n+++ b/x\n@@ -8,2 +8,2 @@\n-old\n+new\n same\n\\ No newline at end of file\n');
  assert.equal(rows[1].kind, 'metadata');
  assert.deepEqual(rows[3], { text: '-old', kind: 'removed', before: 8, after: '' });
  assert.deepEqual(rows[4], { text: '+new', kind: 'added', before: '', after: 8 });
  assert.equal(rows[5].before, 9);
  assert.equal(rows[6].kind, 'metadata');
  const patch = '@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-later\n+replacement\n';
  const hunks = diffLines(patch);
  assert.deepEqual(hunks.map(row => row.text), patch.trimEnd().split('\n'));
  assert.equal(hunks[4].before, 20);
  assert.equal(hunks[5].after, 20);
});


test('large branch comparison lists paths without loading patches, then loads one file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-large-compare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'changed.js'), 'old\n');
  await writeFile(join(root, 'deleted.js'), 'deleted\n');
  git('add', '.');
  git('commit', '-m', 'base');
  git('branch', 'base');
  await writeFile(join(root, 'changed.js'), 'new line\n'.repeat(30000));
  await writeFile(join(root, 'added.js'), 'added\n');
  await rm(join(root, 'deleted.js'));
  git('add', '.');
  git('commit', '-m', 'large change');
  const reader = new GitReader();
  t.after(() => reader.stop());
  const workspace = await Workspace.open(root);
  const summary = await reader.diff(workspace, { base: 'base', target: 'HEAD', summary: true });
  assert.deepEqual(summary.files.map(({ status, path }) => [status, path]), [
    ['A', 'added.js'], ['M', 'changed.js'], ['D', 'deleted.js']
  ]);
  assert.equal(summary.text, '');
  assert.ok(summary.files.every(file => file.text === undefined));
  const detail = await reader.diff(workspace, { base: summary.base, target: summary.target, path: 'changed.js' });
  assert.ok(Buffer.byteLength(detail.text) > 128 * 1024);
  assert.match(detail.text, /\+new line/);
  assert.equal(detail.files.length, 1);
  assert.match((await reader.diff(workspace, { base: summary.base, target: summary.target, path: 'deleted.js' })).text, /-deleted/);
  assert.equal((await reader.diff(workspace, { base: 'HEAD', target: 'HEAD', summary: true })).files.length, 0);
});
