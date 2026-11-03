import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workspace } from '../src/main/common/workspace.js';
import { GitManager } from '../src/main/common/git-manager.js';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'coding-git 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'file.txt'), 'first\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'first');
  const manager = new GitManager();
  t.after(() => manager.stop());
  const workspace = await Workspace.open(root);
  return { root, workspace, manager, run: input => run(manager, workspace, input) };
}
async function run(manager, workspace, input) {
  const started = await manager.start(workspace, input);
  return manager.wait(started.id);

}
const success = task => assert.equal(task.state, 'succeeded', JSON.stringify(task));

test('Git manager supports status, branch lifecycle and literal file staging/commit', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  await mkdir(join(root, 'nested'));
  assert.equal(await manager.repository(await Workspace.open(join(root, 'nested'))), await manager.repository(workspace));
  success(await run({ action: 'createBranch', newBranch: 'feature/demo' }));
  assert.equal((await manager.status(workspace)).current, 'feature/demo');
  await writeFile(join(root, '-odd.txt'), 'odd');
  success(await run({ action: 'stage', paths: ['-odd.txt'] }));
  assert.equal((await manager.status(workspace)).files.find(file => file.path === '-odd.txt').index, 'A');
  success(await run({ action: 'unstage', paths: ['-odd.txt'] }));
  assert.equal((await manager.status(workspace)).files.find(file => file.path === '-odd.txt').index, '?');
  success(await run({ action: 'stage', all: true }));
  success(await run({ action: 'commit', message: 'odd file' }));
  success(await run({ action: 'renameBranch', branch: 'feature/demo', newBranch: 'feature/renamed' }));
  success(await run({ action: 'switch', branch: 'main' }));
  assert.equal((await run({ action: 'deleteBranch', branch: 'feature/renamed' })).state, 'failed');
  success(await run({ action: 'merge', revision: 'feature/renamed' }));
  success(await run({ action: 'deleteBranch', branch: 'feature/renamed' }));
});

test('Git manager supports stash, discard, reset modes and revert', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  await writeFile(join(root, 'file.txt'), 'changed\n');
  await writeFile(join(root, 'untracked.txt'), 'new');
  success(await run({ action: 'stashSave', message: 'saved', includeUntracked: true }));
  assert.equal((await manager.status(workspace)).stashes.length, 1);
  success(await run({ action: 'stashApply', stash: 'stash@{0}' }));
  await assert.rejects(manager.start(workspace, { action: 'discard', paths: ['file.txt'] }), /确认/);
  success(await run({ action: 'discard', paths: ['file.txt'], confirmed: true }));
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'first\n');
  success(await run({ action: 'stashDrop', stash: 'stash@{0}', confirmed: true }));
  await rm(join(root, 'untracked.txt'));
  await writeFile(join(root, 'file.txt'), 'second\n');
  success(await run({ action: 'stage', all: true }));
  success(await run({ action: 'commit', message: 'second' }));
  success(await run({ action: 'revert', revision: 'HEAD' }));
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'first\n');
  success(await run({ action: 'reset', revision: 'HEAD~1', mode: 'soft' }));
  assert.equal((await manager.status(workspace)).files[0].index, 'M');
  success(await run({ action: 'reset', revision: 'HEAD', mode: 'mixed' }));
  assert.equal((await manager.status(workspace)).files[0].worktree, 'M');
  success(await run({ action: 'reset', revision: 'HEAD', mode: 'hard', confirmed: true }));
  assert.equal((await manager.status(workspace)).files.length, 0);
});

test('Git merge conflicts expose paths and support abort and staged continue', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  git(root, 'checkout', '-qb', 'other');
  await writeFile(join(root, 'file.txt'), 'other\n');
  git(root, 'commit', '-qam', 'other');
  git(root, 'checkout', '-q', 'main');
  await writeFile(join(root, 'file.txt'), 'main\n');
  git(root, 'commit', '-qam', 'main');
  assert.equal((await run({ action: 'merge', revision: 'other' })).state, 'conflicted');
  const state = await manager.status(workspace);
  assert.equal(state.operation, 'merge');
  assert.equal(state.files[0].conflict, true);
  success(await run({ action: 'abort' }));
  assert.equal((await manager.status(workspace)).operation, null);
  assert.equal((await run({ action: 'merge', revision: 'other' })).state, 'conflicted');
  await writeFile(join(root, 'file.txt'), 'resolved\n');
  success(await run({ action: 'stage', all: true }));
  success(await run({ action: 'continue' }));
  assert.equal((await manager.status(workspace)).operation, null);
});

test('Git network operations use local remotes, upstream tracking and reject non-fast-forward updates', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  const remote = join(root, '.git', 'remote.git');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'remote', 'add', 'origin', remote);
  success(await run({ action: 'push', remote: 'origin' }));
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
  success(await run({ action: 'fetch', remote: 'origin' }));
  success(await run({ action: 'pull', remote: 'origin' }));
  const peer = join(root, '.git', 'peer');
  git(root, 'clone', '-q', '--branch', 'main', remote, peer);
  git(peer, 'config', 'user.name', 'Peer');
  git(peer, 'config', 'user.email', 'peer@example.invalid');
  await writeFile(join(peer, 'peer.txt'), 'remote');
  git(peer, 'add', '.');
  git(peer, 'commit', '-qm', 'remote');
  git(peer, 'push', '-q', 'origin', 'main');
  await writeFile(join(root, 'local.txt'), 'local');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'local');
  assert.equal((await run({ action: 'pull', remote: 'origin' })).state, 'failed');
  assert.equal((await run({ action: 'push', remote: 'origin' })).state, 'failed');
  success(await run({ action: 'pull', remote: 'origin', pullMode: 'rebase' }));
  success(await run({ action: 'push', remote: 'origin' }));
  success(await run({ action: 'createBranch', newBranch: 'feature' }));
  git(root, 'branch', '--set-upstream-to=origin/main', 'feature');
  await writeFile(join(root, 'feature.txt'), 'feature');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'feature');
  success(await run({ action: 'push', remote: 'origin' }));
  assert.equal(git(remote, 'rev-parse', 'main'), git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
  success(await run({ action: 'pull', remote: 'origin' }));
  await assert.rejects(manager.start(workspace, { action: 'fetch', remote: '-x' }), /远程/);
  await assert.rejects(manager.start(workspace, { action: 'reset', mode: 'hard', revision: 'HEAD' }), /确认/);
  await assert.rejects(manager.start(workspace, { action: 'stage', paths: ['../escape'] }), /路径/);
  await assert.rejects(manager.start(workspace, { action: 'createBranch', newBranch: '--orphan' }), /分支/);
});

test('Git updates and pushes a selected local branch without switching the worktree', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  const remote = join(root, '.git', 'remote.git');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'branch', 'selected');
  success(await run({ action: 'push', remote: 'origin', localBranch: 'selected' }));
  assert.equal(git(remote, 'rev-parse', 'selected'), git(root, 'rev-parse', 'selected'));
  const peer = join(root, '.git', 'peer');
  git(root, 'clone', '-q', '--branch', 'selected', remote, peer);
  git(peer, 'config', 'user.name', 'Peer');
  git(peer, 'config', 'user.email', 'peer@example.invalid');
  await writeFile(join(peer, 'peer.txt'), 'remote');
  git(peer, 'add', '.');
  git(peer, 'commit', '-qm', 'remote');
  git(peer, 'push', '-q', 'origin', 'selected');
  await writeFile(join(root, 'file.txt'), 'unsaved worktree');
  success(await run({ action: 'pull', remote: 'origin', localBranch: 'selected', branch: 'selected' }));
  assert.equal(git(root, 'rev-parse', 'selected'), git(peer, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'unsaved worktree');
  git(root, 'update-ref', 'refs/heads/selected', 'main');
  assert.equal((await run({ action: 'push', remote: 'origin', localBranch: 'selected' })).state, 'failed');
  git(root, 'commit', '--allow-empty', '-qm', 'local divergence');
  git(root, 'update-ref', 'refs/heads/selected', 'main');
  assert.equal((await run({ action: 'pull', remote: 'origin', localBranch: 'selected', branch: 'selected' })).state, 'failed');
  git(root, 'worktree', 'add', '-q', join(root, '.git', 'selected-worktree'), 'selected');
  assert.equal((await run({ action: 'pull', remote: 'origin', localBranch: 'selected', branch: 'selected' })).state, 'failed');
  await assert.rejects(manager.command(workspace, { action: 'push', remote: 'origin', localBranch: 'missing' }), /本地分支/);
});


test('Git supports cherry-pick, rebase and stash pop', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  git(root, 'checkout', '-qb', 'other');
  await writeFile(join(root, 'other.txt'), 'other');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'other');
  const picked = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  success(await run({ action: 'cherryPick', revision: picked }));
  assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other');
  success(await run({ action: 'rebase', revision: 'other' }));
  await writeFile(join(root, 'file.txt'), 'stash');
  success(await run({ action: 'stashSave' }));
  success(await run({ action: 'stashPop', stash: 'stash@{0}' }));
  assert.equal((await manager.status(workspace)).stashes.length, 0);
});

test('Git cancellation owns hook processes and rejects concurrent work', async t => {
  const { root, workspace, manager } = await fixture(t);
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf "https://user:"\nsleep 0.1\nprintf "secret@example.invalid/path\\n"\nsleep 30\n');
  await chmod(hook, 0o755);
  await writeFile(join(root, 'file.txt'), 'changed');
  git(root, 'add', '.');
  let ownedPid;
  manager.report = pids => {
    if (manager.snapshot()?.state === 'running' && pids.length) {
      ownedPid = pids.at(-1);
    }
  };
  const task = await manager.start(workspace, { action: 'commit', message: 'blocked' });
  await assert.rejects(manager.start(workspace, { action: 'fetch', remote: 'origin' }), /正在执行/);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.doesNotMatch(manager.snapshot().log, /user|secret/);
  const cancelled = await manager.cancel(task.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.throws(() => process.kill(-ownedPid, 0), { code: 'ESRCH' });
  assert.doesNotMatch(cancelled.log, /user|secret/);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'first');
  assert.equal((await manager.wait(task.id)).state, 'cancelled');
  await assert.rejects(manager.cancel('unknown'), /不存在/);
});

test('Git bounded execution times out a blocking hook and retains bounded output', async t => {
  const { root, workspace } = await fixture(t);
  const manager = new GitManager(() => {}, { timeoutMs: 100 });
  t.after(() => manager.stop());
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nyes output | head -c 200000\nsleep 30\n');
  await chmod(hook, 0o755);
  await writeFile(join(root, 'file.txt'), 'changed');
  git(root, 'add', '.');
  const result = await run(manager, workspace, { action: 'commit', message: 'timeout' });
  assert.equal(result.state, 'failed');
  assert.match(result.error, /超时/);
  assert.ok(Buffer.byteLength(result.log) <= 128 * 1024);
});

test('Git log redaction holds incomplete output until credentials cannot cross chunk boundaries', async t => {
  const manager = new GitManager();
  t.after(() => manager.stop());
  const job = { result: { log: '', truncated: false } };
  manager.append(job, 'https://user:');
  assert.doesNotMatch(job.result.log, /user/);
  manager.append(job, 'secret@example.invalid/path\n');
  assert.doesNotMatch(job.result.log, /secret|user/);
  assert.match(job.result.log, /redacted/);
  manager.append(job, 'output\n'.repeat(30000));
  assert.equal(job.result.truncated, true);
  assert.ok(Buffer.byteLength(job.result.log) <= 128 * 1024);
});

test('Git unstage includes both rename endpoints so a later commit cannot retain a deletion', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  git(root, 'mv', 'file.txt', 'renamed.txt');
  const renamed = (await manager.status(workspace)).files.find(file => file.path === 'renamed.txt');
  assert.equal(renamed.originalPath, 'file.txt');
  success(await run({ action: 'stage', paths: ['renamed.txt'] }));
  success(await run({ action: 'unstage', paths: ['renamed.txt'] }));
  assert.equal(git(root, 'diff', '--cached', '--name-status'), '');
  assert.equal(await readFile(join(root, 'renamed.txt'), 'utf8'), 'first\n');
});

// Recent branches come from Git history, so reopening the plugin needs no duplicate state.
test('Git status returns recent existing branches in checkout order', async t => {
  const { root, workspace, manager } = await fixture(t);
  git(root, 'switch', '-qc', 'feature/recent');
  git(root, 'switch', '-q', 'main');
  git(root, 'switch', '-qc', 'temporary');
  git(root, 'switch', '-q', 'main');
  git(root, 'branch', '-D', 'temporary');
  assert.deepEqual((await manager.status(workspace)).recent, ['main', 'feature/recent']);
});

test('Git status and checkout remain available on an unborn orphan branch with existing reflog', async t => {
  const { root, workspace, manager, run } = await fixture(t);
  git(root, 'switch', '--orphan', 'empty');
  assert.equal((await manager.status(workspace)).current, 'empty');
  success(await run({ action: 'switch', branch: 'main' }));
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('push preview lists outgoing committed files and follows the actual destination', async t => {
  const { root, workspace, manager } = await fixture(t);
  const remote = join(root, '.git', 'preview-remote.git');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'remote', 'add', 'origin', remote);
  assert.deepEqual((await manager.pushPreview(workspace, { remote: 'origin' })).files, [{ status: 'A', path: 'file.txt' }]);
  git(root, 'push', '-qu', 'origin', 'main:published');
  await writeFile(join(root, 'file.txt'), 'changed\n');
  await writeFile(join(root, 'added.txt'), 'added\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'outgoing');
  await writeFile(join(root, 'uncommitted.txt'), 'not outgoing\n');
  const preview = await manager.pushPreview(workspace, { remote: 'origin', localBranch: 'main' });
  assert.equal(preview.destination, 'origin/published');
  assert.deepEqual(preview.files, [{ status: 'A', path: 'added.txt' }, { status: 'M', path: 'file.txt' }]);
});
