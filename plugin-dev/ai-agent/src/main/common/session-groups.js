import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { agentRole, groupManagerRole, roleCatalog } from '../../shared/agent-roles.js';
import { metadata } from './sessions.js';
import { fail, sessionName } from '../../shared/contracts.js';

// Membership belongs to persisted sessions, not the lifetime of a terminal process or view.
export class SessionGroups {
  constructor({ pluginId, storage, sessions }) {
    Object.assign(this, { pluginId, storage, sessions });
    this.records = [];
    this.coordinators = new Map();
    this.archiving = new Map();
    this.retryAfter = new Map();
  }

  async load() {
    this.records = await this.storage.readJson(`plugin-data/${this.pluginId}/groups.json`, []);
    // Legacy groups were collaborative; explicit ordinary groups must never acquire a leader on reload.
    const records = this.records.map(group => ({ ...group, collaboration: group.collaboration ?? true,
      ...((group.collaboration ?? true) ? { coordinatorId: this.legacyCoordinatorId(group) || randomUUID() } : {}) }));
    if (JSON.stringify(records) !== JSON.stringify(this.records)) {
      await this.storage.writeJson(`plugin-data/${this.pluginId}/groups.json`, records);
      this.records = records;
    }
    // Rename only system defaults; preserve user names and all saved engine context fields.
    for (const session of [...this.sessions.archives.values(), ...this.sessions.active.values()]) {
      if (!this.isCoordinator(session) || !['组长', '协调', '协调者', '协助者'].includes(session.name)) { continue; }
      try {
        const key = this.sessions.key(session);
        const saved = await this.storage.readJson(key);
        await this.storage.writeJson(key, { ...saved, name: '组管理员' });
        session.name = '组管理员';
        console.info('[session:group-manager-renamed]', { pluginId: this.pluginId, sessionId: session.id, groupId: session.groupId });
      } catch (error) {
        console.error('[session:group-manager-rename-failed]', { pluginId: this.pluginId, sessionId: session.id, error: error.stack });
      }
    }
  }

  // Old groups may have received an unused endpoint during upgrade while their original coordinator retained its history.
  legacyCoordinatorId(group) {
    if (group.coordinator) { return group.coordinatorId; }
    const members = [...this.sessions.archives.values(), ...this.sessions.active.values()]
      .filter(session => session.pluginId === this.pluginId && session.groupId === group.id);
    if (members.some(session => (session.restoredFrom || session.id) === group.coordinatorId)) { return group.coordinatorId; }
    const candidates = new Set(members.filter(session => ['协调', '协调者', '协助者'].includes(session.name))
      .map(session => session.restoredFrom || session.id));
    if (candidates.size !== 1) { return group.coordinatorId; }
    const [coordinatorId] = candidates;
    console.info('[session:legacy-coordinator-found]', { pluginId: this.pluginId, groupId: group.id,
      previousCoordinatorId: group.coordinatorId, coordinatorId });
    return coordinatorId;
  }

  list() { return this.records.map(record => ({ ...record })); }

  get(id) {
    const group = this.records.find(record => record.id === id);
    if (!group) { throw fail('GROUP_NOT_FOUND', '会话组不存在'); }
    return group;
  }

  isCollaborative(groupId) {
    return this.records.some(group => group.id === groupId && group.collaboration === true && !group.archivedAt);
  }

  isCoordinator(session) {
    return Boolean(this.records.some(group => group.collaboration && group.id === session.groupId
      && group.coordinatorId === (session.restoredFrom || session.id)));
  }

  assertRemovable(session) {
    if (this.isCoordinator(session)) { throw fail('COORDINATOR_REQUIRED', '固定组管理员不可单独移出、归档或删除；可删除整个会话组'); }
  }

  // Stable logical identity survives process upgrades; historical groups open their coordinator only when a member is open.
  async ensureCoordinator(groupId, member) {
    const group = this.get(groupId);
    if (!group.collaboration || group.archivedAt || this.archiving.has(groupId)) { return null; }
    const live = [...this.sessions.active.values()].find(session => this.isCoordinator(session) && session.groupId === groupId);
    if (live) { return metadata(live); }
    if (this.coordinators.has(groupId)) { return this.coordinators.get(groupId); }
    if (Date.now() < (this.retryAfter.get(groupId) || 0) || this.sessions.inputBlocked) { return null; }
    const pending = Promise.resolve().then(async () => {
      const archived = this.sessions.archives.get(group.coordinatorId);
      if (archived) { return this.sessions.restore(this.pluginId, group.coordinatorId, member.windowId); }
      // restoredFrom reserves a logical endpoint; this is a fresh native context, not a resume of a missing engine session.
      const config = group.coordinator || { adapterId: member.adapterId, permission: member.permission };
      const roles = roleCatalog(await this.storage.readJson(`plugin-data/${this.pluginId}/roles.json`, {}));
      const manager = roles.items.find(role => role.id === groupManagerRole.id);
      return this.sessions.create(this.pluginId, { ...config, name: '组管理员', agentRole: manager,
        groupId, cwd: config.cwd || member.cwd, windowId: member.windowId, restoredFrom: group.coordinatorId, mode: 'new', contextId: undefined });
    });
    this.coordinators.set(groupId, pending);
    try {
      const created = await pending;
      console.info('[session:group-coordinator-created]', { pluginId: this.pluginId, groupId, sessionId: created.id });
      return created;
    } catch (error) {
      this.retryAfter.set(groupId, Date.now() + 60000);
      console.error('[session:group-coordinator-failed]', { pluginId: this.pluginId, groupId, error: error.stack });
      throw error;
    } finally {
      this.coordinators.delete(groupId);
    }
  }

  // Validate every member before launching any process; engine failures retain the successfully created windows.
  async create(input) {
    const name = sessionName(input.name);
    if (input.collaboration !== undefined && typeof input.collaboration !== 'boolean') {
      throw fail('INVALID_ARGUMENT', '协作模式需为开关值');
    }
    const collaboration = input.collaboration === true;
    if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 12) {
      throw fail('INVALID_ARGUMENT', '会话成员数量需为 1–12');
    }
    const members = input.members.map(member => {
      this.sessions.adapter(this.pluginId, member.adapterId);
      // New group windows share the full-access default; explicit selections and saved sessions retain their boundary.
      return { name: sessionName(member.name), adapterId: member.adapterId, permission: member.permission || 'unrestricted',
        agentRole: agentRole(member.agentRole) };
    });
    if (new Set(members.map(member => member.name)).size !== members.length) {
      throw fail('INVALID_ARGUMENT', '同组成员名称不能重复');
    }
    const coordinator = { name: '组管理员', adapterId: input.coordinator?.adapterId || members[0].adapterId,
      permission: input.coordinator?.permission || 'unrestricted' };
    if (collaboration) { this.sessions.adapter(this.pluginId, coordinator.adapterId); }
    if (collaboration && members.some(member => member.name === coordinator.name)) { throw fail('INVALID_ARGUMENT', '组管理员为固定成员，请使用其他成员名称'); }
    const cwd = await this.workingDirectory(input.cwd, '默认');
    for (const [index, member] of members.entries()) {
      member.cwd = await this.workingDirectory(input.members[index].cwd?.trim() || cwd, member.name);
    }
    if (collaboration) {
      coordinator.cwd = await this.workingDirectory(input.coordinator?.cwd?.trim() || cwd, coordinator.name);
    }
    const group = { id: randomUUID(), name, collaboration,
      ...(collaboration ? { coordinatorId: randomUUID(), coordinator } : {}), createdAt: new Date().toISOString() };
    const records = [...this.records, group];
    await this.storage.writeJson(`plugin-data/${this.pluginId}/groups.json`, records);
    this.records = records;
    // Archiving must await a member already launching, rather than leave it running after the group closes.
    let finishMembers;
    this.coordinators.set(group.id, new Promise(resolve => { finishMembers = resolve; }));
    const sessions = [];
    const errors = [];
    for (const member of members) {
      if (this.archiving.has(group.id)) {
        break;
      }
      try {
        sessions.push(await this.sessions.create(this.pluginId, { ...member, windowId: input.windowId, groupId: group.id }));
      } catch (error) {
        console.error('[session:group-member-create-failed]', { pluginId: this.pluginId, groupId: group.id,
          memberName: member.name, error: error.stack });
        errors.push({ name: member.name, message: error.message });
      }
    }
    this.coordinators.delete(group.id);
    finishMembers();
    try {
      const created = await this.ensureCoordinator(group.id, { ...coordinator, cwd, windowId: input.windowId });
      if (created) { sessions.push(created); }
    } catch (error) {
      errors.push({ name: coordinator.name, message: error.message });
    }
    console.info('[session:group-created]', { pluginId: this.pluginId, groupId: group.id, members: sessions.length, failed: errors.length });
    this.sessions.publish(this.pluginId);
    return { group, sessions, errors };
  }

  // Resolve inheritance before persisting the group so invalid member paths cannot leave a partial group.
  async workingDirectory(value, memberName) {
    const cwd = value?.trim().replace(/^~(?=\/|$)/, homedir());
    if (!cwd || !isAbsolute(cwd)) { throw fail('INVALID_ARGUMENT', `${memberName}：请选择有效的绝对工作目录`); }
    try {
      if (!(await stat(cwd)).isDirectory()) { throw fail('INVALID_ARGUMENT', `${memberName}：工作目录不是文件夹`); }
    } catch (error) {
      console.error('[session:group-directory-invalid]', { pluginId: this.pluginId, memberName, cwd, error: error.stack });
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) { throw fail('INVALID_ARGUMENT', `${memberName}：工作目录不存在`); }
      throw error;
    }
    return cwd;
  }

  async rename(groupId, value) {
    const group = this.get(groupId);
    const name = sessionName(value);
    const records = this.records.map(record => record.id === groupId ? { ...record, name } : record);
    try {
      await this.storage.writeJson(`plugin-data/${this.pluginId}/groups.json`, records);
      this.records = records;
    } catch (error) {
      console.error('[session:group-rename-failed]', { pluginId: this.pluginId, groupId, error: error.stack });
      throw error;
    }
    console.info('[session:group-renamed]', { pluginId: this.pluginId, groupId, name });
    this.sessions.publish(this.pluginId);
    return { ...group, name };
  }

  // Share one close operation and prevent the watchdog from starting a replacement coordinator.
  async archive(groupId) {
    this.get(groupId);
    if (!this.archiving.has(groupId)) {
      this.archiving.set(groupId, Promise.resolve().then(() => this.finishArchive(groupId)));
    }
    return this.archiving.get(groupId);
  }

  // Persist suspension before stopping processes; stale activity must never prevent an explicit archive.
  async finishArchive(groupId) {
    try {
      await this.coordinators.get(groupId)?.catch(error => {
        console.error('[session:group-archive-coordinator-failed]', { pluginId: this.pluginId, groupId, error: error.stack });
        return null;
      });
      const members = [...this.sessions.active.values()].filter(session => session.pluginId === this.pluginId && session.groupId === groupId);
      const archive = members.reduceRight((next, session) => () => this.sessions.queueInput(session, next), async () => {
        await this.setArchived(groupId, true);
        await this.sessions.coordination?.stop(groupId);
        for (const session of members) {
          // A member's own close may finish while the group waits for its input queue or persistence.
          if (this.sessions.active.has(session.id)) {
            await this.sessions.archive(this.pluginId, session.id, 'group-archived');
          }
        }
      });
      await archive();
      console.info('[session:group-archived]', { pluginId: this.pluginId, groupId, members: members.length });
    } catch (error) {
      console.error('[session:group-archive-failed]', { pluginId: this.pluginId, groupId, error: error.stack });
      throw error;
    } finally {
      this.archiving.delete(groupId);
      this.sessions.publish(this.pluginId);
    }
  }

  async setArchived(groupId, archived) {
    const group = this.get(groupId);
    const records = this.records.map(record => record.id === groupId
      ? { ...record, archivedAt: archived ? group.archivedAt || new Date().toISOString() : undefined } : record);
    try {
      await this.storage.writeJson(`plugin-data/${this.pluginId}/groups.json`, records);
      this.records = records;
    } catch (error) {
      console.error('[session:group-archive-state-failed]', { pluginId: this.pluginId, groupId, archived, error: error.stack });
      throw error;
    }
  }

  // Hold member input queues together so peer delivery cannot start midway through dissolving a group.
  async delete(groupId) {
    this.get(groupId);
    if (this.coordinators.has(groupId)) { throw fail('SESSION_BUSY', '组管理员正在启动，请稍后删除会话组'); }
    const members = [...this.sessions.active.values()].filter(session => session.pluginId === this.pluginId && session.groupId === groupId);
    const remove = members.reduceRight((next, session) => () => this.sessions.queueInput(session, next), async () => {
      if (members.some(session => session.closing || session.blocked || !['idle', 'done', 'error'].includes(session.activity))) {
        throw fail('SESSION_BUSY', '请等待组内会话空闲后删除会话组');
      }
      await this.removeMembership(groupId, members);
    });
    try {
      await remove();
    } catch (error) {
      console.error('[session:group-delete-failed]', { pluginId: this.pluginId, groupId, error: error.stack });
      throw error;
    }
    console.info('[session:group-deleted]', { pluginId: this.pluginId, groupId, members: members.length });
    this.sessions.publish(this.pluginId);
  }

  // Include hidden restored ancestors, preserving engine contexts and logs while removing only membership.
  async removeMembership(groupId, members) {
    const archives = [...this.sessions.archives.values()].filter(session => session.pluginId === this.pluginId && session.groupId === groupId);
    const changes = [];
    for (const session of [...members, ...archives]) {
      const key = this.sessions.key(session);
      changes.push({ key, before: await this.storage.readJson(key) });
    }
    changes.push({ key: `plugin-data/${this.pluginId}/groups.json`, before: this.records });
    const written = [];
    const records = this.records.filter(record => record.id !== groupId);
    try {
      for (const change of changes) {
        await this.storage.writeJson(change.key, change === changes.at(-1) ? records : { ...change.before, groupId: undefined });
        written.push(change);
      }
    } catch (error) {
      for (const change of written.reverse()) {
        try {
          await this.storage.writeJson(change.key, change.before);
        } catch (rollbackError) {
          console.error('[session:group-delete-rollback-failed]', { pluginId: this.pluginId, groupId,
            key: change.key, error: rollbackError.stack });
        }
      }
      throw error;
    }
    this.records = records;
    members.forEach(session => { delete session.groupId; });
    archives.forEach(session => this.sessions.archives.set(session.id, { ...session, groupId: undefined }));
  }

  assign(sessionId, groupId) {
    if (groupId && this.get(groupId).archivedAt) { throw fail('GROUP_ARCHIVED', '请先恢复会话组再添加成员'); }
    // History dialogs can outlive a restore; resolve the live generation before applying the idle guard.
    const live = this.sessions.list(this.pluginId).sessions.find(session => session.id === sessionId || session.restoredFrom === sessionId);
    if (!live) { return this.assignArchive(sessionId, groupId); }
    const session = this.sessions.get(this.pluginId, live.id);
    this.assertRemovable(session);
    // Share the native input queue so no peer task can execute under an identity that has not been saved.
    return this.sessions.queueInput(session, async () => {
      if (session.closing || session.blocked || !['idle', 'done', 'error'].includes(session.activity)) {
        throw fail('SESSION_BUSY', '请等待会话空闲后调整分组');
      }
      try {
        await this.storage.writeJson(this.sessions.key(session), { ...metadata(session), groupId: groupId || undefined, output: session.output });
        session.groupId = groupId || undefined;
      } catch (error) {
        console.error('[session:group-assign-failed]', { pluginId: this.pluginId, sessionId, groupId, error: error.stack });
        throw error;
      }
      console.info('[session:group-assigned]', { pluginId: this.pluginId, sessionId, groupId });
      this.sessions.publish(this.pluginId);
      return metadata(session);
    });
  }

  // Change only saved membership; loading the terminal log would rewrite potentially large history into metadata.
  async assignArchive(sessionId, groupId) {
    try {
      const archive = this.sessions.archives.get(sessionId);
      if (archive?.pluginId !== this.pluginId) {
        throw fail('SESSION_NOT_FOUND', '归档不存在或归属不符');
      }
      this.assertRemovable(archive);
      const record = { ...await this.storage.readJson(this.sessions.key(archive)), groupId: groupId || undefined };
      await this.storage.writeJson(this.sessions.key(record), record);
      this.sessions.archives.set(sessionId, metadata(record));
      console.info('[session:group-assigned]', { pluginId: this.pluginId, sessionId, groupId, archived: true });
      this.sessions.publish(this.pluginId);
      return metadata(record);
    } catch (error) {
      console.error('[session:group-assign-failed]', { pluginId: this.pluginId, sessionId, groupId, error: error.stack });
      throw error;
    }
  }
}
