import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { rm, readdir, readFile } from 'node:fs/promises';
import { fail, pluginId } from '../../shared/contracts.js';
import { importPackage, inspectPackage, withPackageSource } from './plugin-package.js';
import { PluginRuntime } from './plugin-runtime.js';
import { Capabilities } from './capabilities.js';
import { pluginProperties, validatePresentation } from './plugin-manifest.js';

export class Plugins {
  constructor({ storage, builtins = [], emit = () => {}, runtimeFactory = (options) => new PluginRuntime(options) }) {
    Object.assign(this, { storage, builtins, emit, runtimeFactory });
    this.records = new Map();
    this.loaded = new Map();
    this.operations = new Map();
    this.creating = new Set();
    this.tokens = new Map();
    this.resourceLocks = new Map();
    this.recovering = new Map();
    this.activating = new Map();
    this.taskCalls = new Map();
    this.capabilities = new Capabilities({ storage, loaded: this.loaded, emit, usable: id => {
      const record = this.records.get(id);
      return !this.quitting && record?.state === 'enabled' && !record.operation && !this.operations.has(id);
    } });
  }

  list() {
    return [...this.records.values()].map((record) => ({ ...record, running: Boolean(this.loaded.get(record.id) && !this.loaded.get(record.id).closed),
      views: this.loaded.get(record.id)?.views?.length ? this.loaded.get(record.id).views : record.views || [] }));
  }

  async persist() {
    await this.storage.writeJson('plugins.json', [...this.records.values()]);
    this.emit('plugins.changed', this.list());
  }

  async load() {
    await this.capabilities.load();
    const records = await this.storage.readJson('plugins.json', null);
    for (const record of records || []) {
      pluginId(record.id);
      this.records.set(record.id, pluginProperties(record));
    }
    await this.discoverDirectories();
    if (records === null && this.builtins.length) {
      for (const builtin of this.builtins) {
        try {
          const manifest = await inspectPackage(builtin);
          if (!this.records.has(manifest.id)) {
            await this.install(builtin);
          }
        } catch (error) {
          console.error('[plugin:builtin]', { directory: builtin, message: error.message });
        }
      }
    }
    for (const record of this.records.values()) {
      if (record.operation) {
        record.lastError = { code: 'INTERRUPTED_OPERATION', message: '上次操作中断，请重试', stage: record.operation };
        record.operation = null;
        // Interrupted transitions require explicit recovery, never implicit reactivation on launch.
        if (record.state !== 'uninstalled') {
          record.state = 'disabled';
        }
      }
      if (record.state !== 'uninstalled' && !await this.validateInstalled(record)) {
        continue;
      }
      if (!this.loaded.has(record.id) && record.state === 'enabled' && record.loadOnStartup && record.background === 'service') {
        try {
          await this.activate(record.id);
        } catch (error) {
          record.state = 'disabled';
          record.lastError = { code: 'ACTIVATION_FAILED', message: error.message, stage: 'activate' };
        }
      }
    }
    await this.persist();
  }

  // Scan only installation directories; one malformed plugin must not prevent the desk from starting.
  async discoverDirectories() {
    const directory = await this.storage.path('plugins');
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return [];
    });
    for (const entry of entries.filter(entry => !entry.name.startsWith('.'))) {
      try {
        pluginId(entry.name);
        const source = await this.storage.path(`plugins/${entry.name}`);
        const manifest = pluginProperties(JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')));
        if (manifest.id !== entry.name) {
          throw fail('INVALID_PACKAGE', '插件目录名称必须与清单 id 一致');
        }
        const previous = this.records.get(manifest.id);
        if (previous?.cleanupPending || (previous && previous.dataVersion !== manifest.dataVersion)) {
          throw fail('INVALID_PACKAGE', '插件待清理或数据版本不兼容');
        }
        this.records.set(manifest.id, { operation: null, lastError: null,
          ...previous, ...manifest, state: previous?.state === 'disabled' ? 'disabled' : 'enabled' });
      } catch (error) {
        const record = this.records.get(entry.name);
        if (record) {
          record.state = 'disabled';
          record.lastError = { code: 'INVALID_PACKAGE', message: error.message, stage: 'integrity' };
        }
        console.error('[plugin:directory]', { pluginId: entry.name, message: error.message });
      }
    }
  }

  async validateInstalled(record) {
    try {
      const manifest = await inspectPackage(await this.storage.packageDirectory(record.id));
      if (manifest.id !== record.id) {
        throw fail('INVALID_PACKAGE', '插件目录与清单 id 不一致');
      }
      return true;
    } catch (error) {
      record.state = 'disabled';
      record.lastError = { code: 'INVALID_PACKAGE', message: error.message, stage: 'integrity' };
      console.error('[plugin:integrity]', { pluginId: record.id, message: error.message });
      return false;
    }
  }

  record(id) {
    const record = this.records.get(pluginId(id));
    if (!record) {
      throw fail('PLUGIN_NOT_FOUND', '插件不存在');
    }
    return record;
  }

  assertEnabled(id) {
    const record = this.record(id);
    if (this.quitting || this.operations.has(id) || record.operation || record.state !== 'enabled') {
      throw fail('PLUGIN_BUSY', '插件未启用或正在切换，请稍后重试');
    }
  }

  async guard(id, work) {
    this.assertEnabled(id);
    if (this.creating.has(id)) {
      throw fail('PLUGIN_BUSY', '插件正在创建任务');
    }
    this.creating.add(id);
    try {
      return await work();
    } finally {
      this.creating.delete(id);
    }
  }

  invoke(id, method, args = [], context) {
    this.assertEnabled(id);
    const record = this.record(id);
    if (record.background === 'none') {
      throw fail('METHOD_NOT_FOUND', '此插件没有后台方法');
    }
    return record.background === 'task' ? this.invokeTask(id, method, { args, context })
      : this.ensureRuntime(id).then(() => this.invokeRegistered(id, method, { args, context }));
  }

  async start(id) {
    this.assertEnabled(id);
    if (this.record(id).background !== 'service') {
      throw fail('PLUGIN_UNAVAILABLE', '此插件没有持续后台');
    }
    await this.ensureRuntime(id);
    await this.persist();
  }

  invokeRegistered(id, method, { args, context }) {
    this.assertEnabled(id);
    const runtime = this.loaded.get(id);
    const registered = runtime.methods.find((entry) => entry.name === method);
    if (!registered) {
      throw fail('METHOD_NOT_FOUND', '插件方法不存在');
    }
    const call = () => this.invokeResource(id, runtime, registered, args, context);
    return registered.exclusive ? this.guard(id, call) : call();
  }

  // Concurrent first calls share one activation; an enabled lazy plugin need not own a process yet.
  ensureRuntime(id) {
    if (this.loaded.has(id)) {
      return Promise.resolve();
    }
    if (!this.activating.has(id)) {
      const activation = this.activate(id).catch(async error => {
        const record = this.record(id);
        record.state = 'disabled';
        record.lastError = { code: error.code || 'ACTIVATION_FAILED', message: error.message, stage: 'activate' };
        await this.persist();
        throw error;
      }).finally(() => this.activating.delete(id));
      this.activating.set(id, activation);
    }
    return this.activating.get(id);
  }

  // A task must finish all work before returning; its final caller owns cleanup, including errors.
  async invokeTask(id, method, input) {
    this.taskCalls.set(id, (this.taskCalls.get(id) || 0) + 1);
    try {
      await this.ensureRuntime(id);
      return await this.invokeRegistered(id, method, input);
    } finally {
      const remaining = this.taskCalls.get(id) - 1;
      if (remaining) {
        this.taskCalls.set(id, remaining);
      } else {
        await this.finishTask(id);
      }
    }
  }

  // Block new calls until the last task's owned processes have been reaped.
  async finishTask(id) {
    const record = this.record(id);
    record.operation ||= 'finishing';
    const runtime = this.loaded.get(id);
    try {
      if (!runtime || runtime.closed) {
        return;
      }
      try {
        await runtime.call('$stop', ['task-complete']);
        await runtime.call('$deactivate');
      } finally {
        this.capabilities.revoke(runtime);
        await runtime.close();
        this.loaded.delete(id);
      }
      console.info('[plugin:task-complete]', { pluginId: id });
    } catch (error) {
      if (runtime?.cleanupError) {
        this.crashed(id, error, runtime);
      }
      throw error;
    } finally {
      if (record.operation === 'finishing') {
        record.operation = null;
      }
      this.taskCalls.delete(id);
    }
  }

  // Keys are opaque to desk: plugins define which external resource their methods share.
  async invokeResource(id, runtime, method, args, context) {
    const key = method.resource ? await runtime.call('$resource', [method.name, args], context) : null;
    this.assertEnabled(id);
    if (!key) {
      return runtime.call(method.name, args, context);
    }
    const locks = this.resourceLocks.get(key) || new Set();
    const exclusive = method.resourceExclusive;
    const participants = [...this.loaded.values(), ...this.recovering.values()];
    const busy = exclusive && participants.some((peer) => peer.resources.some((resource) => resource.key === key
      && (peer.closed || resource.busy || resource.busyUntil > Date.now())));
    if (busy || [...locks].some((lock) => lock.exclusive || exclusive)) {
      throw fail('RESOURCE_BUSY', '共享工作区有任务忙碌或正在切换，请稍后重试');
    }
    const lock = { exclusive };
    locks.add(lock);
    this.resourceLocks.set(key, locks);
    try {
      return await runtime.call(method.name, args, context);
    } finally {
      try {
        if (runtime.closed) {
          await runtime.cleanup;
        }
      } finally {
        locks.delete(lock);
        if (!locks.size) {
          this.resourceLocks.delete(key);
        }
      }
    }
  }

  // Only published methods on the current live runtime participate; contracts stay opaque to desk.
  async serviceRequest(message, parent, source) {
    if (message.action === 'host.runtimeDirectory') {
      if (source.closed || this.loaded.get(source.id) !== source) {
        throw fail('PLUGIN_UNAVAILABLE', '插件运行实例已失效');
      }
      this.assertEnabled(source.id);
      return { version: 1, plugins: [...this.loaded.values()].filter(runtime => !runtime.closed && runtime.child?.pid)
        .map(runtime => ({ pluginId: runtime.id, name: this.record(runtime.id).name, state: this.record(runtime.id).state,
          instanceId: runtime.instanceId, pid: runtime.child.pid, ownedPids: [...runtime.ownedPids] })) };
    }
    if (message.action.startsWith('capabilities.')) {
      return this.capabilityRequest(message, parent, source);
    }
    if (!parent || this.loaded.get(source.id) !== source) {
      throw fail('SERVICE_UNAVAILABLE', '插件服务只能在有效调用中使用');
    }
    this.assertEnabled(source.id);
    const deadline = Math.min(parent.deadline, message.deadline);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      throw fail('SERVICE_TIMEOUT', '插件服务调用超时');
    }
    const providers = (contract) => [...this.loaded].flatMap(([id, runtime]) => {
      const record = this.records.get(id);
      return this.quitting || runtime.closed || record.state !== 'enabled' || record.operation || this.operations.has(id) ? []
        : (runtime.services || []).filter((entry) => entry.contract === contract).map((entry) => ({ pluginId: id, ...entry }));
    });
    if (message.action === 'discover') {
      return providers(message.input);
    }
    const { provider, input } = message.input || {};
    if (message.action !== 'invoke' || !provider || !providers(provider.contract).some((entry) =>
      entry.pluginId === provider.pluginId && entry.method === provider.method)) {
      throw fail('SERVICE_UNAVAILABLE', '插件服务不可用或未公开');
    }
    if (parent.chain.includes(provider.pluginId) || parent.chain.length >= 8) {
      throw fail('SERVICE_CYCLE', '插件服务调用存在循环或超过最大深度');
    }
    return this.invoke(provider.pluginId, provider.method, [input], { chain: [...parent.chain, provider.pluginId], deadline });
  }

  // Origins and parent contexts come from the live process, never from plugin-supplied metadata.
  capabilityRequest(message, parent, source) {
    const current = this.loaded.get(source.id) === source;
    const starting = this.recovering.get(source.id) === source;
    const action = message.action.slice('capabilities.'.length);
    // Live providers must revoke registrations during quit; all new work remains blocked.
    if (source.closed || (!current && !starting) || (this.quitting && action !== 'unregister')) {
      throw fail('PROVIDER_UNAVAILABLE', '插件实例已失效');
    }
    if (['register', 'upsert', 'unregister'].includes(action)) {
      if (this.record(source.id).background !== 'service') { throw fail('INVALID_CAPABILITY', '持久能力需要 service 后台'); }
      if (action === 'unregister') { return this.capabilities.unregister(source, message.input.id, message.input.version); }
      return this.capabilities.register(source, message.input, action === 'upsert');
    }
    // Only the host-created stop context may finish cleanup after the owner is locked.
    if (parent?.lifecycle !== 'stop') {
      this.assertEnabled(source.id);
    }
    if (!current || (message.parentId !== undefined && !parent) || (parent && parent.deadline <= Date.now())) {
      throw fail('CALL_TIMEOUT', '调用上下文已结束');
    }
    if (action === 'discover') { return this.capabilities.discover(message.input); }
    if (action === 'get') { return this.capabilities.get(source, message.input); }
    if (action === 'cancel') { return this.capabilities.cancel(source, message.input); }
    if (action === 'invoke') {
      const { handle, input, options } = message.input;
      return this.capabilities.invoke(source, handle, input, options, parent);
    }
    throw fail('METHOD_NOT_FOUND', '能力协议方法不存在');
  }

  // Each activation owns a separate process and its registrations.
  async activate(id) {
    const directory = await this.storage.packageDirectory(pluginId(id));
    await inspectPackage(directory);
    if (this.quitting) {
      throw fail('PLUGIN_UNAVAILABLE', '桌面正在退出');
    }
    const runtime = this.runtimeFactory({ id, directory, storage: this.storage,
      serviceRequest: (message, parent, instance) => this.serviceRequest(message, parent, instance),
      emit: (channel, value) => this.emit('plugins.event', { pluginId: id, channel, value }),
      onFailure: (error, instance) => this.crashed(id, error, instance) });
    // Track the live process before activation resolves so emergency exit can reap a frozen startup.
    this.recovering.set(id, runtime);
    try {
      const ready = await runtime.ready;
      const capabilities = (runtime.services || []).filter(entry => entry.contract === 'desk.capabilities.v1');
      Object.assign(runtime, ready, { services: [...(ready.services || []), ...capabilities], instanceId: runtime.instanceId || randomUUID() });
      const record = this.record(id);
      runtime.views.forEach(validatePresentation);
      if ((record.type !== 'application' && runtime.views.length)
        || (record.background === 'task' && runtime.services?.length)) {
        throw fail('INVALID_PACKAGE', '服务插件不能注册窗口，task 后台不能发布持久服务');
      }
      this.loaded.set(id, runtime);
      this.capabilities.changed();
      this.recovering.delete(id);
      console.info('[plugin:activated]', { pluginId: id, pid: runtime.child?.pid });
    } catch (error) {
      try {
        await runtime.close();
        this.recovering.delete(id);
      } catch (cleanupError) {
        // Activation has not published this runtime yet; retain it for explicit cleanup retries.
        this.recovering.set(id, runtime);
        console.error('[plugin:activation-cleanup]', { pluginId: id, message: cleanupError.message });
        throw cleanupError;
      }
      throw error;
    }
  }

  crashed(id, error, runtime) {
    if (this.loaded.get(id) !== runtime) {
      return;
    }
    this.capabilities.revoke(runtime);
    this.loaded.delete(id);
    this.recovering.set(id, runtime);
    const record = this.record(id);
    record.state = 'disabled';
    record.lastError = { code: error.code || 'PLUGIN_CRASHED', message: error.message, stage: 'runtime' };
    // Block reactivation until owned children are reaped; another plugin remains independent.
    record.operation = 'recovering';
    console.error('[plugin:crashed]', { pluginId: id, pid: runtime.child?.pid, ...record.lastError });
    this.emit('plugins.changed', this.list());
    const recovery = Promise.resolve(runtime.cleanup).catch((cleanupError) => {
      record.lastError.message += `；进程清理失败：${cleanupError.message}`;
      console.error('[plugin:crash-cleanup]', { pluginId: id, message: cleanupError.message });
    }).then(async () => {
      if (!runtime.cleanupError) {
        this.recovering.delete(id);
      }
      record.operation = null;
      await this.persist();
    }).catch((writeError) => console.error('[plugin:registry]', { pluginId: id, message: writeError.message }))
      .finally(() => {
        if (this.operations.get(id) === recovery) {
          this.operations.delete(id);
        }
      });
    this.operations.set(id, recovery);
  }

  install(source) {
    return withPackageSource(source, (directory) => this.installDirectory(directory));
  }

  async installDirectory(source) {
    const manifest = await inspectPackage(source);
    const previous = this.records.get(manifest.id);
    if (previous && (previous.state !== 'uninstalled' || previous.cleanupPending || previous.dataVersion !== manifest.dataVersion)) {
      throw fail('PLUGIN_CONFLICT', '插件已安装、仍待清理或数据版本不兼容');
    }
    return this.run(manifest.id, 'installing', async () => {
      await this.removePackageFiles(manifest.id);
      await importPackage(this.storage, source);
      const record = { ...manifest, state: 'disabled', operation: 'installing', cleanupPending: false, lastError: null };
      this.records.set(manifest.id, record);
      await this.persist();
      if (record.background === 'service' && record.loadOnStartup) {
        await this.activate(manifest.id);
      }
      record.state = 'enabled';
    });
  }

  // Remove both roots so uninstall cannot reveal a stale legacy copy on the next launch.
  async removePackageFiles(id) {
    for (const root of ['plugins', 'packages']) {
      await rm(await this.storage.path(`${root}/${pluginId(id)}`), { recursive: true, force: true });
    }
  }

  enable(id) {
    const record = this.record(id);
    if (record.state === 'uninstalled') {
      return Promise.reject(fail('PLUGIN_NOT_FOUND', '请重新导入插件包'));
    }
    return this.run(id, 'enabling', async () => {
      if (!await this.validateInstalled(record)) {
        throw fail('INVALID_PACKAGE', record.lastError.message);
      }
      if (this.recovering.has(id) || this.loaded.get(id)?.closed) {
        await this.deactivate(id);
      }
      if (!this.loaded.has(id) && record.background === 'service' && record.loadOnStartup) {
        await this.activate(id);
      }
      record.state = 'enabled';
    });
  }

  async snapshot(id, action) {
    const runtime = this.loaded.get(id);
    const runningTasks = runtime && !runtime.closed ? await runtime.call('$snapshot') : [];
    const digest = createHash('sha256').update(JSON.stringify({ id, action, runningTasks })).digest('hex');
    return { pluginId: id, action, runningTasks, digest, closeDescription: this.record(id).closeDescription || '' };
  }

  async preview(id, action) {
    this.record(id);
    if (!['close', 'disable', 'remove'].includes(action)) {
      throw fail('INVALID_ARGUMENT', '操作类型无效');
    }
    this.checkIdle(id);
    const snapshot = await this.snapshot(id, action);
    this.checkIdle(id);
    const confirmationToken = randomUUID();
    // Keep only the newest preview per owner/action; output does not affect its snapshot.
    this.tokens.set(`${id}:${action}`, { token: confirmationToken, digest: snapshot.digest });
    return { ...snapshot, confirmationToken };
  }

  checkIdle(id) {
    if (this.creating.has(id) || this.operations.has(id) || this.activating.has(id) || this.taskCalls.has(id) || this.quitting) {
      throw fail('PLUGIN_BUSY', '插件正在创建任务或执行操作');
    }
  }

  async confirm(id, action, token) {
    const expected = this.tokens.get(`${id}:${action}`);
    const current = await this.snapshot(id, action);
    if (!expected || token !== expected.token || current.digest !== expected.digest) {
      throw fail('CONFIRMATION_STALE', '任务列表已变化，请重新预览并确认');
    }
    this.tokens.delete(`${id}:${action}`);
  }

  disable(id, token) {
    return this.transition(id, 'disable', token, async () => this.deactivate(id));
  }

  // Closing stops this runtime without changing the user's enablement preference.
  async close(id, token) {
    const state = this.record(id).state;
    const result = await this.transition(id, 'close', token, () => this.deactivate(id, state));
    this.emit('plugins.closed', { pluginId: id });
    return result;
  }

  async forceClose(id) {
    const result = await this.forceStop(id, this.record(id).state);
    this.emit('plugins.closed', { pluginId: id });
    return result;
  }

  // Emergency shutdown skips plugin callbacks; only this live runtime's registered processes are terminated.
  forceDisable(id) {
    return this.forceStop(id, 'disabled');
  }

  forceStop(id, state) {
    if (this.record(id).state === 'uninstalled') {
      return Promise.reject(fail('PLUGIN_NOT_FOUND', '插件已卸载'));
    }
    const pending = this.operations.get(id);
    if (pending) {
      if (pending.intent === `force-closing:${state}`) {
        return pending;
      }
      if (['installing', 'deleting'].includes(this.record(id).operation)) {
        return Promise.reject(fail('PLUGIN_BUSY', '请等待插件安装或卸载完成'));
      }
      this.record(id).state = state;
      return Promise.allSettled([pending, this.loaded.get(id)?.close(), this.recovering.get(id)?.close()])
        .then(() => this.forceStop(id, state));
    }
    return this.run(id, 'force-closing', async () => {
      const record = this.record(id);
      record.state = state;
      const close = async () => {
        for (const instances of [this.loaded, this.recovering]) {
          const runtime = instances.get(id);
          if (runtime) {
            this.capabilities.revoke(runtime);
            await runtime.close();
            instances.delete(id);
          }
        }
      };
      await close();
      // A lazy activation may already be in flight; drain it before permitting another instance.
      await Promise.allSettled([this.activating.get(id)]);
      await close();
      // Interrupted activation may mark itself disabled; the explicit operation owns the final state.
      record.state = state;
      console.info('[plugin:force-closed]', { pluginId: id, state });
    }, `force-closing:${state}`);
  }

  remove(id, policy, token) {
    if (!['keep', 'clear'].includes(policy)) {
      return Promise.reject(fail('INVALID_ARGUMENT', '数据策略无效'));
    }
    return this.transition(id, 'remove', token, async () => {
      await this.deactivate(id);
      const record = this.record(id);
      record.operation = 'deleting';
      record.removalPolicy = policy;
      await this.persist();
      await this.removePackageFiles(id);
      record.state = 'uninstalled';
      record.cleanupPending = policy === 'clear';
      await this.persist();
      if (record.cleanupPending) {
        await this.cleanup(id);
      }
    }, policy);
  }

  transition(id, action, token, work, policy = '') {
    const intent = `${action}:${policy}`;
    if (this.operations.has(id)) {
      const current = this.operations.get(id);
      return current.intent === intent ? current : Promise.reject(fail('PLUGIN_BUSY', '插件正在执行其他操作'));
    }
    this.checkIdle(id);
    return this.run(id, { remove: 'deleting', disable: 'disabling', close: 'closing' }[action], async () => {
      await this.confirm(id, action, token);
      await this.persist();
      const runtime = this.loaded.get(id);
      if (runtime && !runtime.closed) {
        await runtime.call('$stop', [action], { chain: [id], deadline: Date.now() + 30000, lifecycle: 'stop' });
      }
      await work();
    }, intent);
  }

  async deactivate(id, state = 'disabled') {
    // Failed crash cleanup must complete before this instance can be replaced or removed.
    const recovering = this.recovering.get(id);
    if (recovering) {
      await recovering.close();
      this.recovering.delete(id);
    }
    const registration = this.loaded.get(id);
    if (registration) {
      this.capabilities.revoke(registration);
      if (!registration.closed) {
        await registration.call('$deactivate');
      }
      try {
        await registration.close();
        this.loaded.delete(id);
      } finally {
        this.record(id).state = state;
      }
    }
    this.record(id).state = state;
  }

  async cleanup(id) {
    try {
      await this.storage.clearPluginData(id);
      this.record(id).cleanupPending = false;
    } catch (error) {
      throw fail('DATA_CLEANUP_FAILED', error.message);
    }
  }

  retryCleanup(id) {
    const record = this.record(id);
    if (record.state !== 'uninstalled' || !record.cleanupPending) {
      return Promise.reject(fail('INVALID_ARGUMENT', '没有待清理的数据'));
    }
    return this.run(id, 'deleting', () => this.cleanup(id));
  }

  // Set the operation lock synchronously; no create can slip through an awaited disk write.
  run(id, operation, work, intent = operation) {
    if (this.quitting || this.operations.has(id)) {
      return Promise.reject(fail('PLUGIN_BUSY', '插件正在执行操作或桌面正在退出'));
    }
    const record = this.records.get(id);
    if (record) {
      record.operation = operation;
    }
    const promise = Promise.resolve().then(work).then(async () => {
      const current = this.record(id);
      if (this.operations.get(id) !== promise) {
        throw fail('PLUGIN_UNAVAILABLE', '插件正在恢复');
      }
      current.operation = null;
      current.lastError = null;
      await this.persist();
      console.info('[plugin:complete]', { pluginId: id, operation, state: current.state });
      return this.list().find((r) => r.id === id);
    }).catch(async (error) => {
      const current = this.records.get(id);
      if (current && this.operations.get(id) === promise) {
        current.operation = null;
        current.lastError = { code: error.code || 'PLUGIN_OPERATION_FAILED', message: error.message, stage: operation };
        await this.persist().catch((writeError) => console.error('[plugin:registry]', { pluginId: id, message: writeError.message }));
      }
      this.emit('plugins.changed', this.list());
      console.error('[plugin:error]', { pluginId: id, operation, message: error.message });
      throw error;
    }).finally(() => {
      if (this.operations.get(id) === promise) {
        this.operations.delete(id);
        this.capabilities.changed();
      }
    });
    promise.intent = intent;
    this.operations.set(id, promise);
    return promise;
  }

  prepareQuit() {
    if (this.creating.size || this.operations.size || this.activating.size || this.taskCalls.size) {
      throw fail('PLUGIN_BUSY', '请等待当前插件操作完成后退出');
    }
    this.quitting = true;
    return this.pendingTasks();
  }

  cancelQuit() {
    this.quitting = false;
  }

  // Emergency exit never waits for plugin RPCs or lifecycle operation queues.
  async forceQuit() {
    this.quitting = true;
    await Promise.allSettled([...new Set([...this.loaded.values(), ...this.recovering.values()])].map(async (runtime) => {
      this.capabilities.revoke(runtime);
      console.info('[plugin:force-quit]', { pluginId: runtime.id, pid: runtime.child?.pid });
      await runtime.close();
    }));
  }

  async pendingTasks() {
    const tasks = await Promise.all([...this.loaded].map(async ([id, runtime]) =>
      (runtime.closed ? [] : await runtime.call('$snapshot')).map((task) => ({ ...task, pluginId: id }))));
    return tasks.flat();
  }

  async confirmQuit() {
    try {
      for (const runtime of this.loaded.values()) {
        if (!runtime.closed) {
          await runtime.call('$stop', ['quit']);
        }
      }
      for (const id of new Set([...this.loaded.keys(), ...this.recovering.keys()])) {
        await this.deactivate(id);
      }
    } catch (error) {
      this.quitting = false;
      throw error;
    }
  }
}
