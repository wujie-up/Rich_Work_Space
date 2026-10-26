import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';

const SECURITY = ['tls', 'starttls', 'none'];

// Mail secrets stay in this plugin's own data directory and never reach logs or run records.
export class Credentials {
  constructor({ storage, pluginId }) {
    Object.assign(this, { storage, pluginId });
  }

  #key() {
    return `plugin-data/${this.pluginId}/credentials.json`;
  }

  async #items() {
    const stored = await this.storage.readJson(this.#key(), { version: 1, items: [] });
    return Array.isArray(stored.items) ? stored.items : [];
  }

  async list() {
    const items = await this.#items();
    return items.map(({ password, ...rest }) => ({ ...rest, hasPassword: Boolean(password) }));
  }

  async secret(credentialId) {
    const item = (await this.#items()).find(entry => entry.id === credentialId);
    if (!item) {
      throw fail('CREDENTIAL_NOT_FOUND', `未找到邮件账号：${credentialId || '(空)'}`);
    }
    return item;
  }

  async save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw fail('INVALID_ARGUMENT', '邮件账号必须是对象');
    }
    const items = await this.#items();
    const existing = items.find(entry => entry.id === input.id);
    const current = { name: '', host: '', username: '', password: '', mailbox: 'INBOX', security: 'tls', port: 993,
      ...existing, ...input, id: input.id || existing?.id || randomUUID() };
    if (!String(current.name).trim() || !String(current.host).trim() || !String(current.username).trim()) {
      throw fail('INVALID_ARGUMENT', '邮件账号需要名称、服务器地址和登录账号');
    }
    if (!SECURITY.includes(current.security)) {
      throw fail('INVALID_ARGUMENT', '连接方式必须是 tls / starttls / none');
    }
    const port = Number(current.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw fail('INVALID_ARGUMENT', '端口必须是 1-65535 的整数');
    }
    // An empty password field means "keep the stored secret", because the UI never renders it back.
    const password = typeof current.password === 'string' && current.password ? current.password : existing?.password || '';
    if (!password) {
      throw fail('INVALID_ARGUMENT', '需要填写邮箱密码或授权码');
    }
    const item = { ...current, port, password };
    const next = existing ? items.map(entry => (entry.id === item.id ? item : entry)) : [...items, item];
    await this.storage.writeJson(this.#key(), { version: 1, items: next });
    return item.id;
  }

  async remove(credentialId) {
    const items = await this.#items();
    await this.storage.writeJson(this.#key(), { version: 1, items: items.filter(entry => entry.id !== credentialId) });
  }
}
