import { setTimeout as delay } from 'node:timers/promises';

// Only live handles created by this host may be signalled; persisted PIDs are never reused.
export async function stopOwnedProcess(session) {
  if (!session.terminal) {
    return;
  }
  const exists = () => {
    try {
      process.kill(-session.pid, 0);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
      return false;
    }
  };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!exists() && session.exited) {
      return;
    }
    try {
      process.kill(-session.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      if (session.exited && !exists()) {
        return;
      }
      await delay(25);
    }
  }
  throw new Error('终端进程组尚未退出，请重试');
}
