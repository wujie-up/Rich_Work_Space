import { randomUUID } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import transport from '../../../../dist/main/capture-proxy.cjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

export class CaptureManager {
  constructor(options) {
    Object.assign(this, options);
    this.instanceId = randomUUID();
    this.relays = new Map();
    this.leases = new Map();
    this.pending = new Map();
    this.now ||= Date.now;
    this.createProxy ||= options => new transport.CaptureProxy(options);
  }

  enabled(id) { return (this.leases.get(id)?.expires || 0) > this.now(); }

  key(record) { return this.relays.get(record.id)?.url || (this.enabled(record.id) ? `pending:${record.id}` : null); }

  catalog() {
    const groups = new Map([...this.conversations.windows].map(([id, value]) => [id, { id, name: value.name, conversations: [] }]));
    for (const record of this.conversations.records?.values() || this.conversations.list()) {
      const id = record.windowId || 'legacy';
      if (!groups.has(id)) { groups.set(id, { id, name: id === 'legacy' ? '历史对话（未归属窗口）' : `窗口 ${id.slice(0, 8)}`, conversations: [] }); }
      groups.get(id).conversations.push({ id: record.id, name: record.name, engineId: record.engineId || 'codex', state: record.state,
        supported: ['codex', 'claude'].includes(record.engineId || 'codex') });
    }
    return { version: 2, instanceId: this.instanceId, windows: [...groups.values()] };
  }

  record(input) {
    if (input.instanceId !== this.instanceId) { throw Error('Agent 运行实例已变化，请刷新目标'); }
    const record = this.conversations.records ? this.conversations.records.get(input.conversationId) : this.conversations.read(input.conversationId);
    if (!record || (record.windowId || 'legacy') !== input.windowId) { throw Error('目标对话不属于指定窗口'); }
    return record;
  }

  status(record) {
    const relay = this.relays.get(record.id);
    const enabled = this.enabled(record.id);
    const connected = Boolean(relay && this.conversations.engines.get(record.id)?.captureKey === relay.url);
    let state = enabled ? 'waiting' : 'stopped';
    if (enabled && connected) { state = relay.log.sequence > (this.leases.get(record.id)?.baseline || 0) ? 'captured' : 'connected'; }
    return { enabled, state, running: record.state === 'running', supported: ['codex', 'claude'].includes(record.engineId || 'codex'),
      logDirectory: join(this.root, record.id), error: relay?.log.error || null };
  }

  async handle(input = {}) {
    if (input.action === 'catalog') { return this.catalog(); }
    const record = this.record(input);
    if (input.action === 'status') { return this.status(record); }
    if (input.action === 'configure') {
      if (!uuid(input.ownerId) || typeof input.enabled !== 'boolean') { throw Error('抓包控制参数无效'); }
      if (!['codex', 'claude'].includes(record.engineId || 'codex')) { throw Error('该引擎尚不支持网络抓包'); }
      const previous = this.leases.get(record.id);
      if (this.enabled(record.id) && previous.ownerId !== input.ownerId) { throw Error('该对话已被其他抓包实例占用'); }
      this.leases.set(record.id, { ownerId: input.ownerId, expires: input.enabled ? this.now() + 20000 : 0,
        baseline: this.enabled(record.id) ? previous.baseline : this.relays.get(record.id)?.log.sequence || 0 });
      return this.status(record);
    }
    if (!['list', 'read'].includes(input.action)) { throw Error('未知抓包操作'); }
    if (!await access(join(this.root, record.id)).then(() => true, () => false)) {
      if (input.action === 'list') { return []; }
      throw Error('目标对话尚无抓包记录');
    }
    const log = this.relays.get(record.id)?.log || new transport.CaptureLog(join(this.root, record.id));
    return input.action === 'list' ? log.list() : log.read(input.id, input.offset);
  }

  async target(record, launch) {
    if (this.destination) { return this.destination(record, launch); }
    if (record.engineId === 'claude') {
      return { upstream: 'https://api.anthropic.com', paths: /^\/v1\/(messages(?:\/count_tokens)?|models)$/ };
    }
    const auth = JSON.parse(await readFile(join(launch.env.CODEX_HOME, 'auth.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') { return '{}'; }
      throw error;
    }));
    return { upstream: auth.OPENAI_API_KEY || auth.auth_mode === 'apikey' ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api/codex' };
  }

  async prepare(record, launch) {
    if (!this.relays.has(record.id) && this.enabled(record.id)) {
      if (!this.pending.has(record.id)) {
        this.pending.set(record.id, (async () => {
          const destination = await this.target(record, launch);
          const relay = this.createProxy({ root: join(this.root, record.id), ...destination, proxyUrl: launch.env.HTTPS_PROXY,
            identity: { conversationId: record.id, windowId: record.windowId || 'legacy', engineId: record.engineId || 'codex' },
            isRecording: () => this.enabled(record.id) });
          try { await relay.start(); this.relays.set(record.id, relay); }
          catch (error) { await relay.close(); throw error; }
        })().finally(() => this.pending.delete(record.id)));
      }
      await this.pending.get(record.id);
    }
    const relay = this.relays.get(record.id);
    if (!relay) { return { key: null, args: launch.args, env: launch.env }; }
    return record.engineId === 'claude'
      ? { key: relay.url, args: launch.args, env: { ...launch.env, ANTHROPIC_BASE_URL: relay.url } }
      : { key: relay.url, args: [...launch.args, '-c', `openai_base_url=${JSON.stringify(relay.url)}`], env: launch.env };
  }

  async close() {
    this.leases.clear();
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.relays.values()].map(relay => relay.close()));
    this.relays.clear();
  }
}
