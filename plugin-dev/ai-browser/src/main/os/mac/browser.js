import { spawn } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function createBrowserPlatform({ ownProcesses }) {
  const active = new Set();
  const report = () => ownProcesses([...active].map(process => process.child.pid));
  // Both installer and browser groups belong to the current plugin instance.
  const spawnTask = (executable, args, env = process.env) => {
    const child = spawn(executable, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const owned = { child, exited: false };
    const done = new Promise(resolve => {
      const finish = () => {
        owned.exited = true;
        active.delete(owned);
        report();
        resolve();
      };
      child.once('error', error => { owned.error = error; finish(); });
      child.once('exit', finish);
    });
    if (child.pid) {
      active.add(owned);
      report();
    }
    const close = async () => {
      if (owned.exited) {
        return;
      }
      const kill = signal => {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') {
            throw error;
          }
        }
      };
      kill('SIGTERM');
      await Promise.race([done, delay(2000)]);
      if (!owned.exited) {
        kill('SIGKILL');
        await done;
      }
    };
    return Object.assign(owned, { done, close });
  };
  return {
    spawnTask,
    async chromePath() {
      for (const root of ['/Applications', join(homedir(), 'Applications')]) {
        const path = join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome');
        if (await access(path).then(() => true, () => false)) {
          return path;
        }
      }
      return null;
    },
    async launch({ executable, profile }) {
      const portFile = join(profile, 'DevToolsActivePort');
      await rm(portFile, { force: true });
      const owned = spawnTask(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
        '--disable-background-mode', 'about:blank']);
      owned.child.stdout.resume();
      owned.child.stderr.resume();
      try {
        const deadline = Date.now() + 12000;
        while (!owned.exited && Date.now() < deadline) {
          const [port, path] = (await readFile(portFile, 'utf8').catch(error => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
            return '';
          })).trim().split('\n');
          if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) {
            return { endpoint: `ws://127.0.0.1:${port}${path}`, close: owned.close, done: owned.done };
          }
          await delay(60);
        }
        throw owned.error || Error('浏览器启动超时，请重试');
      } catch (error) {
        await owned.close();
        throw error;
      }
    }
  };
}
