import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fail, pluginId, sessionName } from '../../shared/contracts.js';
import { stopOwnedProcess } from '../os/index.js';
import { sessionActions } from './session-actions.js';
import { readGit } from './git.js';
import { saveImageChunk } from './clipboard-images.js';

const LIMIT = 2 * 1024 * 1024;
const FIELDS = ['id', 'pluginId', 'adapterId', 'name', 'cwd', 'lifecycle', 'activity', 'blocked', 'permission', 'contextId',
  'createdAt', 'closedAt', 'exitCode', 'reason', 'pid', 'git', 'error', 'exited', 'restoredFrom', 'truncated'];
export const metadata = (session) => Object.fromEntries(FIELDS.map((key) => [key, session[key]]));

export class Sessions {
  constructor(options) {
    Object.assign(this, options);
    this.emit ||= () => {};
    this.processControl ||= stopOwnedProcess;
    this.active = new Map();
    this.archives = new Map();
    this.restores = new Map();
    this.gitSwitches = new Set();
    this.launching = 0;
    this.readGit ||= readGit;
  }

  key(session) {
    return `plugin-data/${pluginId(session.pluginId)}/sessions/${session.id}.json`;
  }

  async loadPlugin(id) {
    const dir = await this.storage.path(`plugin-data/${pluginId(id)}/sessions`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
        continue;
      }
      const record = await this.storage.readJson(`plugin-data/${id}/sessions/${name}`);
      if (record.pluginId !== id || this.active.has(record.id)) {
        continue;
      }
      if (record.lifecycle === 'active') {
        Object.assign(record, { lifecycle: 'archived', exited: true, reason: 'interrupted', closedAt: new Date().toISOString() });
        await this.storage.writeJson(this.key(record), record);
      }
      this.archives.set(record.id, metadata(record));
    }
  }

  list(id) {
    return {
      sessions: [...this.active.values()].filter((s) => s.pluginId === id).map(metadata),
      archives: [...this.archives.values()].filter((s) => s.pluginId === id).map(metadata).reverse()
    };
  }

  get(id, sessionId) {
    const session = this.active.get(sessionId);
    if (!session || session.pluginId !== pluginId(id)) {
      throw fail('SESSION_NOT_FOUND', '会话不存在或归属不符');
    }
    return session;
  }

  publish(id) {
    this.emit('sessions.changed', { pluginId: id, ...this.list(id) });
  }

  async create(id, input) {
    pluginId(id);
    return this.guard(id, () => this.launch(id, input));
  }

  async launch(id, input) {
    this.launching++;
    try {
      return await this.start(id, input);
    } finally {
      this.launching--;
    }
  }

  async start(id, input) {
    const name = sessionName(input.name || 'Agent');
    const path = input.cwd?.replace(/^~(?=\/|$)/, homedir());
    if (!path || !isAbsolute(path) || !(await stat(path)).isDirectory()) {
      throw fail('INVALID_ARGUMENT', '请选择有效的绝对工作目录');
    }
    const cwd = await realpath(path);
    const session = {
      id: randomUUID(), pluginId: id, adapterId: input.adapterId, name, cwd, permission: input.permission || 'default',
      createdAt: new Date().toISOString(), lifecycle: 'active', activity: 'unknown', blocked: null,
      contextId: input.contextId, restoredFrom: input.restoredFrom, output: '', sequence: 0, exited: false
    };
    const adapter = this.adapter(id, input.adapterId);
    const sessionDataDir = await this.storage.path(`plugin-data/${id}/logs/${session.id}`);
    await mkdir(sessionDataDir, { recursive: true, mode: 0o700 });
    session.sessionDataDir = sessionDataDir;
    const launch = await adapter.buildLaunch({ ...input, cwd, sessionDataDir, permission: session.permission });
    if (this.readGit) {
      session.git = await this.readGit(cwd);
    }
    if (this.gitSwitches.has(session.git?.root)) {
      throw fail('GIT_BUSY', '工作区正在切换分支');
    }
    await this.storage.writeJson(this.key(session), { ...metadata(session), output: '' });
    const spawn = this.spawn || (await import('node-pty')).spawn;
    try {
      session.terminal = spawn(launch.command, launch.args, {
        name: 'xterm-256color', cwd, ...this.size(input),
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...launch.env }
      });
    } catch (error) {
      await rm(await this.storage.path(this.key(session)), { force: true });
      throw fail('SESSION_LAUNCH_FAILED', `启动失败：${error.message}`);
    }
    session.pid = session.terminal.pid;
    this.active.set(session.id, session);
    session.terminal.onData((data) => this.onData(session, adapter, data));
    session.terminal.onExit(({ exitCode }) => {
      Object.assign(session, { exited: true, exitCode });
      if (!session.closing) {
        this.archive(id, session.id, 'exited').catch((error) => this.report(session, error));
      }
    });
    this.publish(id);
    console.info('[session:create]', { pluginId: id, sessionId: session.id, pid: session.pid, cwd });
    return metadata(session);
  }

  size({ cols = 90, rows = 28 }) {
    if (![cols, rows].every(Number.isInteger) || cols < 2 || cols > 500 || rows < 2 || rows > 200) {
      throw fail('INVALID_ARGUMENT', '终端尺寸无效');
    }
    return { cols, rows };
  }

  onData(session, adapter, data) {
    const buffer = Buffer.from(session.output + data);
    let start = Math.max(0, buffer.length - LIMIT);
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start++;
    }
    session.output = buffer.subarray(start).toString();
    session.truncated ||= start > 0;
    const activity = `${session.activity}:${session.blocked}`;
    if (adapter.parseActivity) {
      Object.assign(session, adapter.parseActivity(session, data));
    }
    this.emit('sessions.output', { pluginId: session.pluginId, sessionId: session.id, sequence: ++session.sequence, data });
    if (activity !== `${session.activity}:${session.blocked}`) {
      this.publish(session.pluginId);
    }
    if (!session.checkpoint && !session.closing) {
      session.checkpoint = setTimeout(() => {
        session.checkpoint = null;
        this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output })
          .catch((error) => this.report(session, fail('CHECKPOINT_FAILED', error.message)));
      }, 2000);
      session.checkpoint.unref();
    }
  }

  write(id, sessionId, data) {
    this.assertEnabled?.(id);
    const session = this.get(id, sessionId);
    if (session.exited || session.closing || this.gitSwitches.has(session.git?.root)) {
      throw fail('SESSION_BUSY', '会话已停止或工作区正在切换');
    }
    if (typeof data !== 'string' || data.length > 65536) {
      throw fail('INVALID_ARGUMENT', '输入数据无效或过长');
    }
    session.lastInputAt = Date.now();
    session.terminal.write(data);
  }

  async saveImage(id, sessionId, chunk) {
    const session = this.get(id, sessionId);
    if (session.exited || session.closing) {
      throw fail('SESSION_BUSY', '会话已停止或正在归档');
    }
    try {
      return await saveImageChunk(this.storage, session, chunk);
    } catch (error) {
      console.error('[session:image-error]', { pluginId: id, sessionId, message: error.message });
      throw error;
    }
  }

  resize(id, sessionId, cols, rows) {
    const session = this.get(id, sessionId);
    const size = this.size({ cols, rows });
    if (!session.exited) {
      session.terminal.resize(size.cols, size.rows);
    }
  }

  async rename(id, sessionId, name) {
    const session = this.get(id, sessionId);
    if (session.closing) {
      throw fail('SESSION_BUSY', '会话正在归档');
    }
    session.name = sessionName(name);
    await this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output });
    this.publish(id);
    return metadata(session);
  }

  attach(id, sessionId) {
    const session = this.get(id, sessionId);
    return { data: session.output, sequence: session.sequence };
  }

  archive(id, sessionId, reason = 'closed') {
    const session = this.get(id, sessionId);
    if (session.closing) {
      return session.closing;
    }
    // Establish the lock before a synchronous exit callback can reenter archive.
    session.closing = Promise.resolve().then(() => this.finishArchive(session, reason)).catch((error) => {
      session.closing = null;
      this.report(session, error);
      throw error;
    });
    return session.closing;
  }

  async finishArchive(session, reason) {
    clearTimeout(session.checkpoint);
    session.checkpoint = null;
    try {
      await this.processControl(session);
    } catch (error) {
      throw fail('SESSION_STOP_FAILED', error.message);
    }
    const adapter = this.adapter(session.pluginId, session.adapterId);
    // A resolver's unknown result invalidates an inherited ID after native CLI context switches.
    session.contextId = adapter.resolveContext ? await adapter.resolveContext(session) : session.contextId;
    const record = { ...metadata(session), lifecycle: 'archived', reason, closedAt: new Date().toISOString(), output: session.output };
    try {
      await this.storage.writeJson(this.key(session), record);
    } catch (error) {
      throw fail('ARCHIVE_WRITE_FAILED', error.message);
    }
    this.archives.set(session.id, metadata(record));
    this.active.delete(session.id);
    this.publish(session.pluginId);
    console.info('[session:archive]', { pluginId: session.pluginId, sessionId: session.id, reason });
    return metadata(record);
  }

  report(session, error) {
    session.error = { code: error.code || 'SESSION_ERROR', message: error.message };
    console.error('[session:error]', { pluginId: session.pluginId, sessionId: session.id, ...session.error });
    this.emit('host.error', { pluginId: session.pluginId, sessionId: session.id, ...session.error });
    this.publish(session.pluginId);
  }

  async readArchive(id, sessionId) {
    const record = this.archives.get(sessionId);
    if (!record || record.pluginId !== id) {
      throw fail('SESSION_NOT_FOUND', '归档不存在或归属不符');
    }
    return this.storage.readJson(this.key(record));
  }

  async deleteArchive(id, sessionId) {
    const record = await this.readArchive(id, sessionId);
    await rm(await this.storage.path(this.key(record)), { force: true });
    this.archives.delete(sessionId);
    this.publish(id);
  }

  async stopAndArchive(id, reason) {
    const ids = this.list(id).sessions.map((s) => s.id);
    for (const sessionId of ids) {
      await this.archive(id, sessionId, reason);
    }
    return ids;
  }
}

Object.assign(Sessions.prototype, sessionActions);
