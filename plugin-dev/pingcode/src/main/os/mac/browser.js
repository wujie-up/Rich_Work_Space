import { access, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function createBrowserPlatform({ ownProcesses = () => {} } = {}) {
  const active = new Set();
  const report = () => ownProcesses([...active].map(child => child.pid).filter(Number.isInteger));
  return {
    async launch(profile) {
      const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
      let executable;
      for (const candidate of candidates) {
        if (await access(candidate).then(() => true, () => false)) {
          executable = candidate;
          break;
        }
      }
      if (!executable) {
        throw Error('网页登录需要 Google Chrome，请先安装后重试');
      }
      const portFile = join(profile, 'DevToolsActivePort');
      await rm(portFile, { force: true });
      const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
        '--disable-background-mode', 'about:blank'], { detached: true, stdio: 'ignore' });
      let exited = false;
      let exitError = false;
      child.once('error', () => { exitError = true; });
      const done = new Promise(resolve => child.once('exit', () => {
        exited = true;
        active.delete(child);
        report();
        resolve();
      }));
      if (child.pid) {
        active.add(child);
        report();
      }
      const close = async () => {
        if (!exited && child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch (error) {
            if (error.code !== 'ESRCH') {
              throw Error('无法关闭本次 PingCode 登录窗口');
            }
          }
          let timer;
          await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
          clearTimeout(timer);
          if (!exited) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch (error) {
              if (error.code !== 'ESRCH') {
                throw Error('无法清理本次 PingCode 登录进程');
              }
            }
            await done;
          }
        }
      };
      try {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && !exited && !exitError) {
          const text = await readFile(portFile, 'utf8').catch(() => '');
          const [port, path] = text.trim().split('\n');
          if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) {
            return { endpoint: `ws://127.0.0.1:${port}${path}`, close, done };
          }
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        throw Error('无法启动独立登录窗口，请关闭本插件残留的登录窗口后重试');
      } catch (error) {
        await close();
        throw error;
      }
    }
  };
}
