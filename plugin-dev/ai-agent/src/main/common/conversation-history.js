import { stat } from 'node:fs/promises';

export const summary = ({ events, ...record }) => record;

// This index is disposable: the original conversation JSON remains the source of truth.
export class ConversationHistory {
  constructor(storage, pluginId, key) {
    this.storage = storage;
    this.pluginId = pluginId;
    this.key = key;
    this.indexKey = `plugin-data/${pluginId}/conversation-index.json`;
  }

  async index() {
    try {
      const index = await this.storage.readJson(this.indexKey);
      return new Map(index?.version === 1 && Array.isArray(index.entries)
        ? index.entries.map(entry => [entry.record.id, entry]) : []);
    } catch (error) {
      console.error('[ai:history-index-rebuild]', { pluginId: this.pluginId, message: error.message });
      return new Map();
    }
  }

  async fingerprint(id) {
    const info = await stat(await this.storage.path(this.key(id)));
    return { size: info.size, mtimeMs: info.mtimeMs };
  }

  async load(id, cached) {
    const info = await this.fingerprint(id);
    if (cached?.record?.id === id && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return summary(cached.record);
    }
    const record = await this.storage.readJson(this.key(id));
    if (record.state === 'running') {
      record.state = 'interrupted';
      await this.storage.writeJson(this.key(id), record);
    }
    return summary(record);
  }

  async save(records) {
    try {
      const entries = [];
      for (const record of records.values()) {
        entries.push({ record: summary(record), ...await this.fingerprint(record.id) });
      }
      await this.storage.writeJson(this.indexKey, { version: 1, entries });
    } catch (error) {
      // An unavailable cache must never prevent saving or closing the original history.
      console.error('[ai:history-index-write]', { pluginId: this.pluginId, message: error.message });
    }
  }
}
