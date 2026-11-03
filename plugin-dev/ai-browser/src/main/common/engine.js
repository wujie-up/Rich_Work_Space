import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { logError } from './log.js';

export class EngineStore {
  constructor({ root, platform, chromium }) {
    Object.assign(this, { root, platform, chromium });
    this.installation = { state: 'idle' };
  }

  async settings() {
    try {
      return JSON.parse(await readFile(join(this.root, 'settings.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return { engine: 'chromium' };
    }
  }

  async save({ engine }) {
    if (!['chromium', 'chrome'].includes(engine)) {
      throw Error('不支持此浏览器内核');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, 'settings.json');
    await writeFile(`${target}.tmp`, JSON.stringify({ engine }), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
    return this.status();
  }

  async executable() {
    const { engine } = await this.settings();
    return engine === 'chrome' ? this.platform.chromePath() : this.chromium.executablePath();
  }

  async status() {
    const executable = await this.executable();
    const ready = Boolean(executable && await access(executable).then(() => true, () => false));
    const { engine } = await this.settings();
    return { engine, ready, installation: this.installation };
  }

  async install() {
    if (this.installation.state === 'running') {
      return this.status();
    }
    const cli = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: join(this.root, 'engines'),
      PLAYWRIGHT_SKIP_BROWSER_GC: '1' };
    this.installation = { state: 'running' };
    let owned;
    try {
      owned = this.platform.spawnTask(process.execPath, [cli, 'install', 'chromium', '--no-shell'], env);
    } catch (error) {
      this.installation = { state: 'failed', error: '此平台无法启动内核安装' };
      logError('installer startup failed', error);
      throw error;
    }
    this.installer = owned;
    owned.child.stderr.resume();
    owned.child.stdout.resume();
    owned.done.then(async () => {
      if (this.installer !== owned) {
        return;
      }
      this.installer = null;
      const ok = owned.child.exitCode === 0 && await access(this.chromium.executablePath()).then(() => true, () => false);
      this.installation = ok ? { state: 'succeeded' } : { state: 'failed', error: 'Chromium 安装失败，请检查网络后重试' };
      if (ok) {
        console.info('[ai-browser] Chromium installed');
      } else {
        console.error('[ai-browser] Chromium installation failed', owned.error || Error(`exitCode=${owned.child.exitCode}`));
      }
    });
    return this.status();
  }

  async stop() {
    const installer = this.installer;
    this.installer = null;
    await installer?.close();
    if (this.installation.state === 'running') {
      this.installation = { state: 'cancelled' };
    }
  }
}
