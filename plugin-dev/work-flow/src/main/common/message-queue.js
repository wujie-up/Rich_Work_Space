import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { normalizedMessage } from './message-receiver.js';

const active = item => ['pending', 'claimed'].includes(item.status);

// Queue and dedup share one atomic file; an accepted response always follows a successful write.
export class MessageQueue {
  #pending = Promise.resolve();

  constructor({ storage, pluginId, now = () => Date.now() }) {
    Object.assign(this, { storage, pluginId, now });
  }

  #key() {
    return `plugin-data/${this.pluginId}/message-queue.json`;
  }

  #read() {
    return this.storage.readJson(this.#key(), { version: 1, items: [], seen: [] });
  }

  #mutate(change) {
    const result = this.#pending.then(async () => {
      const data = await this.#read();
      data.seen = data.seen.filter(entry => this.now() - entry.at < 86400000).slice(-10000);
      const value = change(data);
      const history = new Map();
      data.items = data.items.toReversed().filter(item => {
        if (active(item)) {
          return true;
        }
        const count = (history.get(item.workflowId) || 0) + 1;
        history.set(item.workflowId, count);
        return count <= 20;
      }).reverse();
      await this.storage.writeJson(this.#key(), data);
      return value;
    });
    this.#pending = result.catch(() => {});
    return result;
  }

  accept(workflow, node, message) {
    if (!normalizedMessage(message)) {
      return Promise.reject(fail('MESSAGE_INVALID', '消息缺少稳定 ID、发送人或文本超过 64 KiB'));
    }
    return this.#mutate(data => {
      const key = JSON.stringify([message.connectionId, message.messageId, workflow.id]);
      if (data.seen.some(entry => entry.key === key)) {
        return { accepted: false, reason: 'DUPLICATE' };
      }
      const item = { id: randomUUID(), workflowId: workflow.id, workflowName: workflow.name, entryNodeId: node.id,
        entryType: node.type, connectionId: node.params.connectionId, message, status: 'pending', receivedAt: this.now() };
      if (data.items.filter(entry => entry.workflowId === workflow.id && entry.status === 'pending').length >= 100) {
        data.items.push({ ...item, status: 'rejected', reason: 'QUEUE_FULL' });
        return { accepted: false, reason: 'QUEUE_FULL' };
      }
      data.items.push(item);
      data.seen.push({ key, at: this.now() });
      data.seen = data.seen.slice(-10000);
      return { accepted: true, item };
    });
  }

  claim(workflowId) {
    return this.#mutate(data => {
      if (data.items.some(item => item.workflowId === workflowId && item.status === 'claimed')) {
        return null;
      }
      const item = data.items.find(entry => entry.workflowId === workflowId && entry.status === 'pending');
      if (!item) {
        return null;
      }
      Object.assign(item, { status: 'claimed', runId: randomUUID(), startedAt: this.now() });
      return item;
    });
  }

  finish(id, result) {
    return this.#mutate(data => {
      const item = data.items.find(entry => entry.id === id);
      if (item) {
        Object.assign(item, { status: result.status, reason: result.reason || '', endedAt: this.now() });
      }
      return item;
    });
  }

  async list(workflowId) {
    await this.#pending;
    return (await this.#read()).items.filter(item => !workflowId || item.workflowId === workflowId);
  }

  clear(workflowId) {
    return this.#mutate(data => {
      data.items = data.items.filter(item => (workflowId && item.workflowId !== workflowId) || item.status === 'claimed');
    });
  }

  // Claimed work may already have written external state; never replay it after a crash.
  recover() {
    return this.#mutate(data => {
      data.items.filter(item => item.status === 'claimed').forEach(item => {
        Object.assign(item, { status: 'interrupted', reason: '进程退出后需核对外部结果再重新运行', endedAt: this.now() });
      });
    });
  }

  retry(id) {
    return this.#mutate(data => {
      const source = data.items.find(item => item.id === id);
      if (!source || active(source)) {
        throw fail('MESSAGE_RETRY_INVALID', '只能重新运行已结束或中断的消息');
      }
      if (data.items.filter(item => item.workflowId === source.workflowId && item.status === 'pending').length >= 100) {
        throw fail('QUEUE_FULL', '待执行消息已达到 100 条');
      }
      const { runId, startedAt, endedAt, reason, ...snapshot } = source;
      const item = { ...snapshot, id: randomUUID(), status: 'pending', retryOf: source.id, receivedAt: this.now() };
      data.items.push(item);
      return item;
    });
  }
}
