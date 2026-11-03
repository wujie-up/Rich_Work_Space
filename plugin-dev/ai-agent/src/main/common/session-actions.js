import { readGit, fetchGitBranches, switchGitBranch } from './git.js';
import { fail } from '../../shared/contracts.js';
import { metadata } from './sessions.js';

// These operations share Sessions' owner and launch guards instead of a second process registry.
export const sessionActions = {
  async recover(id, windowId, liveWindowIds) {
    const sessions = [];
    if (liveWindowIds) {
      // A view crash can leave its processes alive; reclaim them without restarting the CLI.
      for (const session of this.list(id).sessions.filter(session => session.windowId && !session.reason
        && !liveWindowIds.includes(session.windowId))) {
        sessions.push(await this.attachWindow(id, session.id, windowId));
      }
    }
    const key = `recovery:${id}`;
    // Claim once per activation; each launch still goes through the existing restore RPC and host resource locks.
    if (this.restores.has(key)) {
      return { windowId, sessions, archives: [] };
    }
    // Closing the plugin suspends its windows; only individually archived/deleted sessions stay closed.
    const archives = this.list(id).archives.filter(record =>
      !this.groups?.list().some(group => group.id === record.groupId && group.archivedAt) && ((['interrupted', 'quit', 'upgrade', 'close'].includes(record.reason) && !record.nativeDeleted)
      || (record.reason === 'context-reset' && record.nativeDeleted)));
    const recovery = Promise.resolve({ windowId, sessions, archives });
    this.restores.set(key, recovery);
    return recovery;
  },

  restore(id, archiveId, windowId) {
    const key = `${id}:${archiveId}`;
    const existing = this.list(id).sessions.find((s) => !s.exited && s.restoredFrom === archiveId);
    if (existing) {
      return Promise.resolve(existing);
    }
    if (!this.restores.has(key)) {
      const pending = this.guard(id, async () => {
        const failed = this.active.has(archiveId) ? this.get(id, archiveId) : null;
        if (failed && (!failed.exited || failed.closing)) {
          throw fail('SESSION_BUSY', '会话仍在运行或关闭中');
        }
        await failed?.exitCleanup;
        const record = failed ? await this.readOutput(failed, { recovery: true })
          : await this.readArchive(id, archiveId, { recovery: true });
        if (record.nativeDeleted && record.reason !== 'context-reset') {
          throw fail('CONTEXT_DELETED', '引擎上下文已删除，请在历史中重试清理');
        }
        const adapter = this.adapter(id, record.adapterId);
        if (record.nativeDeleted) {
          record.contextId = undefined;
          record.output = '';
        } else if (adapter.restoreContext) {
          record.contextId = await adapter.restoreContext(record);
        }
        // A newly created window is recoverable before the CLI has assigned a native context.
        const resume = !!record.contextId && adapter.capabilities.restore;
        const created = await this.launch(id, { ...metadata(record), output: record.output,
          windowId: windowId || record.windowId, mode: record.nativeDeleted ? 'new' : resume ? 'resume' : undefined,
          contextId: resume ? record.contextId : undefined, restoredFrom: record.restoredFrom || archiveId }, record.outputSource);
        if (this.groups?.list().some(group => group.id === record.groupId && group.archivedAt)) {
          try {
            await this.groups.setArchived(record.groupId, false);
          } catch (error) {
            // Keep the history recoverable if reopening the group's persisted state fails.
            await this.archive(id, created.id, 'group-archived');
            throw error;
          }
          this.publish(id);
        }
        console.info('[session:restore]', { pluginId: id, archiveId, sessionId: created.id, resume: !!resume });
        // Keep the failed terminal intact if launching its replacement fails.
        if (failed) {
          await this.archive(id, failed.id, 'retried');
        }
        return created;
      });
      this.restores.set(key, pending);
      pending.finally(() => this.restores.delete(key)).catch(() => {});
    }
    return this.restores.get(key);
  },

  reconnect(id, sessionId) {
    return this.guard(id, async () => {
      const session = this.get(id, sessionId);
      this.assertIdle(session);
      const adapter = this.adapter(id, session.adapterId);
      if (!adapter.capabilities.restore) { throw fail('UNSUPPORTED_CAPABILITY', '此适配器不支持重新连接'); }
      const contextId = adapter.resolveContext ? await adapter.resolveContext(session) : session.contextId;
      if (!contextId) { throw fail('CONTEXT_UNKNOWN', '尚未识别上下文，请等待 CLI 完成本轮'); }
      await this.validateMcpReconnect?.(session);
      // Check recoverability while the original terminal is intact; an unsaved empty context needs no resume ID.
      const restoredContext = adapter.restoreContext ? await adapter.restoreContext(session) : contextId;
      this.assertIdle(session);
      // An explicit idle-only restart can refresh native tools without replaying a user prompt or business call.
      await this.archive(id, sessionId, 'reconnected');
      const created = await this.launch(id, { ...metadata(session), output: session.output, contextId: restoredContext,
        mode: restoredContext ? 'resume' : undefined, restoredFrom: session.restoredFrom || sessionId });
      console.info('[session:mcp-reconnect]', { pluginId: id, sessionId, replacementId: created.id });
      return created;
    });
  },

  resetContext(id, sessionId) {
    return this.guard(id, async () => {
      const session = this.get(id, sessionId);
      if (session.protocol !== 'managed-terminal' || !session.runtimeId
        || !['codex', 'claude'].includes(session.adapterId) || !this.deleteContext) {
        throw fail('DELETE_UNSUPPORTED', '此引擎不支持原生上下文清理，请使用独立安装的 Codex 或 Claude Code');
      }
      // A failed reset retains its stopped window so the same explicit action can retry safely.
      this.assertIdle(session.exited ? { ...session, exited: false } : session);
      const adapter = this.adapter(id, session.adapterId);
      session.contextId = !session.nativeDeleted && adapter.resolveContext ? await adapter.resolveContext(session) : session.contextId;
      if (!session.contextId) {
        throw fail('CONTEXT_UNKNOWN', '尚未识别引擎上下文，请等待会话就绪后重试');
      }
      this.assertIdle(session.exited ? { ...session, exited: false } : session);
      this.assertContextUnshared(session);
      session.closeAction = 'context-reset';
      session.closing = Promise.resolve().then(() => this.finishContextReset(session)).catch(error => {
        session.closing = null;
        session.activity = 'error';
        console.error('[session:context-reset]', { pluginId: id, sessionId, contextId: session.contextId, stack: error.stack });
        this.report(session, error);
        throw error;
      });
      return session.closing;
    });
  },

  async finishContextReset(session) {
    const id = session.pluginId;
    await this.persistCloseIntent(session, 'context-reset');
    await this.stopSession(session);
    session.exited = true;
    session.blocked = null;
    this.assertContextUnshared(session);
    if (!session.contextId) {
      throw fail('CONTEXT_UNKNOWN', '无法确认引擎上下文，清理未完成，请重试');
    }
    if (!session.nativeDeleted) {
      await this.deleteContext(session);
      session.nativeDeleted = true;
    }
    // Persist deletion before launch: a retry or restart must never resume the erased context.
    await this.storage.writeJson(this.key(session), metadata(session));
    const created = await this.launch(id, { ...metadata(session), mode: 'new', contextId: undefined,
      output: '', restoredFrom: session.restoredFrom || session.id });
    this.active.delete(session.id);
    this.archives.delete(session.restoredFrom || session.id);
    this.publish(id);
    console.info('[session:context-reset]', { pluginId: id, sessionId: session.id, replacementId: created.id });
    return created;
  },

  fork(id, sessionId, name) {
    return this.guard(id, async () => {
      const session = this.get(id, sessionId);
      const adapter = this.adapter(id, session.adapterId);
      if (!adapter.capabilities.fork) {
        throw fail('UNSUPPORTED_CAPABILITY', '此适配器不支持分叉');
      }
      this.assertIdle(session);
      const contextId = adapter.resolveContext ? await adapter.resolveContext(session) : session.contextId;
      if (!contextId) {
        throw fail('CONTEXT_UNKNOWN', '尚未识别上下文，请等待 CLI 完成本轮');
      }
      this.assertIdle(session);
      return this.launch(id, { ...metadata(session), restoredFrom: undefined, name, mode: 'fork', contextId });
    });
  },

  assertIdle(session) {
    if (this.inputBlocked || session.inputWrites || session.blocked || session.exited || session.closing || !['idle', 'done', 'error'].includes(session.activity)
      || Date.now() - (session.lastInputAt || 0) < 1000 || this.gitSwitches.has(session.git?.root)) {
      throw fail('SESSION_BUSY', '会话忙碌、等待输入或状态不可识别，请完成本轮后重试');
    }
  },

  async gitInfo(id, sessionId) {
    const session = this.get(id, sessionId);
    session.git = await readGit(session.git?.root || session.cwd);
    this.publish(id);
    return session.git;
  },

  async refreshGit(id, sessionId) {
    const session = this.get(id, sessionId);
    try {
      await fetchGitBranches(session.git?.root || session.cwd);
      const info = await this.gitInfo(id, sessionId);
      console.info('[git:refresh]', { pluginId: id, sessionId, root: info.root, branches: info.branches.length });
      return info;
    } catch (error) {
      console.error('[git:refresh-failed]', { pluginId: id, sessionId, cwd: session.cwd, stack: error.stack });
      throw error;
    }
  },

  async switchBranch(id, sessionId, branch) {
    if (this.launching) {
      throw fail('GIT_BUSY', '有会话正在启动，请稍后重试');
    }
    const info = await this.gitInfo(id, sessionId);
    if (this.launching) {
      throw fail('GIT_BUSY', '有会话正在启动，请稍后重试');
    }
    if (!info || !info.branches.includes(branch)) {
      throw fail('INVALID_ARGUMENT', '请选择存在的分支');
    }
    const peers = [...this.active.values()].filter((s) => s.git?.root === info.root);
    peers.forEach((s) => this.assertIdle(s));
    this.gitSwitches.add(info.root);
    console.info('[git:switch]', { pluginId: id, sessionId, root: info.root, branch });
    try {
      await switchGitBranch(info.root, branch);
    } finally {
      this.gitSwitches.delete(info.root);
      for (const session of peers) {
        session.git = await readGit(info.root);
        this.publish(session.pluginId);
      }
    }
  }
};
