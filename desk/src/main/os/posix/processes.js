import { setTimeout as delay } from 'node:timers/promises';

// Reap only process groups registered by the failed live plugin instance.
export async function stopProcessGroups(pids) {
  const signal = (pid, value) => {
    try {
      process.kill(-pid, value);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
      return false;
    }
  };
  for (const pid of pids) {
    signal(pid, 'SIGTERM');
  }
  if (pids.length) {
    await delay(100);
  }
  for (const pid of pids) {
    signal(pid, 'SIGKILL');
  }
}
