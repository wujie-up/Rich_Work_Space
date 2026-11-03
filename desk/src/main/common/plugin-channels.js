import { open, mkdir, rm, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../../shared/contracts.js';

const RETENTION = 7 * 86400000;
const FILE_LIMIT = 10 * 1024 * 1024;
const BUDGET = 256 * 1024 * 1024;
const unfinished = message => ['pending', 'claimed'].includes(message.status);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
const copy = value => structuredClone(value);

// The host knows opaque endpoints and transport receipts, never the plugin's activity or approval rules.
export class PluginChannels {
  constructor({ storage, usable }) {
    Object.assign(this, { storage, usable });
    this.endpoints = new Map();
    this.pending = new Map();
  }

  assertLive(source) {
    if (source.closed || !this.usable(source)) {
      throw fail('PLUGIN_UNAVAILABLE', '通信运行实例已失效');
    }
  }

  registry(source) {
    let entries = this.endpoints.get(source.id);
    if (!entries) {
      entries = new Map();
      this.endpoints.set(source.id, entries);
    }
    return entries;
  }

  endpoint(source, endpointId) {
    const endpoint = this.registry(source).get(endpointId);
    if (!endpoint || endpoint.source !== source) {
      throw fail('CHANNEL_ENDPOINT', '通信端点不存在或不属于当前实例');
    }
    return endpoint;
  }

  key(id) { return `plugin-data/${id}/channels/index.json`; }

  // Serial disk transactions also fence file copies against revoke and concurrent quota checks.
  serial(id, action) {
    const previous = this.pending.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.pending.set(id, current);
    current.finally(() => {
      if (this.pending.get(id) === current) { this.pending.delete(id); }
    }).catch(() => {});
    return current;
  }

  async records(id) {
    const messages = await this.storage.readJson(this.key(id), []);
    let changed = false;
    for (const message of messages) {
      // A host restart cannot establish whether a claimed native input reached its destination.
      if (message.status === 'claimed' && ![...this.registry({ id }).values()].some(e => e.source.instanceId === message.claimedBy)) {
        Object.assign(message, { status: 'uncertain', finishedAt: Date.now(), error: 'runtime_lost' });
        changed = true;
      }
    }
    const kept = messages.filter(message => unfinished(message) || Date.now() - message.finishedAt < RETENTION);
    if (changed || kept.length !== messages.length) { await this.storage.writeJson(this.key(id), kept); }
    const files = await this.storage.path(`plugin-data/${id}/channels/files`);
    await mkdir(files, { recursive: true, mode: 0o700 });
    const referenced = new Set(kept.filter(message => message.attachments?.length).map(message => message.messageId));
    for (const entry of await readdir(files)) {
      if (!referenced.has(entry)) { await rm(join(files, entry), { recursive: true, force: true }); }
    }
    return kept;
  }

  request(source, action, input = {}) {
    return this.serial(source.id, async () => {
      this.assertLive(source);
      if (!['register', 'unregister', 'list', 'send', 'inbox', 'claim', 'settle'].includes(action)) {
        throw fail('METHOD_NOT_FOUND', '通信方法不存在');
      }
      const messages = await this.records(source.id);
      this.assertLive(source);
      return copy(await this[action](source, input, messages));
    });
  }

  register(source, { endpointId, metadata = {} }) {
    if (!identifier(endpointId) || JSON.stringify(metadata).length > 8192) {
      throw fail('INVALID_ARGUMENT', '通信端点或元数据无效');
    }
    const existing = this.registry(source).get(endpointId);
    if (existing && existing.source !== source) { throw fail('CHANNEL_ENDPOINT', '通信端点已被其他实例占用'); }
    this.registry(source).set(endpointId, { source, metadata: copy(metadata) });
    return { endpointId };
  }

  async unregister(source, { endpointId, discard = false }, messages) {
    const existing = this.registry(source).get(endpointId);
    if (existing && existing.source !== source) { throw fail('CHANNEL_ENDPOINT', '通信端点不属于当前实例'); }
    this.registry(source).delete(endpointId);
    if (discard) {
      for (const message of messages.filter(m => m.recipient === endpointId && unfinished(m))) {
        Object.assign(message, { status: message.status === 'claimed' ? 'uncertain' : 'failed', error: 'endpoint_deleted', finishedAt: Date.now() });
      }
      await this.storage.writeJson(this.key(source.id), messages);
      for (const message of messages.filter(m => m.recipient === endpointId && m.error === 'endpoint_deleted')) {
        await this.removeFiles(source.id, message.messageId);
        message.attachments = [];
      }
      await this.storage.writeJson(this.key(source.id), messages);
    }
    return true;
  }

  list(source, input, messages) {
    return [...this.registry(source)].filter(([, endpoint]) => this.usable(endpoint.source) && !endpoint.source.closed)
      .map(([endpointId, endpoint]) => ({ endpointId, metadata: endpoint.metadata,
        pending: messages.filter(message => message.recipient === endpointId && unfinished(message)).length }));
  }

  validateSend(input, messages) {
    if (!identifier(input.requestId) || typeof input.text !== 'string' || !input.text.trim()
      || Buffer.byteLength(input.text) > 65536 || !Array.isArray(input.files || []) || (input.files || []).length > 5
      || (input.replyTo !== undefined && !identifier(input.replyTo))) {
      throw fail('INVALID_ARGUMENT', '消息需要请求标识、非空文本（最多 64 KiB）及最多 5 个文件');
    }
    if (messages.filter(m => m.recipient === input.targetId && unfinished(m)).length >= 100) {
      throw fail('CHANNEL_QUOTA', '目标通信队列已满');
    }
  }

  async send(source, input, messages) {
    const { endpointId, targetId, requestId, text, files = [], replyTo } = input;
    this.endpoint(source, endpointId);
    const duplicate = messages.find(m => m.sender === endpointId && m.requestId === requestId);
    if (duplicate) { return duplicate; }
    const target = this.registry(source).get(targetId);
    if (targetId === endpointId || !target || target.source.closed || !this.usable(target.source)) {
      throw fail('CHANNEL_ENDPOINT', '目标端点不可用或为发送端点自身');
    }
    this.validateSend(input, messages);
    const messageId = randomUUID();
    let committed = false;
    try {
      const used = messages.filter(unfinished).flatMap(m => m.attachments).reduce((sum, file) => sum + file.size, 0);
      const attachments = await this.snapshot({ source, messageId, files, budget: BUDGET - used });
      this.assertLive(source);
      if (this.registry(source).get(targetId) !== target || target.source.closed || !this.usable(target.source)) {
        throw fail('CHANNEL_ENDPOINT', '文件复制期间目标端点已关闭');
      }
      const message = { messageId, sender: endpointId, recipient: targetId, requestId, text, replyTo,
        createdAt: Date.now(), status: 'pending', attachments };
      await this.storage.writeJson(this.key(source.id), [...messages, message]);
      committed = true;
      // Revoke removes endpoints synchronously while the atomic disk write is awaiting completion.
      this.assertLive(source);
      this.endpoint(source, endpointId);
      if (this.registry(source).get(targetId) !== target || target.source.closed || !this.usable(target.source)) {
        throw fail('CHANNEL_ENDPOINT', '消息保存期间目标端点已关闭');
      }
      console.info('[plugin:channel-send]', { pluginId: source.id, messageId, sender: endpointId, recipient: targetId });
      this.notify(target.source, targetId);
      return message;
    } catch (error) {
      if (committed) { await this.storage.writeJson(this.key(source.id), messages); }
      await this.removeFiles(source.id, messageId);
      console.error('[plugin:channel-send]', { pluginId: source.id, messageId, endpointId, error: error.stack });
      throw error;
    }
  }

  async snapshot({ source, messageId, files, budget }) {
    const result = [];
    if (!files.length) { return result; }
    const directory = await this.storage.path(`plugin-data/${source.id}/channels/files/${messageId}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of files) {
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await input.stat();
        if (!info.isFile() || info.size > FILE_LIMIT || info.size > budget) {
          throw fail('CHANNEL_QUOTA', '附件必须为普通文件，单个最多 10 MiB，未处理附件合计最多 256 MiB');
        }
        const destination = join(directory, randomUUID());
        const output = await open(destination, 'wx', 0o600);
        const hash = createHash('sha256');
        let size = 0;
        try {
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            size += chunk.length;
            if (size > FILE_LIMIT || size > budget) { throw fail('CHANNEL_QUOTA', '复制时附件超过容量限制'); }
            hash.update(chunk);
            await output.writeFile(chunk);
          }
        } finally {
          await output.close();
        }
        budget -= size;
        result.push({ name: basename(path), path: destination, size, sha256: hash.digest('hex') });
      } finally {
        await input.close();
      }
    }
    return result;
  }

  inbox(source, { endpointId, messageId }, messages) {
    this.endpoint(source, endpointId);
    return messages.filter(m => (m.recipient === endpointId || m.sender === endpointId) && (!messageId || m.messageId === messageId));
  }

  async claim(source, { endpointId, messageId }, messages) {
    this.endpoint(source, endpointId);
    const first = messages.find(m => m.recipient === endpointId && unfinished(m));
    if (!first || first.messageId !== messageId || first.status !== 'pending') {
      throw fail('CHANNEL_ORDER', '只能领取队列中最早的未处理消息');
    }
    Object.assign(first, { status: 'claimed', claimedBy: source.instanceId });
    await this.storage.writeJson(this.key(source.id), messages);
    return first;
  }

  async settle(source, { endpointId, messageId, status, error }, messages) {
    this.endpoint(source, endpointId);
    const message = messages.find(m => m.recipient === endpointId && m.messageId === messageId);
    if (message?.status !== 'claimed' || message.claimedBy !== source.instanceId
      || !['delivered', 'failed', 'uncertain', 'pending'].includes(status)) {
      throw fail('CHANNEL_RECEIPT', '投递回执与当前领取实例不符');
    }
    Object.assign(message, { status, error: typeof error === 'string' ? error.slice(0, 1024) : undefined,
      finishedAt: status === 'pending' ? undefined : Date.now() });
    await this.storage.writeJson(this.key(source.id), messages);
    return message;
  }

  notify(source, endpointId) {
    try {
      source.notifyChannel?.({ endpointId });
    } catch (error) {
      console.error('[plugin:channel-notify]', { pluginId: source.id, endpointId, error: error.stack });
    }
  }

  removeFiles(id, messageId) {
    return this.storage.path(`plugin-data/${id}/channels/files/${messageId}`).then(path => rm(path, { recursive: true, force: true }));
  }

  revoke(source) {
    // Remove registrations synchronously so a copy in progress cannot commit to a dead endpoint.
    for (const [id, endpoint] of this.registry(source)) {
      if (endpoint.source === source) { this.registry(source).delete(id); }
    }
    return this.serial(source.id, async () => {
      const messages = await this.records(source.id);
      for (const message of messages.filter(m => m.status === 'claimed' && m.claimedBy === source.instanceId)) {
        Object.assign(message, { status: 'uncertain', error: 'runtime_lost', finishedAt: Date.now() });
      }
      await this.storage.writeJson(this.key(source.id), messages);
    }).catch(error => {
      console.error('[plugin:channel-revoke]', { pluginId: source.id, instanceId: source.instanceId, error: error.stack });
    });
  }
}
