import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bundledExecutable = fileURLToPath(new URL('../../../../dist/assistant/Work Desk Assistant.app/Contents/MacOS/DeskLinkMac', import.meta.url));

export class MacAssistant {
  constructor(context, executable = bundledExecutable) {
    Object.assign(this, { context, executable });
    this.stopped = false;
  }

  get running() {
    return Boolean(this.child);
  }

  async open() {
    if (this.stopped) {
      throw Error('插件已停止，不能打开电脑助手');
    }
    if (this.child) {
      await this.started;
      return;
    }
    // A separate process group lets the host reap only this instance if the plugin crashes.
    const child = spawn(this.executable, [], { detached: true, stdio: 'ignore' });
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', (code, signal) => {
      this.child = null;
      try {
        this.context.ownProcesses([]);
        if (child.pid && !this.stopped && (code !== 0 || signal)) {
          console.error('[web-access:assistant-crashed]', { pluginId: this.context.pluginId, pid: child.pid, code, signal,
            stack: Error('电脑助手异常退出').stack });
        } else {
          console.info('[web-access:assistant-closed]', { pluginId: this.context.pluginId, pid: child.pid, code, signal });
        }
      } catch (error) {
        console.error('[web-access:assistant-process-report-failed]', { pluginId: this.context.pluginId, pid: child.pid, stack: error.stack });
      } finally {
        resolve();
      }
    }));
    this.started = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        try {
          this.context.ownProcesses([child.pid]);
          console.info('[web-access:assistant-opened]', { pluginId: this.context.pluginId, pid: child.pid });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    try {
      await this.started;
    } catch (error) {
      console.error('[web-access:assistant-open-failed]', { pluginId: this.context.pluginId, pid: child.pid, stack: error.stack });
      child.kill('SIGKILL');
      await this.exited;
      throw error;
    }
  }

  async stop() {
    // Block launches before awaiting a pending spawn; disabling must never leave a late child behind.
    this.stopped = true;
    const child = this.child;
    if (!child) {
      return;
    }
    try {
      await this.started;
      if (this.child !== child) {
        return;
      }
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      console.error('[web-access:assistant-stop-failed]', { pluginId: this.context.pluginId, pid: child.pid, stack: error.stack });
      child.kill('SIGKILL');
      await this.exited;
      throw error;
    }
  }
}
