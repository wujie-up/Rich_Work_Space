import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fail } from '../../shared/contracts.js';
import { validateDescriptor, matchesSchema, jsonValue } from './capability-schema.js';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const contract = 'desk.capabilities.v1';

// Registrations live in runtime.services; this class only owns generic invocation state and policy.
export class Capabilities {
  constructor({ storage, loaded, usable, emit = () => {} }) {
    Object.assign(this, { storage, loaded, usable, emit });
    this.revision = 0;
    this.invocations = new Map();
    this.writes = new Set();
    this.locks = new Map();
  }

  async load() {
    const entries = await readdir(await this.storage.path('capability-invocations')).catch(error => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return [];
    });
    for (const name of entries.filter(name => /^[\w-]+\.json$/.test(name))) {
      const key = `capability-invocations/${name}`;
      const value = await this.storage.readJson(key);
      if (!terminal.has(value.state)) {
        await this.storage.writeJson(key, { ...value, state: 'interrupted', finishedAt: Date.now(), error: { code: 'HOST_RESTARTED' } });
      }
    }
  }

  async register(runtime, value, replace = false) {
    const descriptor = validateDescriptor(value);
    runtime.services ||= [];
    const existing = runtime.services.find(entry => entry.contract === contract && entry.descriptor.id === descriptor.id
      && entry.descriptor.version === descriptor.version);
    if (existing && !replace) {
      throw fail('INVALID_CAPABILITY', '能力已注册');
    }
    const entry = { contract, descriptor, descriptorRevision: runtime.capabilityRevision = (runtime.capabilityRevision || 0) + 1 };
    if (existing) {
      runtime.services.splice(runtime.services.indexOf(existing), 1, entry);
    } else {
      runtime.services.push(entry);
    }
    this.changed();
    return this.provider(runtime, entry);
  }

  unregister(runtime, id, version) {
    const index = runtime.services?.findIndex(entry => entry.contract === contract && entry.descriptor.id === id && entry.descriptor.version === version);
    if (index >= 0) {
      runtime.services.splice(index, 1);
      this.changed();
    }
  }

  provider(runtime, entry) {
    return { handle: { pluginId: runtime.id, instanceId: runtime.instanceId, capabilityId: entry.descriptor.id,
      version: entry.descriptor.version, descriptorRevision: entry.descriptorRevision },
    state: entry.descriptor.state || 'ready', descriptor: entry.descriptor };
  }

  discover(query = {}) {
    const providers = [...this.loaded.values()].filter(runtime => !runtime.closed && this.usable(runtime.id))
      .flatMap(runtime => (runtime.services || []).filter(entry => entry.contract === contract).map(entry => this.provider(runtime, entry)))
      .filter(entry => (query.includeUnavailable || entry.state === 'ready') && (!query.id || entry.descriptor.id === query.id)
        && (!query.pluginId || entry.handle.pluginId === query.pluginId) && (!query.version || entry.handle.version === query.version));
    return jsonValue({ catalogRevision: this.revision, providers }, 'INVALID_CAPABILITY');
  }

  changed() {
    const event = { type: 'catalog.changed', revision: ++this.revision };
    for (const runtime of this.loaded.values()) {
      runtime.notifyCapability?.(event);
    }
  }

  resolve(handle) {
    const runtime = this.loaded.get(handle?.pluginId);
    if (!runtime || runtime.closed || !this.usable(runtime.id)) {
      throw fail('PROVIDER_UNAVAILABLE', '能力提供者当前不可用');
    }
    const entry = runtime.services?.find(entry => entry.contract === contract && entry.descriptor.id === handle.capabilityId
      && entry.descriptor.version === handle.version);
    if (!entry || handle.instanceId !== runtime.instanceId || handle.descriptorRevision !== entry.descriptorRevision) {
      throw fail('CAPABILITY_CHANGED', '能力已更新，请重新发现');
    }
    if ((entry.descriptor.state || 'ready') !== 'ready') {
      throw fail('PROVIDER_UNAVAILABLE', '能力当前不可用');
    }
    return { runtime, descriptor: entry.descriptor };
  }

  async invoke(caller, handle, input, options = {}, parent) {
    const { runtime, descriptor } = this.resolve(handle);
    const value = jsonValue(input, 'INPUT_INVALID');
    if (!matchesSchema(value, descriptor.inputSchema)) {
      throw fail('INPUT_INVALID', '能力输入不符合 Schema');
    }
    const chain = parent?.chain || [caller.id];
    if (chain.includes(runtime.id) || chain.length >= 8) {
      throw fail('SERVICE_CYCLE', '插件能力调用存在循环或超过最大深度');
    }
    const requestedTimeout = options.timeoutMs ?? descriptor.execution.timeoutMs;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw fail('INPUT_INVALID', '调用超时参数无效');
    }
    const deadline = Math.min(Date.now() + requestedTimeout, Date.now() + descriptor.execution.timeoutMs, parent?.deadline || Infinity);
    if (deadline <= Date.now() || parent?.signal?.aborted) {
      throw fail('CALL_TIMEOUT', '父调用已结束');
    }
    const invocationId = randomUUID();
    const record = { invocationId, traceId: parent?.traceId || randomUUID(), state: 'queued', deadline, sequence: 0,
      caller: { pluginId: caller.id, instanceId: caller.instanceId }, provider: { ...handle }, createdAt: Date.now() };
    const controller = new AbortController();
    const task = { record, caller, runtime, descriptor, input: value, controller, chain: [...chain, runtime.id], children: new Set() };
    const approval = descriptor.confirmation === 'always' || !descriptor.effects.length
      || descriptor.effects.some(effect => !/^(filesystem|network|workspace|document)\.read$/.test(effect));
    record.approvalRequired = approval;
    if ([...this.invocations.values()].filter(item => !terminal.has(item.record.state)).length >= 128) {
      throw fail('RESOURCE_BUSY', '并发能力调用已达上限');
    }
    for (const [id, item] of this.invocations) {
      if (this.invocations.size < 512) { break; }
      if (terminal.has(item.record.state)) { this.invocations.delete(id); }
    }
    this.invocations.set(invocationId, task);
    const timer = setTimeout(() => {
      this.finish(task, 'failed', { error: { code: 'CALL_TIMEOUT', message: '能力调用超时，外部操作可能仍已执行' } });
      controller.abort();
      runtime.cancelCapability?.(invocationId);
    }, Math.max(1, deadline - Date.now()));
    timer.unref?.();
    task.timer = timer;
    task.parentAbort = () => {
      this.finish(task, 'interrupted', { error: { code: 'PARENT_ENDED', message: '父调用已结束，外部操作可能仍已执行' } });
      controller.abort();
      runtime.cancelCapability?.(invocationId);
    };
    parent?.signal?.addEventListener('abort', task.parentAbort, { once: true });
    task.parentSignal = parent?.signal;
    this.publish(task);
    if (approval) {
      this.emit('capabilities.approval', { invocationId, pluginId: runtime.id, title: descriptor.title,
        description: descriptor.description, effects: descriptor.effects, input: value });
    } else {
      queueMicrotask(() => this.run(task));
    }
    return { invocationId, traceId: record.traceId, state: record.state, deadline };
  }

  async approve(id, allowed) {
    const task = this.invocations.get(id);
    if (!task || terminal.has(task.record.state) || !task.record.approvalRequired) {
      throw fail('APPROVAL_STALE', '能力确认已失效');
    }
    task.record.approvalRequired = false;
    if (!allowed) {
      this.finish(task, 'cancelled');
      return;
    }
    try {
      this.resolve(task.record.provider);
      queueMicrotask(() => this.run(task));
    } catch (error) {
      this.finish(task, 'failed', { error: { code: error.code, message: error.message } });
    }
  }

  async run(task) {
    if (terminal.has(task.record.state)) {
      return;
    }
    const key = task.descriptor.execution.resource;
    if (key && this.locks.has(key)) {
      this.finish(task, 'failed', { error: { code: 'RESOURCE_BUSY', message: '能力资源正在使用' } });
      return;
    }
    if (key) {
      this.locks.set(key, task.record.invocationId);
    }
    try {
      this.resolve(task.record.provider);
      task.record.state = 'running';
      this.publish(task);
      const result = await task.runtime.executeCapability(task.input, { invocationId: task.record.invocationId,
        traceId: task.record.traceId, deadline: task.record.deadline, chain: task.chain, signal: task.controller.signal,
        capabilityId: task.descriptor.id, version: task.descriptor.version });
      const value = jsonValue(result, 'OUTPUT_INVALID');
      if (!matchesSchema(value, task.descriptor.outputSchema)) {
        throw fail('OUTPUT_INVALID', '能力返回值不符合 Schema');
      }
      // A normal result after cancellation may have committed an effect; never pretend it was rolled back.
      this.finish(task, 'succeeded', { result: value });
    } catch (error) {
      this.finish(task, task.record.state === 'cancelling' && ['CANCELLED', 'ABORT_ERR'].includes(error.code) ? 'cancelled' : 'failed',
        { error: { code: error.code || 'CAPABILITY_FAILED', message: error.message } });
    } finally {
      if (key && this.locks.get(key) === task.record.invocationId) {
        this.locks.delete(key);
      }
    }
  }

  get(caller, id) {
    const task = this.invocations.get(id);
    if (!task || task.caller !== caller) {
      throw fail('INVOCATION_FORBIDDEN', '只能访问当前实例发起的能力调用');
    }
    return jsonValue(task.record, 'OUTPUT_INVALID');
  }

  cancel(caller, id) {
    this.get(caller, id);
    return this.cancelTask(this.invocations.get(id));
  }

  cancelTask(task) {
    if (terminal.has(task.record.state)) {
      return jsonValue(task.record, 'OUTPUT_INVALID');
    }
    if (!task.descriptor.execution.cancellable) {
      throw fail('CANCEL_UNSUPPORTED', '提供者不支持取消；外部操作可能继续执行');
    }
    if (task.record.state === 'queued') {
      this.finish(task, 'cancelled');
      return jsonValue(task.record, 'OUTPUT_INVALID');
    }
    task.record.state = 'cancelling';
    this.publish(task);
    task.controller.abort();
    task.runtime.cancelCapability?.(task.record.invocationId);
    return jsonValue(task.record, 'OUTPUT_INVALID');
  }

  finish(task, state, data = {}) {
    if (terminal.has(task.record.state)) {
      return;
    }
    Object.assign(task.record, data, { state, finishedAt: Date.now(), approvalRequired: false });
    clearTimeout(task.timer);
    task.parentSignal?.removeEventListener('abort', task.parentAbort);
    this.publish(task);
    console[state === 'failed' ? 'error' : 'info']('[capability:finished]', { pluginId: task.runtime.id,
      instanceId: task.runtime.instanceId, invocationId: task.record.invocationId, traceId: task.record.traceId, state, code: data.error?.code });
  }

  publish(task) {
    task.record.sequence++;
    const record = task.record;
    task.caller.notifyCapability?.({ ...record, type: terminal.has(record.state) ? 'invocation.finished' : 'invocation.changed' });
    // Persist identities and status only. Provider errors, inputs and results may contain credentials.
    const { invocationId, traceId, state, deadline, sequence, caller, provider, createdAt, finishedAt } = record;
    const snapshot = { invocationId, traceId, state, deadline, sequence, caller, provider, createdAt, finishedAt,
      error: record.error ? { code: record.error.code } : undefined };
    const write = (task.write || Promise.resolve()).catch(() => {}).then(() =>
      this.storage.writeJson(`capability-invocations/${invocationId}.json`, snapshot));
    task.write = write;
    this.writes.add(write);
    write.catch(error => console.error('[capability:persist]', { invocationId, message: error.message })).finally(() => this.writes.delete(write));
  }

  revoke(runtime) {
    runtime.services = (runtime.services || []).filter(entry => entry.contract !== contract);
    for (const task of this.invocations.values()) {
      if (!terminal.has(task.record.state) && (task.runtime === runtime || task.caller === runtime)) {
        this.finish(task, 'failed', { error: { code: 'PROVIDER_UNAVAILABLE', message: '能力提供者或调用者已停止' } });
        task.controller.abort();
        task.runtime.cancelCapability?.(task.record.invocationId);
      }
    }
    this.changed();
  }

  flush() {
    return Promise.all([...this.writes]);
  }
}
