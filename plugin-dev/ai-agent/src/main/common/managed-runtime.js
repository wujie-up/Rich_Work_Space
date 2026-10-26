import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, stat, chmod, statfs, copyFile } from 'node:fs/promises';
import { join, posix, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppServer } from './app-server.js';
import { ENGINE_PIN } from './engine-pin.js';
import { managedPlatform, downloadEngine, engineNetworkEnvironment } from '../os/index.js';

const execute = promisify(execFile);
export function isolatedEnvironment(profile) {
  return { HOME: join(profile, 'home'), CODEX_HOME: join(profile, 'codex'), CLAUDE_CONFIG_DIR: join(profile, 'claude'),
    XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache'), XDG_DATA_HOME: join(profile, 'data'),
    TMPDIR: join(profile, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', RUST_LOG: 'warn,codex_core::session=info' };
}

export async function prepareProfile(profile) {
  const env = isolatedEnvironment(profile);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  await Promise.all(Object.entries(env).filter(([key]) => key.endsWith('HOME') || key === 'TMPDIR' || key === 'CLAUDE_CONFIG_DIR')
    .map(([, path]) => mkdir(path, { recursive: true, mode: 0o700 })));
  return env;
}

export const managedArgs = ['-c', 'cli_auth_credentials_store="file"', '-c', 'shell_environment_policy.inherit="none"'];

async function probeNative(command, pin, profile) {
  const env = await prepareProfile(profile);
  const { stdout } = await execute(command, ['--version'], { env, timeout: 15000 });
  if (!(pin.format === 'binary' ? stdout.trim() === `${pin.version} (Claude Code)` : stdout.trim() === `codex-cli ${pin.version}`)) {
    throw Error('引擎版本不匹配');
  }
  if (pin.format === 'binary') {
    try {
      await execute(command, ['auth', 'status'], { env, timeout: 15000 });
      throw Error('隔离验证失败：全新运行空间意外存在登录状态');
    } catch (error) {
      if (error.code !== 1 || JSON.parse(error.stdout || '{}').loggedIn !== false) { throw error; }
    }
    return;
  }
  const server = new AppServer();
  try {
    await server.start({ command, args: managedArgs, env, cwd: profile });
    const account = await server.request('account/read', { refreshToken: false });
    if (account.account !== null) {
      throw Error('隔离验证失败：全新运行空间意外存在登录状态');
    }
  } finally {
    server.close();
  }
}

export class ManagedRuntime {
  constructor(options) {
    Object.assign(this, options);
    this.pin ||= ENGINE_PIN;
    this.probe ||= probeNative;
  }

  async status() {
    try {
      const index = JSON.parse(await readFile(join(this.root, 'runtimes', 'index.json'), 'utf8'));
      const command = join(this.root, 'runtimes', index.runtimeId, index.entry);
      if (index.runtimeId !== this.pin.runtimeId || index.sha256 !== this.pin.sha256 || !(await stat(command)).isFile()) {
        throw Error('引擎记录损坏');
      }
      return { ...index, state: 'ready', command, pin: this.pin };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return { state: 'broken', error: error.message, pin: this.pin };
      }
      return { state: 'missing', pin: this.pin };
    }
  }

  install(archive) {
    if (!this.installing) {
      this.installing = this.installTransaction(archive).finally(() => { this.installing = null; });
    }
    return this.installing;
  }

  async installTransaction(archive) {
    if ([ENGINE_PIN.platform, 'darwin-arm64'].includes(this.pin.platform) && managedPlatform !== this.pin.platform) {
      throw Error('受管引擎当前仅验证 macOS Apple Silicon');
    }
    const runtimes = join(this.root, 'runtimes');
    const staging = join(runtimes, `.staging-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const download = join(staging, 'download.tar.gz');
    try {
      const space = await statfs(staging);
      if (this.pin.requiredBytes && space.bavail * space.bsize < this.pin.requiredBytes) {
        throw Error('安装引擎所需磁盘空间不足');
      }
      if (!archive) {
        await downloadEngine(this.pin.url, download);
        archive = download;
      }
      const kind = await this.verifyArchive(archive);
      const payload = join(staging, 'payload');
      await mkdir(payload, { mode: 0o700 });
      if (kind === 'binary') {
        await mkdir(dirname(join(payload, this.pin.entry)), { recursive: true });
        await copyFile(archive, join(payload, this.pin.entry));
      } else {
        await this.tar.x({ file: archive, cwd: payload, strict: true, preserveOwner: false, noChmod: false });
      }
      const command = join(payload, this.pin.entry);
      if (this.pin.format === 'binary' && await this.digest(command) !== this.pin.sha256) {
        throw Error('引擎入口 SHA-256 校验失败');
      }
      await chmod(command, 0o700);
      await this.probe(command, this.pin, join(staging, 'probe-profile'));
      const target = join(runtimes, this.pin.runtimeId);
      // A fixed version is immutable: successful repeat imports reuse it, never replace an active runtime.
      const existing = await this.status();
      if (existing.state !== 'ready') {
        await rename(payload, target);
      }
      const index = { ...this.pin, installedAt: new Date().toISOString(), state: 'ready' };
      const next = join(staging, 'index.json');
      await writeFile(next, JSON.stringify(index, null, 2), { mode: 0o600 });
      await rename(next, join(runtimes, 'index.json'));
      console.info('[ai:runtime-ready]', { runtimeId: this.pin.runtimeId, version: this.pin.version });
      return this.status();
    } catch (error) {
      console.error('[ai:runtime-install-error]', { runtimeId: this.pin.runtimeId, message: error.message });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async digest(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) { hash.update(chunk); }
    return hash.digest('hex');
  }

  async verifyArchive(archive) {
    const digest = await this.digest(archive);
    if (this.pin.format === 'binary' && digest === this.pin.sha256) { return 'binary'; }
    if (this.pin.format !== 'binary' && digest !== this.pin.sha256) {
      throw Error('引擎包 SHA-256 校验失败');
    }
    let invalid;
    let bytes = 0;
    const paths = new Set();
    await this.tar.t({ file: archive, strict: true, onReadEntry: entry => {
      const path = entry.path.replace(/\/$/, '');
      bytes += entry.size || 0;
      if (!['File', 'Directory'].includes(entry.type) || path.startsWith('/') || path.includes('\\')
        || posix.normalize(path) !== path || path.split('/').includes('..') || paths.has(path) || bytes > 1024 * 1024 * 1024) {
        invalid = Error('引擎包包含不安全路径、链接或超大资源');
      }
      paths.add(path);
    } });
    if (invalid || !paths.has(this.pin.entry)) {
      throw invalid || Error('引擎包缺少入口');
    }
  }

  async launch(profileId = 'default') {
    const runtime = await this.status();
    if (runtime.state !== 'ready') {
      throw Error('请先在 AI 对话中安装受管引擎');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
      throw Error('无效运行配置 ID');
    }
    const profile = join(this.root, 'profiles', profileId);
    return { command: runtime.command, args: this.pin.format === 'binary' ? [] : [...managedArgs], env: { ...await prepareProfile(profile), ...await engineNetworkEnvironment() },
      runtimeId: runtime.runtimeId, runtimeVersion: runtime.version, profileId, isolated: true };
  }
}
