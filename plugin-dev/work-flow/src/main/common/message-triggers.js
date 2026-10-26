import { createWechatReceiver } from './message-wechat.js';
import { createFeishuReceiver } from './message-feishu.js';
import { isMessageType, matchesMessage, validateMessageConnection } from './message-input.js';
import { fail } from './errors.js';

const enabled = workflow => workflow.trigger?.mode === 'message' && workflow.trigger.enabled === true;
const entryOf = workflow => workflow.nodes.find(node => isMessageType(node.type));
const terminal = status => ['succeeded', 'failed', 'canceled'].includes(status);

// SDK listeners are shared by connection; only this backend owns message-run dispatch and Agent polling.
export class MessageTriggers {
  #operations = Promise.resolve();
  #instances = new Map();
  #paused = new Set();
  #testing = new Set();
  #polling = new Map();
  #stopped = false;
  #timer;
  #scheduled;
  #summary = [];
  #metrics = new Map();
  #issues = [];

  constructor({ connections, queue, workflows, engine, storage, pluginId, logger, emit,
    receivers = { wechat: createWechatReceiver, feishu: createFeishuReceiver } }) {
    Object.assign(this, { connections, queue, workflows, engine, storage, pluginId, logger, emit, receivers });
    this.#timer = setInterval(() => { this.wake(); this.#poll(); }, 1000);
    this.#timer.unref?.();
  }

  #serialize(action) {
    const operation = this.#operations.then(action);
    this.#operations = operation.catch(() => {});
    return operation;
  }

  #error(event, fields = {}) {
    this.logger('error', event, { pluginId: this.pluginId, ...fields });
  }

  #metric(connectionId) {
    if (!this.#metrics.has(connectionId)) {
      this.#metrics.set(connectionId, { subscriptions: 0, received: 0, accepted: 0, ignored: 0, rejected: 0 });
    }
    return this.#metrics.get(connectionId);
  }

  status() {
    const ids = new Set([...this.#instances.keys(), ...this.#paused, ...this.#metrics.keys()]);
    return [...ids].map(connectionId => {
      const instance = this.#instances.get(connectionId);
      return { connectionId, channel: instance?.connection.channel, name: instance?.connection.name,
        state: this.#paused.has(connectionId) ? 'paused' : 'disconnected', ...instance?.status,
        ...this.#issues.find(issue => issue.connectionId === connectionId && !issue.workflowId),
        ...this.#metric(connectionId) };
    }).concat(this.#issues.filter(issue => issue.workflowId || !ids.has(issue.connectionId)));
  }

  snapshot() {
    return [...this.status().filter(item => ['connecting', 'connected', 'scan'].includes(item.state)).map(item => ({ id: `message:${item.connectionId}`,
      name: `${item.name} · 消息监听` })), ...this.#summary];
  }

  async #publish() {
    const items = await this.queue.list();
    this.#summary = items.filter(item => ['pending', 'claimed'].includes(item.status)).map(item => ({ id: `queue:${item.id}`,
      name: `${item.workflowName} · ${item.status === 'pending' ? '消息排队' : '消息执行/等待确认'}` }));
    this.emit('messages.changed', { connections: this.status() });
  }

  wake() {
    if (this.#stopped || this.#scheduled) {
      return;
    }
    this.#scheduled = setTimeout(() => {
      this.#scheduled = null;
      this.#serialize(() => this.#dispatch()).catch(() => this.#error('message-dispatch-failed'));
    }, 0);
  }

  changed(run) {
    if (run.origin?.kind === 'message') {
      this.wake();
    }
  }

  async #receive(instance, message) {
    if (this.#stopped || this.#instances.get(instance.connection.id) !== instance || this.#paused.has(instance.connection.id)) {
      return;
    }
    const workflows = await this.workflows.list();
    // Recheck after I/O: replacing credentials can invalidate the callback while storage is being read.
    if (this.#stopped || this.#instances.get(instance.connection.id) !== instance) {
      return;
    }
    const metric = this.#metric(instance.connection.id);
    let matched = false;
    for (const workflow of workflows.filter(enabled)) {
      const node = entryOf(workflow);
      if (this.#issues.some(issue => issue.workflowId === workflow.id)
        || node?.type !== `message.${message.channel}` || !matchesMessage(node.params, message)) {
        continue;
      }
      matched = true;
      const result = await this.queue.accept(workflow, node, message);
      metric[result.accepted ? 'accepted' : result.reason === 'DUPLICATE' ? 'ignored' : 'rejected']++;
      if (!result.accepted && result.reason !== 'DUPLICATE') {
        metric.lastIssue = 'queue-full';
      }
      this.logger('info', 'message-received', { connectionId: message.connectionId, messageId: message.messageId,
        workflowId: workflow.id, accepted: result.accepted, reason: result.reason });
    }
    metric.received++;
    metric.ignored += Number(!matched);
    metric.lastMessage = { messageId: message.messageId, chatId: message.chat.id, senderId: message.sender.id,
      receivedAt: message.receivedAt || Date.now() };
    await this.#publish();
    this.wake();
  }

  async #open(connectionId) {
    const connection = await this.connections.secret(connectionId);
    const instance = { connection, status: { state: 'connecting' } };
    this.#instances.set(connectionId, instance);
    instance.receiver = this.receivers[connection.channel]({ connection,
      dataDirectory: await this.storage.path(`plugin-data/${this.pluginId}/wechat/${connection.id}`), logger: this.logger,
      onMessage: message => this.#receive(instance, message),
      onActivity: ({ kind, reason }) => {
        if (!this.#stopped && this.#instances.get(connectionId) === instance) {
          const metric = this.#metric(connectionId);
          metric[kind]++;
          metric.lastIssue = reason;
          this.emit('messages.changed', { connections: this.status() });
        }
      },
      onStatus: status => {
        if (!this.#stopped && this.#instances.get(connectionId) === instance) {
          instance.status = status;
          this.emit('messages.changed', { connections: this.status() });
        }
      } });
    // Login and network connection may take minutes; they must not hold a view RPC open.
    instance.starting = Promise.resolve().then(() => instance.receiver.start()).catch(() => {
      if (this.#instances.get(connectionId) === instance) {
        instance.status = { state: 'error', error: '消息连接失败，请检查连接配置或重新连接' };
        this.emit('messages.changed', { connections: this.status() });
      }
      this.#error('message-connect-failed', { connectionId });
    });
  }

  async #close(connectionId) {
    const instance = this.#instances.get(connectionId);
    this.#instances.delete(connectionId);
    if (instance) {
      try {
        await instance.receiver.stop();
      } catch {
        this.#error('message-disconnect-failed', { connectionId });
      }
    }
  }

  async #refresh() {
    if (this.#stopped) {
      return [];
    }
    const workflows = await this.workflows.list();
    const connections = await this.connections.list();
    this.#issues = [];
    this.#metrics.forEach(metric => { metric.subscriptions = 0; });
    const subscribed = [];
    for (const workflow of workflows.filter(enabled)) {
      const connectionId = entryOf(workflow)?.params.connectionId;
      try {
        validateMessageConnection(workflow, connections);
        subscribed.push(connectionId);
        this.#metric(connectionId).subscriptions++;
      } catch {
        this.#issues.push({ connectionId, workflowId: workflow.id, name: workflow.name, state: 'error',
          error: '消息入口或连接无效，请重新选择同渠道连接并保存' });
        this.#error('message-subscription-invalid', { workflowId: workflow.id, connectionId });
      }
    }
    subscribed.forEach(id => this.#testing.delete(id));
    const desired = new Set([...subscribed, ...this.#testing]);
    for (const id of this.#instances.keys()) {
      if (!desired.has(id) || this.#paused.has(id)) {
        await this.#close(id);
      }
    }
    for (const id of desired) {
      if (id && !this.#paused.has(id) && !this.#instances.has(id)) {
        try {
          await this.#open(id);
        } catch {
          await this.#close(id);
          this.#issues.push({ connectionId: id, state: 'error', error: '连接初始化失败，请检查配置并重新连接' });
          this.#error('message-connect-failed', { connectionId: id });
        }
      }
    }
    await this.#publish();
    this.wake();
    return this.status();
  }

  refresh() {
    return this.#serialize(() => this.#refresh());
  }

  // Configuration writes and dispatch share a lock, so pending work always sees the saved definition.
  change(action, connectionId) {
    return this.#serialize(async () => {
      if (connectionId) {
        await this.#close(connectionId);
      }
      try {
        return await action();
      } finally {
        await this.#refresh();
      }
    });
  }

  test(connectionId) {
    return this.#serialize(async () => {
      this.#testing.add(connectionId);
      this.#paused.delete(connectionId);
      await this.#refresh();
      return this.status();
    });
  }

  disconnect(connectionId) {
    return this.#serialize(async () => {
      this.#paused.add(connectionId);
      this.#testing.delete(connectionId);
      await this.#close(connectionId);
      await this.#publish();
      return this.status();
    });
  }

  reconnect(connectionId) {
    return this.#serialize(async () => {
      this.#paused.delete(connectionId);
      this.#testing.add(connectionId);
      await this.#close(connectionId);
      await this.#refresh();
      return this.status();
    });
  }

  retry(itemId) {
    return this.change(async () => {
      const source = (await this.queue.list()).find(item => item.id === itemId);
      const workflow = source && (await this.workflows.list()).find(item => item.id === source.workflowId);
      if (!workflow || !enabled(workflow) || this.#paused.has(source.connectionId)) {
        throw fail('MESSAGE_RETRY_DISABLED', '请先启用该消息工作流及连接，再核对外部结果并重新运行');
      }
      return this.queue.retry(itemId);
    });
  }

  async #dispatch() {
    if (this.#stopped) {
      return;
    }
    const workflows = await this.workflows.list();
    for (const item of await this.queue.list()) {
      if (item.status !== 'claimed') {
        continue;
      }
      const run = this.engine.records.get(item.runId);
      if (run && terminal(run.status)) {
        await this.queue.finish(item.id, { status: run.status, reason: run.error?.code });
      }
    }
    for (const item of (await this.queue.list()).filter(item => item.status === 'pending')) {
      const workflow = workflows.find(entry => entry.id === item.workflowId);
      const node = workflow && entryOf(workflow);
      if (!node || node.id !== item.entryNodeId || node.type !== item.entryType || node.params.connectionId !== item.connectionId) {
        await this.queue.finish(item.id, { status: 'invalid', reason: '入口或连接已更改，请核对配置' });
      }
    }
    for (const workflow of workflows.filter(enabled)) {
      const connectionId = entryOf(workflow)?.params.connectionId;
      if (this.#stopped || this.#issues.some(issue => issue.workflowId === workflow.id)
        || this.#paused.has(connectionId) || !this.#instances.has(connectionId) || this.engine.activeRun(workflow.id)) {
        continue;
      }
      const item = await this.queue.claim(workflow.id);
      if (!item || this.#stopped) {
        continue;
      }
      try {
        await this.engine.start(workflow, { runId: item.runId, entryNodeId: item.entryNodeId, message: item.message });
      } catch (error) {
        await this.queue.finish(item.id, { status: 'interrupted', reason: '启动失败，请核对运行记录和外部结果' });
        this.#error('message-start-failed', { workflowId: workflow.id, messageId: item.message.messageId, runId: item.runId,
          code: error.code || 'START_FAILED' });
      }
    }
    await this.#publish();
  }

  #poll() {
    if (this.#stopped) {
      return;
    }
    for (const run of this.engine.records.values()) {
      if (run.origin?.kind !== 'message' || run.status !== 'waiting' || run.pending?.kind !== 'service' || this.#polling.has(run.id)) {
        continue;
      }
      const task = this.engine.resume(run.id).catch(() => this.#error('message-resume-failed', { runId: run.id }))
        .finally(() => { this.#polling.delete(run.id); this.wake(); });
      this.#polling.set(run.id, task);
    }
  }

  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    clearTimeout(this.#scheduled);
    await this.#operations;
    for (const id of this.#instances.keys()) {
      await this.#close(id);
    }
    this.#paused.clear();
    this.#testing.clear();
    this.#summary = [];
    this.#metrics.clear();
    this.#issues = [];
  }
}
