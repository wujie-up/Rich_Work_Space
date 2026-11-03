import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function git(cwd, args, timeout = 4000) {
  const { stdout } = await execute('git', ['-C', cwd, ...args], {
    timeout, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout.trim();
}

export async function readGit(cwd) {
  let root;
  try {
    root = await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if (error.code === 'ENOENT' || /not a git repository|must be run in a work tree/i.test(error.stderr || '')) {
      return null;
    }
    throw error;
  }
  const [canonicalRoot, branch, refs, remoteRefs] = await Promise.all([
    realpath(root),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch((error) => {
      if (error.code === 1) {
        return null;
      }
      throw error;
    }),
    git(root, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/']),
    git(root, ['for-each-ref', '--format=%(refname:strip=3)%00%(symref)', 'refs/remotes/'])
  ]);
  return {
    root: canonicalRoot, branch, detached: branch === null,
    commit: branch === null ? await git(root, ['rev-parse', '--short', 'HEAD']) : null,
    // Remote symbolic HEADs are aliases; merge actual branch names without duplicate local entries.
    branches: [...new Set([...(refs ? refs.split('\n') : []),
      ...(remoteRefs ? remoteRefs.split('\n').map(ref => ref.split('\0')).filter(([, target]) => !target).map(([name]) => name) : [])])].sort()
  };
}

export async function fetchGitBranches(root) {
  try {
    // Fetch references only; never pull, merge or overwrite the current worktree.
    await git(root, ['fetch', '--all', '--prune', '--no-tags'], 20000);
  } catch (error) {
    throw new Error(`刷新失败：${(error.stderr || error.message).trim().slice(0, 1000)}`);
  }
}

export async function switchGitBranch(root, branch) {
  try {
    // Ordinary switch preserves edits and rejects branches already checked out in another worktree.
    await git(root, ['switch', '--guess', '--', branch]);
  } catch (error) {
    throw new Error(`切换失败：${(error.stderr || error.message).trim().slice(0, 1000)}`);
  }
}
