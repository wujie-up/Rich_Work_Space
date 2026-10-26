import { mkdir, readFile, writeFile, rename, rm, cp, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ManagedRuntime } from './managed-runtime.js';
import { ENGINE_PIN, CLAUDE_PIN } from './engine-pin.js';
import { readLocalCredential } from '../os/index.js';

const execute = promisify(execFile);
const pins = { codex: ENGINE_PIN, claude: CLAUDE_PIN };
const names = { codex: 'Codex', claude: 'Claude Code' };

// Keep the original Codex directories and IDs so existing sessions need no migration.
export class EngineManager {
  constructor(options) {
    Object.assign(this, options);
    this.localHome ||= homedir();
    this.runtimes = new Map(Object.entries(pins).map(([id, pin]) => [id, new ManagedRuntime({
      root: id === 'codex' ? this.root : join(this.root, 'engines', id), tar: this.tar, pin
    })]));
    this.installations = new Map();
    this.sourceWrites = new Map();
  }

  runtime(id = 'codex') {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throw Error('不支持的引擎');
    }
    return runtime;
  }

  async config() {
    try {
      return { defaultEngine: 'codex', engines: {}, ...JSON.parse(await readFile(join(this.root, 'engines.json'), 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return { defaultEngine: 'codex', engines: {} };
    }
  }

  async configure(input) {
    this.runtime(input.defaultEngine);
    const config = await this.config();
    config.defaultEngine = input.defaultEngine;
    for (const [id, value] of Object.entries(input.engines || {})) {
      this.runtime(id);
      config.engines[id] = { reuseSkills: value.reuseSkills === true, reuseRules: value.reuseRules === true };
    }
    await this.writePrivate(join(this.root, 'engines.json'), JSON.stringify(config, null, 2));
    return config;
  }

  async list() {
    return Promise.all([...this.runtimes].map(async ([id, runtime]) => ({ id, name: names[id], ...await runtime.status(),
      installation: this.installations.get(id) || { state: 'idle' }, sources: this.sources(id) })));
  }

  install(id, archive) {
    const runtime = this.runtime(id);
    if (this.installations.get(id)?.state !== 'installing') {
      this.installations.set(id, { state: 'installing' });
      runtime.install(archive).then(() => this.installations.set(id, { state: 'complete' }), error => {
        this.installations.set(id, { state: 'failed', error: error.message });
      });
    }
    return this.installations.get(id);
  }

  async remove(id) {
    const runtime = this.runtime(id);
    if (runtime.installing) {
      throw Error('引擎安装中，请稍后再试');
    }
    await rm(join(runtime.root, 'runtimes'), { recursive: true, force: true });
    this.installations.delete(id);
    console.info('[ai:runtime-removed]', { engineId: id });
  }

  sources(id) {
    this.runtime(id);
    const directory = join(this.localHome, id === 'codex' ? '.codex' : '.claude');
    return { auth: join(directory, id === 'codex' ? 'auth.json' : '.credentials.json'),
      skills: [join(directory, 'skills'), ...(id === 'codex' ? [join(this.localHome, '.agents', 'skills')] : [])],
      rules: [join(directory, id === 'codex' ? 'AGENTS.md' : 'CLAUDE.md')], projectRules: '工作目录原生规范由对应引擎读取' };
  }

  async importAuth(id) {
    const runtime = this.runtime(id);
    const source = this.sources(id).auth;
    let value;
    try {
      value = await readFile(source, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      value = await readLocalCredential(id, dirname(source));
    }
    if (!value) {
      throw Error('未找到本机授权，请使用独立登录');
    }
    JSON.parse(value);
    const profile = join(runtime.root, 'profiles', 'default');
    const target = join(profile, id === 'codex' ? 'codex/auth.json' : 'claude/.credentials.json');
    await this.writePrivate(target, value);
    console.info('[ai:auth-imported]', { engineId: id, source: 'local', profileId: 'default' });
    return { imported: true, source: '本机授权副本', requiresRefresh: true };
  }

  async writePrivate(file, value) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const next = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(next, value, { mode: 0o600 });
      await rename(next, file);
    } finally {
      await rm(next, { force: true });
    }
  }

  // Synchronize only opted-in source files; never import native settings, hooks or MCP credentials.
  prepareSources(id, profile) {
    const previous = this.sourceWrites.get(profile) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.syncSources(id, profile));
    this.sourceWrites.set(profile, next);
    return next;
  }

  async syncSources(id, profile) {
    const config = (await this.config()).engines[id] || {};
    const sources = this.sources(id);
    const target = join(profile, id === 'codex' ? 'codex' : 'claude');
    const inventory = join(profile, 'local-sources.json');
    let previous = [];
    try {
      previous = JSON.parse(await readFile(inventory, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    for (const relative of previous) {
      if (!/^(skills\/local-[^/]+|AGENTS\.md|CLAUDE\.md)$/.test(relative)) {
        throw Error('本机资源同步记录损坏');
      }
      await rm(join(target, relative), { recursive: true, force: true });
    }
    const imported = [];
    if (config.reuseSkills) {
      for (const [index, source] of sources.skills.entries()) {
        const entries = await readdir(source).catch(error => {
          if (error.code === 'ENOENT') { return []; }
          throw error;
        });
        for (const name of entries.filter(name => !name.startsWith('.'))) {
          if (await stat(join(source, name, 'SKILL.md')).catch(error => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { return null; }
            throw error;
          })) {
            const relative = `skills/local-${index}-${name}`;
            if (!previous.includes(relative) && await stat(join(target, relative)).catch(error => {
              if (error.code === 'ENOENT') { return null; }
              throw error;
            })) { throw Error('本机技能导入位置已被占用'); }
            const staging = join(profile, `.skill-${randomUUID()}`);
            try {
              await cp(join(source, name), staging, { recursive: true, dereference: true });
              await mkdir(join(target, 'skills'), { recursive: true });
              await rename(staging, join(target, relative));
              imported.push(relative);
              await this.writePrivate(inventory, JSON.stringify([...new Set([...previous, ...imported])]));
            } finally {
              await rm(staging, { recursive: true, force: true });
            }
          }
        }
      }
    }
    if (config.reuseRules) {
      for (const source of sources.rules) {
        try {
          const relative = id === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
          const value = await readFile(source);
          if (!previous.includes(relative) && await stat(join(target, relative)).catch(error => {
            if (error.code === 'ENOENT') { return null; }
            throw error;
          })) { throw Error('独立空间已有规范，请先备份或关闭本机规范复用'); }
          await this.writePrivate(join(target, relative), value);
          imported.push(relative);
          await this.writePrivate(inventory, JSON.stringify([...new Set([...previous, ...imported])]));
        } catch (error) {
          if (error.code !== 'ENOENT') { throw error; }
        }
      }
    }
    await this.writePrivate(inventory, JSON.stringify(imported));
  }

  async account(method, params = {}) {
    const launch = await this.launch(undefined, 'claude');
    if (method === 'account/read') {
      let stdout;
      try {
        ({ stdout } = await execute(launch.command, ['auth', 'status'], { env: launch.env, timeout: 15000 }));
      } catch (error) {
        if (error.code !== 1) { throw Error('读取 Claude 登录状态失败'); }
        stdout = error.stdout;
      }
      const status = JSON.parse(stdout);
      return { account: status.loggedIn ? { type: status.authMethod, email: status.email, planType: status.subscriptionType } : null,
        login: this.loginState || { state: 'idle' } };
    }
    if (method === 'account/logout') {
      if (this.loginChild) { throw Error('请先取消登录'); }
      await execute(launch.command, ['auth', 'logout'], { env: launch.env, timeout: 15000 });
      return {};
    }
    if (method === 'account/login/cancel') {
      this.stop();
      return {};
    }
    if (method !== 'account/login/start') { throw Error('不支持的 Claude 账户操作'); }
    if (this.loginChild) { return this.loginState; }
    this.loginState = { state: 'waiting' };
    const child = spawn(launch.command, ['auth', 'login'], { env: launch.env, cwd: launch.env.HOME, stdio: ['pipe', 'pipe', 'pipe'] });
    this.loginChild = child;
    this.onProcesses?.();
    let output = '';
    const receive = chunk => {
      output = (output + chunk.toString()).slice(-32768);
      const url = output.match(/https:\/\/[^\s\x1b]+/g)?.find(value => {
        try { return ['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(new URL(value).hostname); }
        catch { return false; }
      });
      if (url) { this.loginState.authUrl = url; }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('error', () => { this.loginState = { state: 'failed', error: 'Claude 登录进程启动失败' }; });
    child.on('close', code => {
      this.loginState = { state: code === 0 ? 'complete' : 'failed', ...(code ? { error: '登录未完成，请重试' } : {}) };
      this.loginChild = null;
      this.onProcesses?.();
    });
    return this.loginState;
  }

  stop() {
    const child = this.loginChild;
    if (!child) { return; }
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
    }, 3000);
    escalation.unref();
    child.once('close', () => clearTimeout(escalation));
  }

  async launch(profileId, id) {
    id ||= (await this.config()).defaultEngine;
    const runtime = this.runtime(id);
    const launch = await runtime.launch(profileId);
    await this.prepareSources(id, join(runtime.root, 'profiles', launch.profileId));
    return { ...launch, engineId: id };
  }
}
