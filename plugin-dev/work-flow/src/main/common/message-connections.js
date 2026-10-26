import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';

const sanitized = ({ token, appSecret, ...connection }) => ({ ...connection, hasSecret: Boolean(token || appSecret) });

// Serialize the whole read/modify/write, not only the final filesystem write.
export class MessageConnections {
  #pending = Promise.resolve();

  constructor({ storage, pluginId }) {
    Object.assign(this, { storage, pluginId });
  }

  #key() {
    return `plugin-data/${this.pluginId}/message-connections.json`;
  }

  async #items() {
    return (await this.storage.readJson(this.#key(), { version: 1, items: [] })).items;
  }

  #mutate(change) {
    const result = this.#pending.then(async () => {
      const items = await this.#items();
      const { next, value } = change(items);
      await this.storage.writeJson(this.#key(), { version: 1, items: next });
      return value;
    });
    this.#pending = result.catch(() => {});
    return result;
  }

  async list() {
    await this.#pending;
    return (await this.#items()).map(sanitized);
  }

  async secret(id) {
    await this.#pending;
    const connection = (await this.#items()).find(item => item.id === id);
    if (!connection) {
      throw fail('CONNECTION_NOT_FOUND', '消息连接不存在');
    }
    return connection;
  }

  save(input) {
    return this.#mutate(items => {
      const existing = items.find(item => item.id === input?.id);
      if (!input || (input.id && !existing) || !['wechat', 'feishu'].includes(input.channel) || !String(input.name || '').trim()) {
        throw fail('INVALID_ARGUMENT', '消息连接需要有效渠道和名称；新增连接不能指定 ID');
      }
      if (existing && existing.channel !== input.channel) {
        throw fail('INVALID_ARGUMENT', '连接渠道不可更改，请新建连接');
      }
      const connection = { id: existing?.id || randomUUID(), channel: input.channel, name: String(input.name).trim() };
      if (input.channel === 'wechat') {
        connection.token = input.token || existing?.token || '';
        connection.endpoint = String(input.endpoint ?? existing?.endpoint ?? '').trim();
        if (typeof connection.token !== 'string' || !connection.token.trim()) {
          throw fail('INVALID_ARGUMENT', '需要填写 Wechaty 服务 Token');
        }
        if (connection.endpoint && !/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/.test(connection.endpoint)) {
          throw fail('INVALID_ARGUMENT', '服务端点格式为域名:端口，使用 SDK 默认 TLS');
        }
        if (connection.endpoint && (Number(connection.endpoint.split(':')[1]) < 1 || Number(connection.endpoint.split(':')[1]) > 65535)) {
          throw fail('INVALID_ARGUMENT', '服务端口必须在 1-65535 范围');
        }
      } else {
        connection.appId = String(input.appId ?? existing?.appId ?? '').trim();
        connection.appSecret = input.appSecret || existing?.appSecret || '';
        if (!connection.appId || typeof connection.appSecret !== 'string' || !connection.appSecret.trim()) {
          throw fail('INVALID_ARGUMENT', '需要填写飞书 App ID 和 App Secret');
        }
      }
      return { next: [...items.filter(item => item.id !== connection.id), connection], value: sanitized(connection) };
    });
  }

  remove(id, references = []) {
    return this.#mutate(items => {
      if (references.length) {
        throw fail('CONNECTION_IN_USE', `连接仍被工作流引用：${references.map(item => item.name).join('、')}`);
      }
      return { next: items.filter(item => item.id !== id) };
    });
  }
}
