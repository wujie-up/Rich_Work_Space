import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail } from '../../shared/contracts.js';
import { stopProcessGroups } from '../os/index.js';

// Only messages cross this boundary; plugin modules are never imported into the host.
export class PluginRuntime {
  constructor({ id, directory, storage, emit, onFailure, serviceRequest, timeout = 30000 }) {
    Object.assign(this, { id, emit, onFailure, serviceRequest, timeout });
    this.instanceId = randomUUID();
    this.services = [];
    this.capabilityPending = new Map();
    this.pending = new Map();
    this.sequence = 0;
    this.ownedPids = new Set();
    this.resources = [];
    this.child = fork(fileURLToPath(new URL('./plugin-worker.js', import.meta.url)), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, silent: true,
      serialization: 'advanced'
    });
    this.child.stdout.on('data', (data) => console.info(`[plugin:${id}] ${data.toString().trimEnd()}`));
    this.child.stderr.on('data', (data) => console.error(`[plugin:${id}] ${data.toString().trimEnd()}`));
    this.child.on('message', (message) => this.receive(message));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.fail(fail('PLUGIN_CRASHED', `插件进程退出（${signal || code}）`));
      }
    });
    this.ready = this.call('$activate', [{ id, directory, root: storage.root }]);
  }

  receive(message) {
    if (this.closed) {
      return;
    }
    if (!message || typeof message !== 'object') {
      this.fail(fail('PLUGIN_PROTOCOL_ERROR', '插件消息无效'));
      return;
    }
    if (message.type === 'service.request') {
      const parent = this.pending.get(message.parentId)?.context || this.capabilityPending.get(message.parentId)?.context;
      Promise.resolve().then(() => this.serviceRequest(message, parent, this)).then(
        (value) => this.sendServiceResult({ requestId: message.requestId, value }),
        (error) => this.sendServiceResult({ requestId: message.requestId,
          error: { code: error.code || 'SERVICE_ERROR', message: error.message } }));
      return;
    }
    if (message.type === 'capability.result') {
      const request = this.capabilityPending.get(message.invocationId);
      if (request) {
        this.capabilityPending.delete(message.invocationId);
        clearTimeout(request.timer);
        message.error ? request.reject(Object.assign(Error(message.error.message), message.error)) : request.resolve(message.value);
      }
      return;
    }
    if (message.type === 'resources') {
      if (!Array.isArray(message.entries) || message.entries.some((entry) => !entry || typeof entry.key !== 'string'
        || typeof entry.busy !== 'boolean' || !Number.isFinite(entry.busyUntil))) {
        this.fail(fail('PLUGIN_PROTOCOL_ERROR', '插件资源状态无效'));
        return;
      }
      this.resources = message.entries;
      return;
    }
    if (message.type === 'event') {
      this.emit(message.channel, { ...message.value, pluginId: this.id });
      return;
    }
    if (message.type === 'processes') {
      if (!Array.isArray(message.pids) || message.pids.some((pid) => !Number.isInteger(pid) || pid <= 1)) {
        this.fail(fail('PLUGIN_PROTOCOL_ERROR', '插件进程列表无效'));
        return;
      }
      this.ownedPids = new Set(message.pids);
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error ? pending.reject(Object.assign(new Error(message.error.message), message.error)) : pending.resolve(message.value);
    }
  }

  sendServiceResult(result) {
    if (!this.closed && this.child.connected) {
      this.child.send({ type: 'service.result', ...result }, (error) => {
        if (error && !this.closed) { this.fail(error); }
      });
    }
  }

  call(method, args = [], context = { chain: [this.id], deadline: Date.now() + this.timeout }) {
    if (this.closed) {
      return Promise.reject(fail('PLUGIN_UNAVAILABLE', '插件进程不可用，请重新启用'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(fail('PLUGIN_TIMEOUT', `插件调用超时：${method}`)),
        Math.max(1, Math.min(this.timeout, context.deadline - Date.now() + 50)));
      this.pending.set(id, { resolve, reject, timer, context });
      this.child.send({ id, method, args, deadline: context.deadline }, (error) => {
        if (error) {
          this.fail(error);
        }
      });
    });
  }

  // Capability deadlines belong to the broker and never trip the ordinary RPC watchdog.
  executeCapability(input, context) {
    if (this.closed) {
      return Promise.reject(fail('PROVIDER_UNAVAILABLE', '插件进程不可用'));
    }
    return new Promise((resolve, reject) => {
      // Release host bookkeeping at the deadline even when a handler ignores cancellation.
      const timer = setTimeout(() => {
        this.capabilityPending.delete(context.invocationId);
        reject(fail('CALL_TIMEOUT', '能力调用超时，外部操作可能仍已执行'));
      }, Math.max(1, context.deadline - Date.now()));
      timer.unref?.();
      this.capabilityPending.set(context.invocationId, { resolve, reject, context, timer });
      const { signal, ...wire } = context;
      this.child.send({ type: 'capability.invoke', input, context: wire }, error => {
        if (error) { this.fail(error); }
      });
    });
  }

  cancelCapability(invocationId) {
    if (!this.closed && this.child.connected) {
      this.child.send({ type: 'capability.cancel', invocationId });
    }
  }

  notifyCapability(value) {
    if (!this.closed && this.child.connected) {
      this.child.send({ type: 'capability.event', value });
    }
  }

  fail(error) {
    if (this.closed) {
      return;
    }
    this.close(error);
    this.onFailure(error, this);
  }

  // Keep cleanup attached to this live runtime; disk records never authorize killing a PID.
  close(error = fail('PLUGIN_UNAVAILABLE', '插件进程已关闭')) {
    if (this.closed && !this.cleanupError) {
      return this.cleanup;
    }
    this.cleanupError = null;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const request of this.capabilityPending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.capabilityPending.clear();
    this.child.kill('SIGKILL');
    this.cleanup = stopProcessGroups([...this.ownedPids]);
    this.cleanup.catch((error) => {
      this.cleanupError = error;
      console.error('[plugin:cleanup]', { pluginId: this.id, message: error.message });
    });
    return this.cleanup;
  }
}
