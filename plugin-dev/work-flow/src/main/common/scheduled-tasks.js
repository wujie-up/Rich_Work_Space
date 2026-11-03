import { nextRunAt, parseLocal } from './triggers.js';

// Scheduling state is separate from canvas saves, so stale editor snapshots cannot reset a deadline.
export class ScheduledTasks {
  constructor({ storage, pluginId }) {
    Object.assign(this, { storage, pluginId });
    this.pending = Promise.resolve();
  }

  async list() {
    await this.pending;
    return (await this.storage.readJson(this.#key(), { version: 1, items: [] })).items;
  }

  #key() {
    return `plugin-data/${this.pluginId}/scheduled-tasks.json`;
  }

  // Serialize the entire read/modify/write, including updates from different workflows.
  #change(update) {
    const operation = this.pending.then(async () => {
      const document = await this.storage.readJson(this.#key(), { version: 1, items: [] });
      const result = update(document.items);
      if (result !== false) {
        await this.storage.writeJson(this.#key(), document);
      }
      return result;
    });
    // The caller receives the failure; a rejected update must not poison subsequent writes.
    this.pending = operation.catch(() => {});
    return operation;
  }

  async plan(workflow, now, runs = []) {
    return this.#change(items => {
      let row = items.find(item => item.workflowId === workflow.id);
      const trigger = JSON.stringify(workflow.trigger);
      if (!row) {
        row = { workflowId: workflow.id };
        items.push(row);
      }
      if (row.trigger !== trigger) {
        const isLegacy = row.trigger === undefined;
        const baseline = isLegacy ? Math.min(workflow.updatedAt ?? now, now) : now;
        row.nextAt = nextRunAt(workflow.trigger, baseline);
        if (workflow.trigger?.enabled && workflow.trigger.mode === 'once') {
          const at = parseLocal(workflow.trigger.at);
          // Legacy runs have no scheduler row; an already executed one-shot must not run again on upgrade.
          row.nextAt = isLegacy && runs.some(run => run.workflowId === workflow.id && run.startedAt >= at) ? null : at;
        }
        row.trigger = trigger;
        row.pendingAt = null;
      }
      const run = runs.find(run => run.id === row.lastRunId);
      if (run) {
        Object.assign(row, this.#result(run));
        if (row.pendingAt != null) {
          row.nextAt = nextRunAt(workflow.trigger, now, row.pendingAt);
          row.pendingAt = null;
        }
      }
      return { ...row };
    });
  }

  claim(workflow, { runId, source, startedAt, scheduledAt = null }) {
    return this.#change(items => {
      const row = items.find(item => item.workflowId === workflow.id);
      Object.assign(row, { lastRunId: runId, lastSource: source, lastStartedAt: startedAt,
        lastEndedAt: null, lastStatus: 'starting', lastError: null, pendingAt: scheduledAt });
    });
  }

  advance(workflow, now, scheduledAt) {
    return this.#change(items => {
      const row = items.find(item => item.workflowId === workflow.id);
      if (row?.trigger !== JSON.stringify(workflow.trigger) || row.nextAt !== scheduledAt) {
        return;
      }
      row.nextAt = nextRunAt(workflow.trigger, now, scheduledAt);
      row.pendingAt = null;
    });
  }

  changed(run) {
    const result = this.#result(run);
    return this.#change(items => {
      const row = items.find(item => item.workflowId === run.workflowId && item.lastRunId === run.id);
      if (!row) {
        return false;
      }
      Object.assign(row, result);
    });
  }

  #result(run) {
    return { lastStartedAt: run.startedAt, lastEndedAt: run.endedAt ?? null,
      lastStatus: run.status, lastError: run.error ? { ...run.error } : null };
  }

  retain(workflowIds) {
    return this.#change(items => {
      items.splice(0, items.length, ...items.filter(item => workflowIds.includes(item.workflowId)));
    });
  }
}
