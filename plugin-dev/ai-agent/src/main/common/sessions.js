import { agentRole, rolePrompt } from '../../shared/agent-roles.js';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { appendFile, copyFile, mkdir, open, readFile, readdir, stat, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fail, pluginId, sessionName } from '../../shared/contracts.js';
import { stopOwnedProcess } from '../os/index.js';
import { sessionActions } from './session-actions.js';
import { readGit } from './git.js';
import { saveImageChunk } from './clipboard-images.js';
import { resolveFileReferences } from './file-references.js';
import { TerminalReplay } from './terminal-replay.js';
import { TerminalPalette } from './terminal-palette.js';

const LIMIT = 2 * 1024 * 1024;
// Mouse/focus reports and negotiation replies share onData with typing; they must not create or replace a draft guard.
const TERMINAL_REPORT = new RegExp('^(?:\\x1b\\[[IO]|\\x1b\\[<\\d+;\\d+;\\d+[Mm]|\\x1b\\[M[\\s\\S]{3}'
  + '|\\x1b\\[\\??\\d+;\\d+R|\\x1b\\[[?>][\\d;]+c|\\x1b\\[0n'
  + '|\\x1b\\[\\??\\d+;\\d+\\$y|\\x1b\\[8;\\d+;\\d+t'
  + '|\\x1b\\](?:10|11);rgb:[\\da-f/]+(?:\\x07|\\x1b\\\\))+$', 'i');
const FIELDS = ['id', 'pluginId', 'adapterId', 'name', 'groupId', 'agentRole', 'cwd', 'lifecycle', 'activity', 'blocked', 'question', 'permission', 'contextId',
  'logIds', 'nativeDeleted', 'launchSettings', 'windowId', 'runtimeId', 'runtimeVersion', 'profileId', 'protocol', 'logId', 'createdAt', 'closedAt', 'exitCode', 'reason', 'pid', 'git', 'error', 'exited', 'restoredFrom', 'truncated'];
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
    this.inputBlocked = false;
    this.readGit ||= readGit;
  }

  key(session) {
    return `plugin-data/${pluginId(session.pluginId)}/sessions/${session.id}.json`;
  }

  async loadPlugin(id) {
    const dir = await this.storage.path(`plugin-data/${pluginId(id)}/sessions`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const records = [];
    for (const name of await readdir(dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
        continue;
      }
      const record = await this.storage.readJson(`plugin-data/${id}/sessions/${name}`);
      if (record.pluginId !== id || this.active.has(record.id)) {
        continue;
      }
      records.push(record);
    }
    // A crash can leave multiple generations; filenames do not indicate which transcript is newest.
    records.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')
      || (a.closedAt || '').localeCompare(b.closedAt || '') || Number(a.lifecycle === 'active') - Number(b.lifecycle === 'active'));
    const latest = new Map(records.map(record => [record.restoredFrom || record.id, { ...record }]));
    for (const [archiveId, record] of latest) {
      const persist = record.lifecycle === 'active' || record.id !== archiveId;
      record.logId ||= record.id;
      if (record.lifecycle === 'active') {
        record.sessionDataDir = await this.storage.path(`plugin-data/${id}/logs/${record.logId}`);
        const adapter = this.adapter?.(id, record.adapterId);
        try {
          record.contextId = !record.nativeDeleted && adapter?.resolveContext ? await adapter.resolveContext(record) : record.contextId;
        } catch (error) {
          // Native metadata is supplementary; an unreadable CLI log must not hide saved terminal history.
          console.error('[session:recover-context]', { pluginId: id, sessionId: archiveId, message: error.message });
        }
        Object.assign(record, { lifecycle: 'archived', exited: true, reason: record.reason || 'interrupted', closedAt: new Date().toISOString() });
        console.info('[session:recover]', { pluginId: id, sessionId: archiveId, contextId: record.contextId, logId: record.logId });
      }
      // Save the stable identity before removing restored generations, including already archived ones.
      if (persist) {
        record.id = archiveId;
        delete record.sessionDataDir;
        await this.storage.writeJson(this.key(record), record);
      }
      this.archives.set(record.id, metadata(record));
    }
    for (const record of records) {
      if (record.id !== (record.restoredFrom || record.id)) {
        await rm(await this.storage.path(this.key(record)), { force: true });
      }
    }
  }

  list(id) {
    const sessions = [...this.active.values()].filter((s) => s.pluginId === id);
    // Keep restored archives available for replay, but hide them while their windows remain open.
    const openedIds = new Set(sessions.map((s) => s.restoredFrom || s.id));
    return {
      groups: this.groups?.list() || [],
      sessions: sessions.map(session => ({ ...metadata(session), coordinator: this.groups?.isCoordinator(session) || false,
        coordinating: Boolean(this.groups?.isCoordinator(session) && this.coordination?.isActive(session.groupId)) })),
      archives: [...this.archives.values()].filter((s) => s.pluginId === id && !openedIds.has(s.id)).map(session => ({ ...metadata(session), coordinator: this.groups?.isCoordinator(session) || false })).reverse()
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
    this.messages?.wake();
  }

  async create(id, input) {
    pluginId(id);
    return this.guard(id, () => this.launch(id, input));
  }

  async launch(id, input, outputSource) {
    this.launching++;
    try {
      return await this.start(id, input, outputSource);
    } finally {
      this.launching--;
    }
  }

  blockInput() { this.inputBlocked = true; }

  setTheme(id, theme) {
    pluginId(id);
    this.terminalTheme = theme === 'light' ? 'light' : 'dark';
  }

  async start(id, input, outputSource) {
    if (this.inputBlocked) { throw fail('SESSION_BUSY', 'AI 插件正在关闭'); }
    if (input.groupId) { this.groups?.get(input.groupId); }
    const name = sessionName(input.name || 'Agent');
    const path = input.cwd?.replace(/^~(?=\/|$)/, homedir());
    if (!path || !isAbsolute(path) || !(await stat(path)).isDirectory()) {
      throw fail('INVALID_ARGUMENT', '请选择有效的绝对工作目录');
    }
    const cwd = await realpath(path);
    // Retry keeps diagnostic replay even when no native context exists; it never writes replay to stdin.
    const output = input.mode === 'resume' || input.restoredFrom ? input.output || '' : '';
    const session = {
      id: randomUUID(), pluginId: id, adapterId: input.adapterId, name, cwd, agentRole: agentRole(input.agentRole), permission: input.permission || 'default',
      createdAt: new Date().toISOString(), lifecycle: 'active', activity: 'unknown', blocked: null,
      contextId: input.contextId, restoredFrom: input.restoredFrom, windowId: input.windowId, groupId: input.groupId,
      replay: new TerminalReplay(LIMIT),
      sequence: 0, exited: false, diagnosticTail: ''
    };
    // Metadata spreads (including capture catalogs) must not materialize a terminal replay.
    Object.defineProperty(session, 'output', { get: () => session.replay.text() });
    const adapter = this.adapter(id, input.adapterId);
    const sessionDataDir = await this.storage.path(`plugin-data/${id}/logs/${session.id}`);
    await mkdir(sessionDataDir, { recursive: true, mode: 0o700 });
    session.sessionDataDir = sessionDataDir;
    session.logId = session.id;
    // Clearing context keeps the card identity, but must sever the native recovery lineage.
    session.logIds = input.mode === 'new' ? [session.id]
      : [...new Set([...(input.restoredFrom ? input.logIds || [input.restoredFrom, input.logId] : []), session.id].filter(Boolean))];
    session.outputPath = join(sessionDataDir, 'terminal-output.log');
    const monitor = await adapter.prepareActivity?.(state => {
      if (session.exited) { return; }
      Object.assign(session, state);
      // Native hooks/log watchers can finish a turn without another PTY output event.
      try {
        this.messages?.observeActivity(session);
      } catch (error) {
        session.pendingUserInput ||= { revision: session.inputRevision, submitted: false };
        console.error('[session:communication-activity]', { pluginId: id, sessionId: session.id }, error);
      }
      if (this.active.has(session.id)) { this.publish(id); }
    }, session);
    session.stopActivity = monitor?.close;
    try {
      let launch = await adapter.buildLaunch({ ...input, sessionId: session.id, cwd, sessionDataDir, roleInstructions: rolePrompt(session.agentRole, this.coordination?.instructions({ ...input, sessionId: session.id })), permission: session.permission,
        activitySettings: monitor?.settings });
      session.mcpConnection = launch.mcpConnection;
      Object.assign(session, Object.fromEntries(['runtimeId', 'runtimeVersion', 'profileId', 'launchSettings'].map(key => [key, launch[key]])));
      session.protocol = launch.isolated ? 'managed-terminal' : 'legacy';
      if (this.capture && session.protocol === 'managed-terminal' && ['codex', 'claude'].includes(session.adapterId)) {
        const route = await this.capture.prepare({ ...session, engineId: session.adapterId }, launch);
        launch = { ...launch, args: route.args, env: route.env };
        session.captureKey = route.key;
      }
      if (this.readGit) {
        session.git = await this.readGit(cwd);
      }
      if (this.gitSwitches.has(session.git?.root)) {
        throw fail('GIT_BUSY', '工作区正在切换分支');
      }
      // Preserve the full history on disk without decoding and copying it through JS during recovery.
      if (outputSource && !input.nativeDeleted) {
        await copyFile(outputSource, session.outputPath);
      } else {
        await writeFile(session.outputPath, output, { mode: 0o600 });
      }
      this.bufferOutput(session, output);
      session.truncated ||= Boolean(input.truncated);
      await this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output });
      if (this.inputBlocked) { throw fail('SESSION_BUSY', 'AI 插件正在关闭'); }
      const spawn = this.spawn || (await import('node-pty')).spawn;
      try {
        session.terminal = spawn(launch.command, launch.args, {
          name: 'xterm-256color', cwd, ...this.size(input),
          env: { ...(launch.isolated ? {} : process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor', ...launch.env }
        });
      } catch (error) {
        await rm(await this.storage.path(this.key(session)), { force: true });
        throw fail('SESSION_LAUNCH_FAILED', `启动失败：${error.message}`);
      }
      session.pid = session.terminal.pid;
      if (session.adapterId === 'codex') {
        session.palette = new TerminalPalette(() => this.terminalTheme || 'dark', reply => {
          try {
            // Color negotiation is terminal traffic, not user input or a new Agent turn.
            session.terminal.write(reply);
            return true;
          } catch (error) {
            console.error('[session:palette-reply]', { pluginId: id, sessionId: session.id }, error);
            return false;
          }
        });
      }
      this.active.set(session.id, session);
      session.terminal.onData((data) => this.onData(session, adapter, data));
      session.terminal.onExit(({ exitCode, signal }) => {
        Object.assign(session, { exited: true, exitCode });
        if (!session.closing) {
          if (exitCode !== 0 || signal) {
            Object.assign(session, { activity: 'error', blocked: null });
            if (!signal && networkExit(session.diagnosticTail)) {
              Object.assign(session, { activity: 'offline', error: { code: 'SESSION_OFFLINE', message: '连接不可用，请检查网络后重新连接。' } });
              console.info('[session:offline]', { pluginId: id, sessionId: session.id, exitCode });
              this.publish(id);
            } else {
              this.report(session, fail('SESSION_EXITED',
                `Agent 异常退出（${signal ? `信号 ${signal}` : `退出码 ${exitCode}`}），检查网络或授权后重试。`));
            }
            session.exitCleanup = this.retainExited(session, adapter).catch(error => this.report(session, error));
          } else {
            this.archive(id, session.id, 'exited').catch((error) => this.report(session, error));
          }
        }
      });
      this.publish(id);
      console.info('[session:create]', { pluginId: id, sessionId: session.id, pid: session.pid, cwd });
      return metadata(session);
    } catch (error) {
      await session.stopActivity?.();
      await this.capture?.release?.(session.id);
      await session.mcpConnection?.close();
      throw error;
    }
  }

  async retainExited(session, adapter) {
    // Release runtime resources without removing the terminal output needed to diagnose startup failures.
    clearTimeout(session.checkpoint);
    session.checkpoint = null;
    await session.checkpointWrite;
    await session.stopActivity?.();
    session.stopActivity = null;
    await this.capture?.release?.(session.id);
    await session.mcpConnection?.close();
    await session.outputWrite;
    session.contextId = !session.nativeDeleted && adapter.resolveContext ? await adapter.resolveContext(session) : session.contextId;
    await this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output });
    this.publish(session.pluginId);
  }

  size({ cols = 90, rows = 28 }) {
    if (![cols, rows].every(Number.isInteger) || cols < 2 || cols > 500 || rows < 2 || rows > 200) {
      throw fail('INVALID_ARGUMENT', '终端尺寸无效');
    }
    return { cols, rows };
  }

  onData(session, adapter, data) {
    data = session.palette ? session.palette.consume(data) : data;
    if (!data) {
      return;
    }
    // Use only this process's recent diagnostics, never restored terminal history, to classify a failed connection.
    session.diagnosticTail = (session.diagnosticTail + data).slice(-8192);
    // Append every chunk independently of the bounded UI replay and the slower metadata checkpoint.
    session.outputWrite = (session.outputWrite || Promise.resolve()).then(() => appendFile(session.outputPath, data));
    this.bufferOutput(session, data);
    const activity = `${session.activity}:${session.blocked}`;
    if (adapter.parseActivity) {
      Object.assign(session, adapter.parseActivity(session, data));
    }
    this.messages?.observeActivity(session);
    const output = { pluginId: session.pluginId, sessionId: session.id, sequence: ++session.sequence, data, inputRevision: session.inputRevision || 0 };
    session.outputWrite.then(() => this.emit('sessions.output', output),
      error => this.report(session, fail('OUTPUT_WRITE_FAILED', error.message)));
    if (activity !== `${session.activity}:${session.blocked}`) {
      this.publish(session.pluginId);
    }
    if (!session.checkpoint && !session.closing) {
      session.checkpoint = setTimeout(() => {
        session.checkpointWrite = (async () => {
          try {
            // Persist the native ID while the window is alive, including native /new and /resume switches.
            const contextId = adapter.resolveContext ? await adapter.resolveContext(session) : session.contextId;
            if (session.closing) { return; }
            if (contextId !== session.contextId) {
              session.contextId = contextId;
              this.publish(session.pluginId);
            }
            await this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output });
          } catch (error) {
            this.report(session, fail('CHECKPOINT_FAILED', error.message));
          } finally {
            session.checkpoint = null;
          }
        })();
      }, 2000);
      session.checkpoint.unref();
    }
  }

  bufferOutput(session, data) {
    session.replay.append(data);
    session.truncated ||= session.replay.truncated;
  }

  write(id, sessionId, data) {
    this.assertEnabled?.(id);
    const session = this.get(id, sessionId);
    if (this.inputBlocked || session.exited || session.closing || this.gitSwitches.has(session.git?.root)) {
      throw fail('SESSION_BUSY', '会话已停止或工作区正在切换');
    }
    if (typeof data !== 'string' || data.length > 65536) {
      throw fail('INVALID_ARGUMENT', '输入数据无效或过长');
    }
    if (TERMINAL_REPORT.test(data)) {
      session.terminal.write(data);
      return;
    }
    session.inputRevision = (session.inputRevision || 0) + 1;
    this.messages?.userInput(session, data);
    session.lastInputAt = Date.now();
    if (!session.mcpConnection?.refresh && !session.inputWrites) {
      session.terminal.write(data);
      this.messages?.submitted(session, data);
      return;
    }
    // Preserve PTY byte order while the submit waits for fresh MCP endpoints. Do not restart a process with draft input.
    return this.queueInput(session, async () => {
      if (/[\r\n]/.test(data)) { await session.mcpConnection?.refresh(); }
      this.assertEnabled?.(id);
      if (this.inputBlocked || session.exited || session.closing || this.gitSwitches.has(session.git?.root)) {
        throw fail('SESSION_BUSY', '会话已停止或正在关闭');
      }
      session.lastInputAt = Date.now();
      session.terminal.write(data);
      this.messages?.submitted(session, data);
    });
  }

  // Both native user input and peer delivery use one PTY byte-order queue.
  queueInput(session, action) {
    const write = (session.inputWrites || Promise.resolve()).then(action);
    const pending = write.catch(() => {});
    session.inputWrites = pending;
    pending.finally(() => { if (session.inputWrites === pending) { session.inputWrites = null; } });
    return write;
  }

  async fileReferences(id, sessionId, paths) {
    const session = this.get(id, sessionId);
    if (session.exited || session.closing) {
      throw fail('SESSION_BUSY', '会话已停止或正在归档');
    }
    try {
      const references = await resolveFileReferences(paths, session.cwd);
      console.info('[session:file-references]', { pluginId: id, sessionId, count: references.length });
      return references;
    } catch (error) {
      console.error('[session:file-references]', { pluginId: id, sessionId, message: error.message, stack: error.stack });
      throw error;
    }
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

  async attachWindow(id, sessionId, windowId) {
    if (!/^[a-f0-9-]{36}$/.test(windowId)) {
      throw fail('INVALID_ARGUMENT', '无效窗口 ID');
    }
    const session = this.get(id, sessionId);
    session.windowId = windowId;
    await this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output });
    this.publish(id);
    return metadata(session);
  }

  attach(id, sessionId) {
    const session = this.get(id, sessionId);
    return { data: session.output, sequence: session.sequence, inputRevision: session.inputRevision || 0 };
  }

  archive(id, sessionId, reason = 'closed') {
    const session = this.get(id, sessionId);
    if (reason === 'closed') { this.groups?.assertRemovable(session); }
    if (session.nativeDeleted && session.reason === 'context-reset') {
      reason = 'context-reset';
    }
    if (session.closing) {
      if (session.closeAction === 'delete') {
        throw fail('SESSION_BUSY', '会话正在删除');
      }
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

  async stopSession(session) {
    await session.exitCleanup;
    clearTimeout(session.checkpoint);
    session.checkpoint = null;
    try {
      await this.processControl(session);
    } catch (error) {
      throw fail('SESSION_STOP_FAILED', error.message);
    }
    await session.stopActivity?.();
    session.stopActivity = null;
    await this.capture?.release?.(session.id);
    await session.mcpConnection?.close();
    await session.checkpointWrite;
    await session.outputWrite;
    const adapter = this.adapter(session.pluginId, session.adapterId);
    // A resolver's unknown result invalidates an inherited ID after native CLI context switches.
    session.contextId = !session.nativeDeleted && adapter.resolveContext ? await adapter.resolveContext(session) : session.contextId;
  }

  async finishArchive(session, reason) {
    await this.persistCloseIntent(session, reason);
    await this.stopSession(session);
    // A restored process has a new runtime ID, while its archive keeps the original identity.
    const record = { ...metadata(session), id: session.restoredFrom || session.id, lifecycle: 'archived', reason,
      closedAt: new Date().toISOString(), output: session.output };
    try {
      await this.storage.writeJson(this.key(record), record);
      if (record.id !== session.id) {
        await rm(await this.storage.path(this.key(session)), { force: true });
      }
    } catch (error) {
      throw fail('ARCHIVE_WRITE_FAILED', error.message);
    }
    this.archives.set(record.id, metadata(record));
    this.active.delete(session.id);
    this.publish(session.pluginId);
    console.info('[session:archive]', { pluginId: session.pluginId, sessionId: session.id, reason });
    return metadata(record);
  }

  async persistCloseIntent(session, reason) {
    clearTimeout(session.checkpoint);
    session.checkpoint = null;
    await session.exitCleanup;
    await session.checkpointWrite;
    // Save intent before stopping the process so a crash during a manual close cannot reopen it.
    session.reason = reason;
    try {
      await this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output });
    } catch (error) {
      throw fail('ARCHIVE_WRITE_FAILED', error.message);
    }
  }

  delete(id, sessionId) {
    return this.guard(id, async () => {
      const session = this.active.has(sessionId) ? this.get(id, sessionId) : await this.readArchive(id, sessionId);
      this.groups?.assertRemovable(session);
      if (session.closing) {
        throw fail('SESSION_BUSY', '会话正在关闭');
      }
      if (session.protocol !== 'managed-terminal' || !['codex', 'claude'].includes(session.adapterId) || !this.deleteContext) {
        throw fail('DELETE_UNSUPPORTED', '此引擎不支持彻底删除，请选择归档；不会仅删除本地回放');
      }
      session.closeAction = 'delete';
      session.closing = Promise.resolve().then(() => this.finishDelete(session)).catch(error => {
        session.closing = null;
        this.report(session, error);
        throw error;
      });
      return session.closing;
    });
  }

  assertContextUnshared(session) {
    const identity = session.restoredFrom || session.id;
    const peer = [...this.active.values(), ...this.archives.values()].find(other => other.pluginId === session.pluginId
      && (other.restoredFrom || other.id) !== identity && other.adapterId === session.adapterId
      && (other.profileId || 'default') === (session.profileId || 'default') && other.contextId === session.contextId);
    if (session.contextId && peer) {
      throw fail('CONTEXT_IN_USE', '此上下文仍被其他会话引用，请先关闭关联会话');
    }
  }

  async finishDelete(session) {
    this.assertContextUnshared(session);
    if (!session.nativeDeleted) {
      // Deleting an interrupted archive also cancels its pending automatic recovery.
      await this.persistCloseIntent(session, 'deleted');
      if (this.archives.has(session.id)) {
        this.archives.set(session.id, metadata(session));
      }
    }
    if (this.active.has(session.id) && !session.nativeDeleted) {
      await this.stopSession(session);
    }
    this.assertContextUnshared(session);
    if (!session.contextId) {
      throw fail('CONTEXT_UNKNOWN', '尚未识别引擎会话，无法确认彻底删除；请归档后恢复并重试');
    }
    // Persist the irreversible native step so local cleanup can be retried after an IO failure or restart.
    if (!session.nativeDeleted) {
      await this.deleteContext(session);
      session.nativeDeleted = true;
    }
    await this.storage.writeJson(this.key(session), { ...metadata(session), output: session.output });
    const identity = session.restoredFrom || session.id;
    const previous = this.archives.get(identity);
    const logIds = new Set([...(session.logIds || []), ...(previous?.logIds || []), previous?.logId,
      session.id, session.logId, identity].filter(Boolean));
    for (const logId of logIds) {
      if (!/^[a-f0-9-]{36}$/.test(logId)) {
        throw fail('INVALID_ARGUMENT', '会话数据目录无效');
      }
      for (const kind of ['logs', 'capture']) {
        await rm(await this.storage.path(`plugin-data/${session.pluginId}/${kind}/${logId}`), { recursive: true, force: true });
      }
    }
    try { await this.messages?.deleted(session); }
    catch (error) {
      console.error('[session:communication-delete]', { pluginId: session.pluginId, sessionId: session.id, error: error.stack });
      throw error;
    }
    // Metadata is removed last: failed cleanup remains discoverable for an explicit retry.
    await rm(await this.storage.path(this.key({ ...session, id: identity })), { force: true });
    await rm(await this.storage.path(this.key(session)), { force: true });
    this.archives.delete(identity);
    this.active.delete(session.id);
    this.publish(session.pluginId);
    console.info('[session:delete]', { pluginId: session.pluginId, sessionId: session.id, contextId: session.contextId });
    return { deleted: true };
  }

  report(session, error) {
    session.error = { code: error.code || 'SESSION_ERROR', message: error.message };
    console.error('[session:error]', { pluginId: session.pluginId, sessionId: session.id, ...session.error });
    this.emit('host.error', { pluginId: session.pluginId, sessionId: session.id, ...session.error });
    this.publish(session.pluginId);
  }

  // Move only the launch directory; native context IDs and replay lineage must survive a project relocation.
  async updateArchiveDirectory(id, sessionId, directory) {
    try {
      const archive = this.archives.get(sessionId);
      if (!archive || archive.pluginId !== id) {
        throw fail('SESSION_NOT_FOUND', '归档不存在或归属不符');
      }
      const session = this.active.get(sessionId);
      if (this.restores.has(`${id}:${sessionId}`) || (session && (!session.exited || session.closing))
        || [...this.active.values()].some(item => item.pluginId === id && item.restoredFrom === sessionId && !item.exited)) {
        throw fail('SESSION_BUSY', '会话正在恢复或运行，请关闭后修改工作目录');
      }
      const path = typeof directory === 'string' ? directory.trim().replace(/^~(?=\/|$)/, homedir()) : '';
      if (!path || !isAbsolute(path)) {
        throw fail('INVALID_ARGUMENT', '请选择有效的绝对工作目录');
      }
      let cwd;
      try {
        if (!(await stat(path)).isDirectory()) {
          throw fail('INVALID_ARGUMENT', '请选择有效的工作目录');
        }
        cwd = await realpath(path);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
          throw fail('INVALID_ARGUMENT', '工作目录不存在，请重新选择');
        }
        throw error;
      }
      const record = await this.storage.readJson(this.key(archive));
      const updated = { ...record, cwd, git: null, error: null };
      await this.storage.writeJson(this.key(archive), updated);
      this.archives.set(sessionId, metadata(updated));
      if (session) {
        Object.assign(session, { cwd, git: null, error: null });
      }
      this.publish(id);
      console.info('[session:archive-directory]', { pluginId: id, sessionId, previousCwd: record.cwd, cwd });
      return metadata(updated);
    } catch (error) {
      console.error('[session:archive-directory]', { pluginId: id, sessionId }, error);
      throw error;
    }
  }

  async readArchive(id, sessionId, options) {
    const record = this.archives.get(sessionId);
    if (!record || record.pluginId !== id) {
      throw fail('SESSION_NOT_FOUND', '归档不存在或归属不符');
    }
    return this.readOutput(await this.storage.readJson(this.key(record)), options);
  }

  async readOutput(record, { recovery = false } = {}) {
    const path = await this.storage.path(`plugin-data/${record.pluginId}/logs/${record.logId || record.id}/terminal-output.log`);
    try {
      if (!recovery) {
        return { ...record, output: await readFile(path, 'utf8'), truncated: false };
      }
      const file = await open(path, 'r');
      try {
        const { size } = await file.stat();
        const buffer = Buffer.alloc(Math.min(size, LIMIT));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - LIMIT));
        let start = 0;
        // The replay tail may begin inside a multibyte character.
        while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) { start++; }
        return { ...record, output: buffer.toString('utf8', start, bytesRead), outputSource: path, truncated: size > LIMIT };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return record;
    }
  }

  async deleteArchive(id, sessionId) {
    const record = await this.readArchive(id, sessionId);
    this.groups?.assertRemovable(record);
    await rm(await this.storage.path(this.key(record)), { force: true });
    this.archives.delete(sessionId);
    this.publish(id);
  }

  async stopAndArchive(id, reason) {
    const ids = this.list(id).sessions.map((s) => s.id);
    for (const sessionId of ids) {
      // Desktop quit must not replace an incomplete manual close/delete; explicit closes take precedence.
      await this.archive(id, sessionId, reason === 'quit' ? this.get(id, sessionId).reason || reason : reason);
    }
    return ids;
  }
}

Object.assign(Sessions.prototype, sessionActions);


// Only explicit transport diagnostics qualify; authorization and configuration failures keep their normal error handling.
function networkExit(output) {
  const lines = stripVTControlCharacters(output).split(/[\r\n]+/).filter(line => /error|failed|unable|timed? ?out|ECONN|ENET|ENOTFOUND|EAI_AGAIN/i.test(line));
  const last = lines.at(-1) || '';
  return !/unauthorized|forbidden|invalid.api.key|HTTP[ :]*(401|403)/i.test(last)
    && /workspace routing discovery (?:failed|timed out)|\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b|error (?:sending request|connecting)|unable to connect to (?:API|server)|network (?:is unreachable|error)|connection (?:refused|timed out)/i.test(last);
}
