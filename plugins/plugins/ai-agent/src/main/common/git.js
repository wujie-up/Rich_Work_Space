import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execute('git', ['-C', cwd, ...args], {
    timeout: 4000, maxBuffer: 1024 * 1024,
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
  const [canonicalRoot, branch, refs] = await Promise.all([
    realpath(root),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch((error) => {
      if (error.code === 1) {
        return null;
      }
      throw error;
    }),
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])
  ]);
  return {
    root: canonicalRoot, branch, detached: branch === null,
    commit: branch === null ? await git(root, ['rev-parse', '--short', 'HEAD']) : null,
    branches: refs ? refs.split('\n').map((ref) => ref.slice('refs/heads/'.length)) : []
  };
}

export async function switchGitBranch(root, branch) {
  try {
    // Ordinary switch preserves edits and rejects branches already checked out in another worktree.
    await git(root, ['switch', '--no-guess', '--', branch]);
  } catch (error) {
    throw new Error(`切换失败：${(error.stderr || error.message).trim().slice(0, 1000)}`);
  }
}
