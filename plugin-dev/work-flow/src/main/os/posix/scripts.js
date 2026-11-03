import { fileURLToPath } from 'node:url';

export const supervisorPath = fileURLToPath(new URL('./supervisor.cjs', import.meta.url));
export const spawnOptions = { detached: true };

// Only the process group created for this invocation is signalled; PIDs are never loaded from disk.
export function terminateScript(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}
