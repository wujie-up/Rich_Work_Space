import { spawn } from 'node:child_process';

export function launch(command, args, cwd, env = process.env) {
  return spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
}

// A dedicated process group keeps task hooks, shells and compiler children under the same owner.
export function terminate(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}
