import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Zombies have already exited and can only be reaped by their parent, not by another signal.
async function liveProcessGroups() {
  const { stdout } = await execute('ps', ['-axo', 'pgid=,stat='], { maxBuffer: 4 * 1024 * 1024 });
  return new Set(stdout.trim().split('\n').map(line => line.trim().split(/\s+/))
    .filter(([, state]) => state && !state.startsWith('Z')).map(([pid]) => Number(pid)));
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') {
      return;
    }
    error.message = `进程组 ${pid}：${error.message}`;
    throw error;
  }
}

// Reap only process groups registered by the failed live plugin instance.
export async function stopProcessGroups(pids) {
  const results = await Promise.allSettled(pids.map(async pid => {
    try {
      signalGroup(pid, 'SIGTERM');
    } finally {
      // A failed graceful signal must not prevent escalation for this group or cleanup of the others.
      await delay(100);
      signalGroup(pid, 'SIGKILL');
    }
  }));
  let remaining = [...pids];
  const deadline = Date.now() + 1800;
  while (remaining.length) {
    const live = await liveProcessGroups();
    remaining = remaining.filter(pid => live.has(pid));
    if (!remaining.length || Date.now() >= deadline) {
      break;
    }
    await delay(25);
  }
  // macOS also returns EPERM while a killed process is still exiting; verify its group before dismissing that error.
  const errors = results.filter((result, index) => result.status === 'rejected'
    && (result.reason.code !== 'EPERM' || remaining.includes(pids[index]))).map(result => result.reason);
  if (remaining.length) {
    errors.push(Error(`进程组尚未退出：${remaining.join(', ')}`));
  }
  if (errors.length) {
    throw new AggregateError(errors, errors.map(error => error.message).join('；'));
  }
}
