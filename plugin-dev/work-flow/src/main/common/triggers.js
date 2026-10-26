import { fail } from './errors.js';

export const MODES = ['manual', 'once', 'interval', 'message'];
export const UNITS = ['second', 'minute', 'hour', 'day', 'month', 'year'];
const FIXED_UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };
const MAX_DELAY = 2147483647;
const MAX_STEPS = 10000;

// A trigger is stored as readable local-time values, so the workflow file stays editable by hand.
export function normalizeTrigger(input) {
  const mode = input?.mode || 'manual';
  if (!MODES.includes(mode)) {
    throw fail('INVALID_ARGUMENT', `运行方式必须是 ${MODES.join(' / ')}`);
  }
  if (mode === 'manual') {
    return { mode: 'manual', at: '', every: 1, unit: 'minute', enabled: false };
  }
  if (mode === 'message') {
    return { mode, enabled: input.enabled === true, at: '', every: 1, unit: 'minute' };
  }
  const enabled = input.enabled !== false;
  if (mode === 'once') {
    if (parseLocal(input.at) === null) {
      throw fail('INVALID_ARGUMENT', '固定时间触发需要有效的时间（YYYY-MM-DD HH:mm）');
    }
    return { mode: 'once', at: String(input.at), every: 1, unit: 'minute', enabled };
  }
  const every = Math.floor(Number(input.every));
  if (!Number.isInteger(every) || every < 1) {
    throw fail('INVALID_ARGUMENT', '固定周期触发需要大于 0 的周期数');
  }
  if (!UNITS.includes(input.unit)) {
    throw fail('INVALID_ARGUMENT', `周期单位必须是 ${UNITS.join(' / ')}`);
  }
  return { mode: 'interval', at: '', every, unit: input.unit, enabled };
}

export function parseLocal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second || 0));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function addStep(from, every, unit) {
  if (FIXED_UNIT_MS[unit]) {
    return new Date(from).getTime() + every * FIXED_UNIT_MS[unit];
  }
  const months = unit === 'year' ? every * 12 : every;
  const date = new Date(from);
  const day = date.getDate();
  // A monthly or yearly cycle keeps the day of month, clamped to the last day of a shorter month.
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, last));
  return date.getTime();
}

// Missed occurrences are skipped: a desktop that was closed must not replay a backlog of runs.
export function nextRunAt(trigger, from = Date.now(), anchor = null) {
  if (!trigger || ['manual', 'message'].includes(trigger.mode) || !trigger.enabled) {
    return null;
  }
  if (trigger.mode === 'once') {
    const at = parseLocal(trigger.at);
    return at !== null && at > from ? at : null;
  }
  let next = addStep(anchor ?? from, trigger.every, trigger.unit);
  let steps = 0;
  while (next <= from && steps < MAX_STEPS) {
    next = addStep(next, trigger.every, trigger.unit);
    steps += 1;
  }
  return next;
}

export class Scheduler {
  constructor({ workflows, engine, logger, pluginId, now = () => Date.now(), maxDelay = MAX_DELAY }) {
    Object.assign(this, { workflows, engine, logger, pluginId, now, maxDelay });
    this.timers = new Map();
    this.anchors = new Map();
  }

  anchor(workflowId) {
    return this.anchors.get(workflowId) ?? null;
  }

  async refresh() {
    const items = await this.workflows.list();
    const wanted = new Set();
    for (const workflow of items) {
      const at = nextRunAt(workflow.trigger, this.now(), this.anchor(workflow.id));
      if (at === null) {
        this.#clear(workflow.id);
        continue;
      }
      wanted.add(workflow.id);
      const timer = this.timers.get(workflow.id);
      if (timer && timer.at === at) {
        continue;
      }
      this.#clear(workflow.id);
      this.timers.set(workflow.id, { at, handle: this.#arm(workflow.id, at) });
    }
    for (const workflowId of [...this.timers.keys()]) {
      if (!wanted.has(workflowId)) {
        this.#clear(workflowId);
      }
    }
    return this.planned();
  }

  async list() {
    const items = await this.workflows.list();
    return items.map(workflow => ({ workflowId: workflow.id, mode: workflow.trigger?.mode || 'manual',
      enabled: Boolean(workflow.trigger?.enabled), nextAt: nextRunAt(workflow.trigger, this.now(), this.anchor(workflow.id)) }));
  }

  stop() {
    for (const workflowId of [...this.timers.keys()]) {
      this.#clear(workflowId);
    }
    this.anchors.clear();
  }

  planned() {
    return [...this.timers.entries()].map(([workflowId, timer]) => ({ workflowId, nextAt: timer.at }));
  }

  #arm(workflowId, at) {
    // setTimeout cannot hold more than about 24 days, so a long cycle wakes up early and only re-plans.
    const delay = Math.min(Math.max(at - this.now(), 20), this.maxDelay);
    return setTimeout(() => { void this.#fire(workflowId, at); }, delay);
  }

  #clear(workflowId) {
    const timer = this.timers.get(workflowId);
    if (!timer) {
      return;
    }
    clearTimeout(timer.handle);
    this.timers.delete(workflowId);
  }

  async #fire(workflowId, at) {
    this.timers.delete(workflowId);
    // A cycle longer than the timer limit wakes up early; that wake-up re-plans and must not run anything.
    if (this.now() < at) {
      await this.#replan(workflowId);
      return;
    }
    try {
      const workflow = await this.workflows.read(workflowId);
      if (this.engine.activeRun(workflowId)) {
        this.logger('info', 'trigger-skip', { pluginId: this.pluginId, workflowId, reason: '上一次运行尚未结束' });
      } else {
        const run = await this.engine.start(workflow);
        this.logger('info', 'trigger-fire', { pluginId: this.pluginId, workflowId, runId: run.id,
          mode: workflow.trigger?.mode || 'manual' });
      }
    } catch (error) {
      this.logger('error', 'trigger-failed', { pluginId: this.pluginId, workflowId, message: error.message });
    }
    // Anchoring to the planned time keeps a cycle from drifting with every run.
    this.anchors.set(workflowId, at);
    await this.#replan(workflowId);
  }

  // Re-reading the workflows can fail while another write is in flight; a timer must never reject.
  async #replan(workflowId) {
    try {
      await this.refresh();
    } catch (error) {
      this.logger('error', 'trigger-failed', { pluginId: this.pluginId, workflowId, message: error.message });
    }
  }
}
