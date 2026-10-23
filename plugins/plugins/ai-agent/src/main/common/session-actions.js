import { readGit, switchGitBranch } from './git.js';
import { fail } from '../../shared/contracts.js';
import { metadata } from './sessions.js';

// These operations share Sessions' owner and launch guards instead of a second process registry.
export const sessionActions = {
  restore(id, archiveId) {
    const key = `${id}:${archiveId}`;
    const existing = this.list(id).sessions.find((s) => s.restoredFrom === archiveId);
    if (existing) {
      return Promise.resolve(existing);
    }
    if (!this.restores.has(key)) {
      const pending = this.guard(id, async () => {
        const record = await this.readArchive(id, archiveId);
        const adapter = this.adapter(id, record.adapterId);
        if (!adapter.capabilities.restore) {
          throw fail('UNSUPPORTED_CAPABILITY', '此适配器不支持上下文恢复，可按原配置新建');
        }
        return this.launch(id, { ...record, mode: 'resume', restoredFrom: archiveId });
      });
      this.restores.set(key, pending);
      pending.finally(() => this.restores.delete(key)).catch(() => {});
    }
    return this.restores.get(key);
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
      return this.launch(id, { ...metadata(session), name, mode: 'fork', contextId });
    });
  },

  assertIdle(session) {
    if (session.blocked || session.exited || session.closing || !['idle', 'done', 'error'].includes(session.activity)
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

  async switchBranch(id, sessionId, branch) {
    if (this.launching) {
      throw fail('GIT_BUSY', '有会话正在启动，请稍后重试');
    }
    const info = await this.gitInfo(id, sessionId);
    if (this.launching) {
      throw fail('GIT_BUSY', '有会话正在启动，请稍后重试');
    }
    if (!info || !info.branches.includes(branch)) {
      throw fail('INVALID_ARGUMENT', '请选择存在的本地分支');
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
