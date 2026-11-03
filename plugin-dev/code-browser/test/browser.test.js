import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workspace } from '../src/main/common/workspace.js';
import { GitReader } from '../src/main/common/git.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'code-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'project'));
  const root = join(directory, 'project');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/Main.java'), 'class Main {\n  String value = "你好";\n}\n');
  await writeFile(join(root, 'src/App.vue'), '<template>你好</template>\n');
  await writeFile(join(root, 'src/app.js'), 'export const value = 1;\n');
  return { directory, root, workspace: await Workspace.open(root) };
}

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
async function repository(t) {
  const data = await fixture(t);
  git(data.root, 'init', '-q');
  git(data.root, 'config', 'user.name', 'Test');
  git(data.root, 'config', 'user.email', 'test@example.invalid');
  git(data.root, 'add', '.');
  git(data.root, 'commit', '-qm', 'first');
  const first = git(data.root, 'rev-parse', 'HEAD');
  await writeFile(join(data.root, 'src/app.js'), 'export const value = 2;\n');
  git(data.root, 'commit', '-qam', 'second');
  const reader = new GitReader();
  t.after(() => reader.stop());
  return { ...data, first, reader };
}

test('lists and reads Java/Vue/JS with line ranges and Unicode', async t => {
  const { workspace } = await fixture(t);
  assert.equal((await workspace.list({ path: '' })).entries[0].path, 'src');
  assert.equal((await workspace.list({ path: 'src' })).entries.length, 3);
  const file = await workspace.read({ path: 'src/Main.java', startLine: 2, endLine: 2 });
  assert.equal(file.text, '  String value = "你好";');
  assert.equal(file.totalLines, 3);
  assert.equal(file.startLine, 2);
});

test('rejects traversal, absolute paths, escaped symlinks, binary and oversized files', async t => {
  const { directory, root, workspace } = await fixture(t);
  await writeFile(join(directory, 'outside.js'), 'secret');
  await symlink(directory, join(root, 'escape'));
  await writeFile(join(root, 'binary'), Buffer.from([0, 255]));
  await writeFile(join(root, 'large.js'), 'x'.repeat(1024 * 1024 + 1));
  for (const path of ['../outside.js', join(directory, 'outside.js'), 'escape/outside.js', 'binary', 'large.js']) {
    await assert.rejects(workspace.read({ path }));
  }
  await assert.rejects(workspace.read({ path: 'src/Main.java', startLine: 0 }));
  await assert.rejects(workspace.read({ path: 'src/Main.java', startLine: 3, endLine: 1 }));
});

test('literal search skips generated directories and symlinks and reports limits', async t => {
  const { root, workspace } = await fixture(t);
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules/ignored.js'), '你好');
  await symlink(join(root, 'src'), join(root, 'linked'));
  const result = await workspace.search({ query: '你好', limit: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
  assert.match(result.matches[0].path, /^src\//);
  assert.equal((await workspace.search({ query: 'value = 1' })).matches[0].path, 'src/app.js');
  assert.equal((await workspace.search({ query: '[.*]' })).matches.length, 0);
  const signal = AbortSignal.abort();
  await assert.rejects(workspace.search({ query: 'value' }, signal), { name: 'AbortError' });
});

test('reads commit history and historical files; compares commits, index and worktree', async t => {
  const { root, workspace, reader, first } = await repository(t);
  assert.equal((await reader.log(workspace, { limit: 10 })).commits.length, 2);
  assert.match((await reader.show(workspace, { path: 'src/app.js', revision: first })).text, /value = 1/);
  const diff = await reader.diff(workspace, { base: first, target: 'HEAD', path: 'src/app.js' });
  assert.match(diff.text, /-export const value = 1/);
  assert.match(diff.text, /\+export const value = 2/);
  await writeFile(join(root, 'src/app.js'), 'export const value = 3;\n');
  git(root, 'add', '.');
  await writeFile(join(root, 'src/app.js'), 'export const value = 4;\n');
  assert.match((await reader.diff(workspace, { base: 'HEAD', target: 'INDEX' })).text, /\+export const value = 3/);
  assert.match((await reader.diff(workspace, { base: 'HEAD', target: 'WORKTREE' })).text, /\+export const value = 4/);
  assert.deepEqual(git(root, 'status', '--porcelain').slice(0, 2), 'MM');
});

test('Git handles subdirectories and literal filenames, including deleted files', async t => {
  const { root, reader, first } = await repository(t);
  await writeFile(join(root, 'src/[test].js'), 'literal\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'literal');
  const sub = await Workspace.open(join(root, 'src'));
  assert.equal((await reader.show(sub, { revision: 'HEAD', path: '[test].js' })).text, 'literal');
  const diff = await reader.diff(sub, { base: first, target: 'HEAD', path: '[test].js' });
  assert.match(diff.text, /\+literal/);
  await rm(join(root, 'src/[test].js'));
  assert.match((await reader.diff(sub, { base: 'HEAD', target: 'WORKTREE', path: '[test].js' })).text, /-literal/);
});

test('rejects unsafe refs/paths, honors cancellation, and reports a non-Git directory', async t => {
  const { workspace, reader } = await repository(t);
  for (const revision of ['--help', 'HEAD\u0000']) {
    await assert.rejects(reader.show(workspace, { path: 'src/app.js', revision }));
  }
  await assert.rejects(reader.diff(workspace, { base: 'HEAD', target: 'HEAD', path: '../elsewhere' }));
  await assert.rejects(reader.log(workspace, {}, AbortSignal.abort()), { name: 'AbortError' });
  const other = await fixture(t);
  await assert.rejects(reader.log(other.workspace, {}), /Git|git/);
  await reader.stop();
  await assert.rejects(reader.log(workspace, {}), /停止/);
});

test('Git reading does not execute configured signature or clean filter programs', async t => {
  const { root, workspace, reader } = await repository(t);
  const marker = join(root, 'executed');
  const script = join(root, 'program.sh');
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
  git(root, 'config', 'gpg.program', script);
  git(root, 'config', 'log.showSignature', 'true');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const commit = `tree ${tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`;
  const hash = execFileSync('git', ['-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: commit, encoding: 'utf8' }).trim();
  await reader.log(workspace, { revision: hash });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  git(root, 'config', 'filter.custom.clean', script);
  git(root, 'config', 'filter.custom.required', 'true');
  await writeFile(join(root, '.gitattributes'), '*.js filter=custom\n');
  await writeFile(join(root, 'src/app.js'), 'export const value = 5;\n');
  assert.match((await reader.diff(workspace, { base: 'HEAD', target: 'WORKTREE' })).text, /value = 5/);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('large directory listings fit the capability transport and advertise truncation', async t => {
  const { root, workspace } = await fixture(t);
  await Promise.all(Array.from({ length: 2000 }, (_, index) =>
    writeFile(join(root, `${String(index).padStart(4, '0')}${'x'.repeat(245)}.js`), '')));
  const result = await workspace.list();
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
  assert.equal(result.truncated, true);
});

test('reading a FIFO rejects promptly instead of blocking plugin shutdown', async t => {
  const { root, workspace } = await fixture(t);
  execFileSync('mkfifo', [join(root, 'blocked.js')]);
  await assert.rejects(workspace.read({ path: 'blocked.js' }), /文本文件/);
});

test('cancels only owned live Git children and enforces diff output limits', async t => {
  const { root, workspace, reader } = await repository(t);
  const controller = new AbortController();
  const waiting = reader.run(workspace, ['hash-object', '--stdin'], controller.signal);
  assert.equal(reader.children.size, 1);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(reader.children.size, 0);
  await writeFile(join(root, 'src/app.js'), `${'changed\n'.repeat(30000)}`);
  await assert.rejects(reader.diff(workspace, { base: 'HEAD', target: 'WORKTREE' }), /输出过大/);
  const stopped = reader.run(workspace, ['hash-object', '--stdin']);
  const rejection = assert.rejects(stopped, /已停止/);
  await reader.stop();
  await rejection;
  assert.equal(reader.children.size, 0);
});
