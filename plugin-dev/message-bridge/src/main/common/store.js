// The host storage provides ordered atomic replacement and private file permissions.
export class BridgeStore {
  constructor(storage, pluginId, name, initial) {
    Object.assign(this, { storage, pluginId, key: `plugin-data/${pluginId}/${name}.json`, value: initial });
    this.writes = Promise.resolve();
  }

  async load() { this.value = await this.storage.readJson(this.key, this.value); }

  edit(change) {
    const pending = this.writes.then(async () => {
      const next = structuredClone(this.value);
      const result = await change(next);
      await this.storage.writeJson(this.key, next);
      this.value = next;
      return structuredClone(result);
    });
    this.writes = pending.catch(error => {
      console.error('[message-bridge:storage]', { pluginId: this.pluginId, key: this.key, stack: error.stack });
    });
    return pending;
  }
}
