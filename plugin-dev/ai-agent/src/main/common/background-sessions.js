import { randomUUID } from 'node:crypto';

const terminal = state => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);

// Session handles expose only conversations owned by the calling plugin, never personal chats.
export class BackgroundSessions {
  constructor(options) {
    Object.assign(this, options);
    this.records = new Map();
    this.starts = new Map();
    this.writes = Promise.resolve();
  }

  async load() {
    for (const record of await this.storage.readJson(`plugin-data/${this.pluginId}/background-sessions.json`, [])) {
      this.records.set(record.id, record);
    }
  }

  persist() {
    const snapshot = structuredClone([...this.records.values()]);
    const write = this.writes.then(() => this.storage.writeJson(`plugin-data/${this.pluginId}/background-sessions.json`, snapshot));
    this.writes = write.catch(() => {});
    return write;
  }

  get(id, context, mutate = false) {
    const record = this.records.get(id);
    if (!record || record.caller.pluginId !== context.caller?.pluginId
      || (mutate && record.caller.instanceId !== context.caller.instanceId)) {
      throw Error('只能访问所属插件的后台会话');
    }
    return record;
  }

  start(input, context) {
    if (!context.authorizationId) {
      return Promise.reject(Error('后台会话需要工作台授权'));
    }
    const key = `${context.caller.pluginId}:${context.caller.instanceId}:${input.bindingKey}`;
    if (this.starts.has(key)) {
      return this.starts.get(key).then(() => this.start(input, context));
    }
    const work = this.startOnce(input, context).finally(() => this.starts.delete(key));
    this.starts.set(key, work);
    return work;
  }

  async startOnce(input, context) {
    context.signal?.throwIfAborted();
    let record = input.sessionId ? this.get(input.sessionId, context, true) : [...this.records.values()].find(item =>
      item.bindingKey === input.bindingKey && item.caller.pluginId === context.caller.pluginId
      && item.caller.instanceId === context.caller.instanceId && !item.archivedAt);
    if (record?.archivedAt) { throw Error('会话已归档'); }
    if (record && record.bindingKey !== input.bindingKey) { throw Error('会话与节点绑定不一致'); }
    const created = !record;
    if (!record) {
      record = { id: randomUUID(), caller: context.caller, bindingKey: input.bindingKey, name: input.name || 'Agent',
        createdAt: Date.now(), taskKeys: [] };
      this.records.set(record.id, record);
    }
    if (record.taskKeys.includes(input.taskKey)) {
      return this.read({ sessionId: record.id }, context);
    }
    if (this.tasks.records.has(input.taskKey)) { throw Error('任务句柄已被占用'); }
    const previous = record.taskKeys.at(-1) && this.tasks.get(record.taskKeys.at(-1));
    if (previous && !terminal(previous.state)) { throw Error('会话上一轮尚未完成'); }
    const conversationId = previous?.conversationId;
    try {
      await this.tasks.start(input.mode === 'code' ? 'code' : 'plan', input, {
        conversationId, background: { authorizationId: context.authorizationId, caller: context.caller }
      });
    } catch (error) {
      if (created) { this.records.delete(record.id); }
      throw error;
    }
    record.taskKeys.push(input.taskKey);
    await this.persist();
    if (context.signal?.aborted) {
      await this.close({ sessionId: record.id }, context);
      context.signal.throwIfAborted();
    }
    console.info('[ai:background-start]', { sessionId: record.id, bindingKey: record.bindingKey, taskKey: input.taskKey });
    return this.read({ sessionId: record.id }, context);
  }

  async read({ sessionId }, context) {
    const record = this.get(sessionId, context);
    const taskKey = record.taskKeys.at(-1);
    return { ...await this.tasks.read({ taskKey }), sessionId, taskKey, name: record.name, archivedAt: record.archivedAt };
  }

  async respond(input, context) {
    const record = this.get(input.sessionId, context, true);
    if (!context.authorizationId || record.archivedAt) { throw Error('会话授权已失效'); }
    return this.tasks.respond({ ...input, taskKey: record.taskKeys.at(-1) });
  }

  async cancel(input, context) {
    const record = this.get(input.sessionId, context, true);
    return this.tasks.cancel({ taskKey: record.taskKeys.at(-1) });
  }

  async history({ sessionId, afterSequence = 0, limit = 100 }, context) {
    const record = this.get(sessionId, context);
    const task = this.tasks.get(record.taskKeys.at(-1));
    if (!task.conversationId) { return { events: [], hasMore: false, nextSequence: afterSequence }; }
    const conversation = await this.conversations.read(task.conversationId);
    const events = conversation.events.filter(event => event.sequence > afterSequence).slice(0, Math.max(1, Math.min(200, limit)));
    return { events, hasMore: conversation.events.length > (events.at(-1)?.sequence || afterSequence),
      nextSequence: events.at(-1)?.sequence || afterSequence, archivedAt: record.archivedAt };
  }

  async close(input, context) {
    const record = this.get(input.sessionId, context, true);
    if (!record.archivedAt) {
      const task = this.tasks.get(record.taskKeys.at(-1));
      await this.tasks.cancel({ taskKey: task.taskKey });
      if (task.conversationId) { await this.conversations.archive(task.conversationId); }
      record.archivedAt = Date.now();
      await this.persist();
    }
    return { archivedAt: record.archivedAt };
  }

  async stop() {
    await Promise.allSettled(this.starts.values());
    for (const record of this.records.values()) {
      if (!record.archivedAt) {
        try {
          await this.close({ sessionId: record.id }, { caller: record.caller });
        } catch (error) {
          console.error('[ai:background-close-failed]', { sessionId: record.id, bindingKey: record.bindingKey, message: error.message });
        }
      }
    }
    await this.writes;
  }
}

export async function registerBackgroundSessions(capabilities, sessions) {
  const sessionId = { type: 'string', maxLength: 100 };
  const requestId = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  const start = { sessionId, bindingKey: { type: 'string', maxLength: 300 }, taskKey: { type: 'string', minLength: 64, maxLength: 64 },
    name: { type: 'string', maxLength: 200 }, prompt: { type: 'string', minLength: 1 }, mode: { type: 'string', enum: ['plan', 'code'] },
    cwd: { type: 'string' }, files: { type: 'array', items: { type: 'string' }, maxItems: 30 } };
  for (const [method, properties, required, effects] of [
    ['start', start, ['bindingKey', 'taskKey', 'prompt', 'mode'], ['workspace.write']],
    ['read', { sessionId }, ['sessionId'], ['workspace.read']],
    ['history', { sessionId, afterSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      ['sessionId'], ['workspace.read']],
    ['respond', { sessionId, requestId, answers: { type: 'object' }, decision: { type: 'string' } },
      ['sessionId', 'requestId'], ['workspace.write']],
    ['cancel', { sessionId }, ['sessionId'], ['workspace.read']],
    ['close', { sessionId }, ['sessionId'], ['workspace.read']]
  ]) {
    await capabilities.register({ id: `agent.session.${method}.v1`, version: 1, title: `后台 Agent · ${method}`,
      description: '工作台协调的后台会话管理接口', inputSchema: { type: 'object', properties, required, additionalProperties: false },
      outputSchema: { type: 'object' }, effects, confirmation: 'policy',
      execution: { timeoutMs: 30000, cancellable: true, retry: 'never' }, state: 'ready' },
    (input, context) => sessions[method](input, context));
  }
}
