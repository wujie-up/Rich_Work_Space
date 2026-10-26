import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
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
