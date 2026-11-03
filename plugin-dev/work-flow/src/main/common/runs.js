const HISTORY_LIMIT = 20;

// Serialize each workflow's read/modify/write so parallel transitions cannot overwrite one another.
export class Runs {
  constructor({ storage, pluginId }) {
    Object.assign(this, { storage, pluginId });
    this.writes = new Map();
  }

  #key(workflowId) {
    return `plugin-data/${this.pluginId}/runs/${workflowId}.json`;
  }

  async list(workflowId, { checkpoints = false } = {}) {
    await this.writes.get(workflowId);
    const stored = await this.storage.readJson(this.#key(workflowId), []);
    const items = Array.isArray(stored) ? stored : [];
    return checkpoints ? items : items.map(({ checkpoint, ...run }) => run);
  }

  append(run) {
    const snapshot = structuredClone(run);
    const previous = this.writes.get(run.workflowId) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const stored = await this.storage.readJson(this.#key(run.workflowId), []);
      const items = (Array.isArray(stored) ? stored : []).filter(item => item.id !== snapshot.id);
      items.push(snapshot);
      const terminal = items.filter(item => !item.resumable && !['running', 'waiting'].includes(item.status)).slice(-HISTORY_LIMIT);
      await this.storage.writeJson(this.#key(run.workflowId), items.filter(item =>
        item.resumable || ['running', 'waiting'].includes(item.status) || terminal.includes(item)));
    });
    this.writes.set(run.workflowId, write);
    return write.finally(() => {
      if (this.writes.get(run.workflowId) === write) { this.writes.delete(run.workflowId); }
    });
  }
}
