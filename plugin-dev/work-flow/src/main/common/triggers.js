import { fail } from './errors.js';
import { randomUUID } from 'node:crypto';

export const MODES = ['manual', 'once', 'daily', 'interval', 'message'];
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
  if (mode === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.at ?? ''))) {
      throw fail('INVALID_ARGUMENT', '每日固定时间需要有效的时间（HH:mm）');
    }
    if (input.timezone !== undefined && input.timezone !== 'Asia/Shanghai') {
      throw fail('INVALID_ARGUMENT', '每日固定时间目前只支持北京时间（Asia/Shanghai）');
    }
    return { mode, at: String(input.at), timezone: 'Asia/Shanghai', enabled };
  }
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

// Compute the next future occurrence; Scheduler separately restores one persisted overdue occurrence.
export function nextRunAt(trigger, from = Date.now(), anchor = null) {
  if (!trigger || ['manual', 'message'].includes(trigger.mode) || !trigger.enabled) {
    return null;
  }
  if (trigger.mode === 'once') {
    const at = parseLocal(trigger.at);
    return at !== null && at > from ? at : null;
  }
  if (trigger.mode === 'daily') {
    // Beijing stays at UTC+8; UTC arithmetic avoids the host timezone and daylight-saving transitions.
    const offset = 8 * FIXED_UNIT_MS.hour;
    const [hour, minute] = trigger.at.split(':').map(Number);
    const day = Math.floor((from + offset) / FIXED_UNIT_MS.day) * FIXED_UNIT_MS.day - offset;
    const at = day + hour * FIXED_UNIT_MS.hour + minute * FIXED_UNIT_MS.minute;
    return at > from ? at : at + FIXED_UNIT_MS.day;
  }
  let next = addStep(anchor ?? from, trigger.every, trigger.unit);
  if (FIXED_UNIT_MS[trigger.unit] && next <= from) {
    const step = trigger.every * FIXED_UNIT_MS[trigger.unit];
    return next + (Math.floor((from - next) / step) + 1) * step;
  }
  let steps = 0;
  while (next <= from && steps < MAX_STEPS) {
    next = addStep(next, trigger.every, trigger.unit);
    steps += 1;
  }
  return next;
}

export class Scheduler {
  constructor({ workflows, engine, tasks, emit = () => {}, logger, pluginId, now = () => Date.now(), maxDelay = MAX_DELAY }) {
    Object.assign(this, { workflows, engine, tasks, emit, logger, pluginId, now, maxDelay });
    this.timers = new Map();
    this.anchors = new Map();
    this.revision = 0;
    this.starting = new Set();
    this.refreshing = Promise.resolve();
    this.stopped = false;
    this.generations = new Map();
    this.inFlight = new Map();
    this.removing = new Set();
  }

  anchor(workflowId) {
    return this.anchors.get(workflowId) ?? null;
  }

  async refresh() {
    const revision = this.revision;
    const operation = this.refreshing.then(() => this.#refresh(revision));
    this.refreshing = operation.catch(error => {
      this.logger('error', 'trigger-refresh-failed', { pluginId: this.pluginId, stack: error.stack });
      return this.planned();
    });
    return this.refreshing;
  }

  async #refresh(revision) {
    const items = await this.workflows.list();
    if (this.stopped || revision !== this.revision) {
      return this.planned();
    }
    const wanted = new Set();
    for (const workflow of items) {
      const trigger = JSON.stringify(workflow.trigger);
      const timer = this.timers.get(workflow.id);
      if (timer?.trigger === trigger) {
        wanted.add(workflow.id);
        continue;
      }
      if (timer) {
        this.anchors.delete(workflow.id);
      }
      const row = this.tasks ? await this.tasks.plan(workflow, this.now(), [...this.engine.records.values()]) : null;
      if (revision !== this.revision) {
        return this.planned();
      }
      const at = row ? row.nextAt : nextRunAt(workflow.trigger, this.now(), this.anchor(workflow.id));
      if (at === null) {
        this.#clear(workflow.id);
        this.anchors.delete(workflow.id);
        continue;
      }
      wanted.add(workflow.id);
      this.#clear(workflow.id);
      this.timers.set(workflow.id, { at, trigger, handle: this.#arm(workflow.id, at) });
    }
    for (const workflowId of [...this.timers.keys()]) {
      if (!wanted.has(workflowId)) {
        this.#clear(workflowId);
        this.anchors.delete(workflowId);
      }
    }
    await this.tasks?.retain(items.map(item => item.id));
    if (revision !== this.revision) {
      return this.planned();
    }
    await this.#publish();
    return this.planned();
  }

  async list() {
    const items = await this.workflows.list();
    let records = [];
    try {
      records = await this.tasks?.list() || [];
    } catch (error) {
      this.logger('error', 'trigger-list-failed', { pluginId: this.pluginId, stack: error.stack });
    }
    return items.map(workflow => {
      const { trigger, pendingAt, ...record } = records.find(row => row.workflowId === workflow.id) || {};
      return { ...record, workflowId: workflow.id, mode: workflow.trigger?.mode || 'manual',
        enabled: Boolean(workflow.trigger?.enabled), nextAt: this.timers.get(workflow.id)?.at ?? null };
    });
  }

  // Immediate tests share the normal engine but never consume a scheduled occurrence.
  async triggerNow(workflowId) {
    const admission = this.#admission(workflowId);
    return this.#track(workflowId, this.#triggerNow(workflowId, admission));
  }

  async #triggerNow(workflowId, admission) {
    this.#assertCurrent(workflowId, admission);
    const workflow = await this.workflows.read(workflowId);
    this.#assertCurrent(workflowId, admission);
    if (this.starting.has(workflowId) || this.engine.activeRun(workflowId)) {
      throw fail('RUN_BUSY', '该工作流正在运行中，请等待结束后再触发');
    }
    return this.#start(workflow, { ...admission, source: 'manual' });
  }

  async #start(workflow, admission) {
    this.starting.add(workflow.id);
    const { source, scheduledAt = null } = admission;
    const runId = randomUUID();
    try {
      this.#assertCurrent(workflow.id, admission);
      await this.#claim(workflow, { runId, source, startedAt: this.now(), scheduledAt });
      this.#assertCurrent(workflow.id, admission);
      if (source === 'schedule' && (this.timers.get(workflow.id)?.at !== scheduledAt
        || this.timers.get(workflow.id)?.trigger !== JSON.stringify(workflow.trigger))) {
        throw fail('TRIGGER_CHANGED', '定时配置已修改，未启动旧任务');
      }
      const run = await this.engine.start(workflow, { runId });
      await this.record(this.engine.records?.get(run.id) || run);
      this.logger('info', 'trigger-fire', { pluginId: this.pluginId, workflowId: workflow.id, runId, source, scheduledAt });
      return run;
    } catch (error) {
      await this.record({ id: runId, workflowId: workflow.id, status: 'failed', startedAt: this.now(),
        endedAt: this.now(), error: { code: error.code || 'TRIGGER_FAILED', message: error.message } });
      throw error;
    } finally {
      this.starting.delete(workflow.id);
    }
  }

  #admission(workflowId) {
    return { revision: this.revision, generation: this.generations.get(workflowId) || 0 };
  }

  #assertCurrent(workflowId, admission) {
    if (this.stopped || admission.revision !== this.revision) {
      throw fail('PLUGIN_STOPPING', '插件正在停止，未启动工作流');
    }
    if (this.removing.has(workflowId) || admission.generation !== (this.generations.get(workflowId) || 0)) {
      throw fail('TRIGGER_CHANGED', '工作流已删除，未启动任务');
    }
  }

  #track(workflowId, operation) {
    const tracked = operation.finally(() => { this.inFlight.delete(tracked); });
    this.inFlight.set(tracked, workflowId);
    return tracked;
  }

  // Invalidate admitted requests before deletion checks the engine for runs to cancel.
  invalidate(workflowId) {
    this.removing.add(workflowId);
    this.generations.set(workflowId, (this.generations.get(workflowId) || 0) + 1);
    this.#clear(workflowId);
    this.anchors.delete(workflowId);
    return () => this.removing.delete(workflowId);
  }

  async drain(workflowId) {
    await Promise.allSettled([...this.inFlight].filter(([, id]) => !workflowId || id === workflowId).map(([task]) => task));
    await this.refreshing;
  }

  async #claim(workflow, claim) {
    try {
      await this.tasks?.plan(workflow, this.now(), [...(this.engine.records?.values() || [])]);
      await this.tasks?.claim(workflow, claim);
    } catch (error) {
      this.logger('error', 'trigger-claim-failed', { pluginId: this.pluginId, workflowId: workflow.id,
        runId: claim.runId, stack: error.stack });
      // Automatic execution requires a durable claim; manual execution keeps its original contract on storage failure.
      if (claim.source === 'schedule') {
        throw error;
      }
    }
  }

  // Bookkeeping failures must not change an engine result or prevent delivery of run events.
  async record(run) {
    try {
      await this.tasks?.changed(run);
      await this.#publish();
    } catch (error) {
      this.logger('error', 'trigger-record-failed', { pluginId: this.pluginId, workflowId: run.workflowId,
        runId: run.id, stack: error.stack });
    }
  }

  async #publish() {
    if (this.tasks) {
      this.emit('triggers.changed', { items: await this.list() });
    }
  }

  stop() {
    this.stopped = true;
    this.revision += 1;
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
    return setTimeout(() => { this.#wake(workflowId, at); }, delay);
  }

  #wake(workflowId, at) {
    void this.#track(workflowId, this.#fire(workflowId, at)).catch(error => {
      this.logger('error', 'trigger-failed', { pluginId: this.pluginId, workflowId, stack: error.stack });
    });
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
    const admission = this.#admission(workflowId);
    const timer = this.timers.get(workflowId);
    if (!timer || timer.at !== at) {
      return;
    }
    // A cycle longer than the timer limit wakes up early; that wake-up re-plans and must not run anything.
    if (this.now() < at) {
      timer.handle = this.#arm(workflowId, at);
      return;
    }
    try {
      const workflow = await this.workflows.read(workflowId);
      if (this.timers.get(workflowId) !== timer) {
        return;
      }
      const row = await this.tasks?.plan(workflow, this.now(), [...(this.engine.records?.values() || [])]);
      if (this.timers.get(workflowId) !== timer) {
        return;
      }
      // A prior start may have persisted while advancing its schedule failed; never submit that occurrence twice.
      if (row && row.nextAt !== at) {
        this.#clear(workflowId);
        await this.#replan(workflowId);
        return;
      }
      if (this.starting.has(workflowId) || this.engine.activeRun(workflowId)) {
        this.logger('info', 'trigger-skip', { pluginId: this.pluginId, workflowId, reason: '上一次运行尚未结束' });
      } else {
        await this.#start(workflow, { ...admission, source: 'schedule', scheduledAt: at });
      }
      await this.tasks?.advance(workflow, this.now(), at);
    } catch (error) {
      this.logger('error', 'trigger-failed', { pluginId: this.pluginId, workflowId, stack: error.stack });
      // Keep an unconsumed deadline for recovery, but do not spin on a failing storage or start call.
      if (this.timers.get(workflowId) === timer) {
        timer.handle = setTimeout(() => { this.#wake(workflowId, at); }, 60000);
      }
      return;
    }
    // Anchoring to the planned time keeps a cycle from drifting with every run.
    // Closing the plugin or editing this trigger while start() waits must not resurrect the old timer.
    if (this.timers.get(workflowId) !== timer) {
      return;
    }
    this.#clear(workflowId);
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
