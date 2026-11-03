import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { readGit, switchGitBranch } from '../src/main/common/git.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';
import { Sessions } from '../src/main/common/sessions.js';

test('Git handles non repository, branch switch, detached HEAD and refuses conflicts', async (t) => {
  const store = await temporaryStore(t);
  assert.equal(await readGit(store.root), null);
  const git = (...args) => execFileSync('git', ['-C', store.root, ...args]);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Desk Test');
  git('config', 'user.email', 'desk@example.invalid');
  await writeFile(`${store.root}/file`, 'one');
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('checkout', '-b', 'other');
  await writeFile(`${store.root}/file`, 'two');
  git('commit', '-am', 'other');
  await switchGitBranch(store.root, 'main');
  await writeFile(`${store.root}/file`, 'uncommitted');
  await assert.rejects(switchGitBranch(store.root, 'other'), /切换失败/);
  assert.equal(await readFile(`${store.root}/file`, 'utf8'), 'uncommitted');
  git('checkout', '--detach');
  assert.equal((await readGit(store.root)).detached, true);
});

test('Git branch switch checks every owner in the canonical worktree and refreshes all peers', async (t) => {
  const store = await temporaryStore(t);
  const git = (...args) => execFileSync('git', ['-C', store.root, ...args]);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Desk Test');
  git('config', 'user.email', 'desk@example.invalid');
  git('commit', '--allow-empty', '-m', 'fixture');
  git('branch', 'other');
  const pty = fakePty();
  const sessions = new Sessions({ storage: store, spawn: pty.spawn, guard: (_, work) => work(),
    adapter: () => ({ buildLaunch: () => ({ command: '/bin/cat', args: [] }) }),
    processControl: async (session) => session.terminal.kill() });
  const first = await sessions.create('owner-a', { adapterId: 'test', cwd: store.root });
  const second = await sessions.create('owner-b', { adapterId: 'test', cwd: store.root });
  const a = sessions.get('owner-a', first.id);
  const b = sessions.get('owner-b', second.id);
  a.activity = 'idle';
  for (const activity of ['unknown', 'working']) {
    b.activity = activity;
    await assert.rejects(sessions.switchBranch('owner-a', a.id, 'other'), { code: 'SESSION_BUSY' });
  }
  b.activity = 'idle';
  b.blocked = 'permission';
  await assert.rejects(sessions.switchBranch('owner-a', a.id, 'other'), { code: 'SESSION_BUSY' });
  b.blocked = null;
  b.lastInputAt = Date.now();
  await assert.rejects(sessions.switchBranch('owner-a', a.id, 'other'), { code: 'SESSION_BUSY' });
  assert.equal((await readGit(store.root)).branch, 'main');
  b.lastInputAt = 0;
  sessions.launching = 1;
  await assert.rejects(sessions.switchBranch('owner-a', a.id, 'other'), { code: 'GIT_BUSY' });
  sessions.launching = 0;
  sessions.gitSwitches.add(a.git.root);
  assert.throws(() => sessions.write('owner-b', b.id, 'input'), { code: 'SESSION_BUSY' });
  await assert.rejects(sessions.create('owner-b', { adapterId: 'test', cwd: store.root }), { code: 'GIT_BUSY' });
  sessions.gitSwitches.clear();
  await sessions.switchBranch('owner-a', a.id, 'other');
  assert.equal(a.git.branch, 'other');
  assert.equal(b.git.branch, 'other');
  await sessions.stopAndArchive('owner-a', 'test');
  await sessions.stopAndArchive('owner-b', 'test');
});

test('Git refresh discovers new remote branches without changing the worktree and retains the list on failure', async t => {
  const store = await temporaryStore(t);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
  const remote = `${store.root}/remote.git`;
  const seed = `${store.root}/seed`;
  const work = `${store.root}/work`;
  await mkdir(seed);
  git(store.root, 'init', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'Desk Test');
  git(seed, 'config', 'user.email', 'desk@example.invalid');
  git(seed, 'commit', '--allow-empty', '-m', 'fixture');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main');
  git(seed, 'branch', 'feature/obsolete');
  git(seed, 'push', 'origin', 'feature/obsolete');
  git(store.root, 'clone', remote, work);
  const pty = fakePty();
  const sessions = new Sessions({ storage: store, spawn: pty.spawn, guard: (_, work) => work(),
    adapter: () => ({ buildLaunch: () => ({ command: '/bin/cat', args: [] }) }),
    processControl: async session => session.terminal.kill() });
  t.after(() => sessions.stopAndArchive('owner', 'test'));
  const created = await sessions.create('owner', { adapterId: 'test', cwd: work });
  const session = sessions.get('owner', created.id);
  session.activity = 'idle';
  git(seed, 'branch', 'feature/latest');
  git(seed, 'push', 'origin', 'feature/latest');
  git(seed, 'push', 'origin', '--delete', 'feature/obsolete');
  await writeFile(`${work}/draft.txt`, 'keep local changes');
  assert.deepEqual((await sessions.gitInfo('owner', created.id)).branches, ['feature/obsolete', 'main']);
  const info = await sessions.refreshGit('owner', created.id);
  assert.deepEqual(info.branches, ['feature/latest', 'main']);
  assert.equal(info.branch, 'main');
  assert.equal(git(work, 'branch', '--show-current'), 'main');
  assert.equal(await readFile(`${work}/draft.txt`, 'utf8'), 'keep local changes');
  await sessions.switchBranch('owner', created.id, 'feature/latest');
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/latest');
  git(work, 'remote', 'set-url', 'origin', `${store.root}/missing.git`);
  const previous = session.git;
  await assert.rejects(sessions.refreshGit('owner', created.id), /刷新失败/);
  assert.deepEqual(session.git, previous);
  git(work, 'remote', 'remove', 'origin');
  assert.deepEqual((await sessions.refreshGit('owner', created.id)).branches, ['feature/latest', 'main']);
});
