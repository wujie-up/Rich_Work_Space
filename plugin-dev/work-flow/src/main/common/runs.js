const HISTORY_LIMIT = 20;

// Each workflow keeps a bounded list of recent runs so long node output never grows without limit.
export class Runs {
  constructor({ storage, pluginId }) {
    Object.assign(this, { storage, pluginId });
  }

  #key(workflowId) {
    return `plugin-data/${this.pluginId}/runs/${workflowId}.json`;
  }

  async list(workflowId) {
    const stored = await this.storage.readJson(this.#key(workflowId), []);
    return Array.isArray(stored) ? stored : [];
  }

  async append(run) {
    const items = (await this.list(run.workflowId)).filter(item => item.id !== run.id);
    items.push(run);
    await this.storage.writeJson(this.#key(run.workflowId), items.slice(-HISTORY_LIMIT));
  }
}
