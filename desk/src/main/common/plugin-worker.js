import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Storage } from './storage.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const methods = new Map();
const views = [];
const resources = new Map();
const services = [];
const calls = new AsyncLocalStorage();
const pending = new Map();
let sequence = 0;
let module;
let lifecycle = { snapshot: () => [], stop: async () => {} };
const send = (value) => { if (process.connected) { process.send(value); } };

// The host associates parentId with its own invocation; callers cannot supply an origin or call chain.
function serviceRequest(action, input, timeout = 5000) {
  const parent = calls.getStore();
  const deadline = Math.min(parent?.deadline || Date.now() + 5000, Date.now() + timeout);
  return new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(Error('插件服务调用超时'), { code: 'SERVICE_TIMEOUT' }));
    }, Math.max(1, deadline - Date.now()));
    pending.set(requestId, { resolve, reject, timer });
    send({ type: 'service.request', requestId, parentId: parent?.id, action, input, deadline });
  });
}

async function activate({ id, directory, root }) {
  const storage = new Storage(root);
  const require = createRequire(import.meta.url);
  const manifest = await storage.readJson(`packages/${id}/plugin.json`);
  module = await import(pathToFileURL(join(directory, manifest.main)).href);
  if (typeof module.activate !== 'function' || typeof module.deactivate !== 'function') {
    throw Error('插件必须导出 activate 和 deactivate');
  }
  const context = {
    pluginId: id, storage,
    importModule: (name) => import(pathToFileURL(require.resolve(name)).href),
    emit: (channel, value) => send({ type: 'event', channel, value }),
    ownProcesses: (pids) => {
      if (!Array.isArray(pids) || pids.some((pid) => !Number.isInteger(pid) || pid <= 1)) {
        throw Error('插件进程列表无效');
      }
      send({ type: 'processes', pids });
    },
    resources: { report: (entries) => send({ type: 'resources', entries }) },
    services: {
      register({ contract, method }) {
        if (!/^[a-z][a-zA-Z0-9.-]{1,100}$/.test(contract) || !methods.has(method)
          || services.some((entry) => entry.contract === contract)) {
          throw Error('插件服务契约无效、重复或方法未注册');
        }
        services.push({ contract, method });
      },
      discover: (contract) => serviceRequest('discover', contract),
      invoke: (provider, input, { timeout = 5000 } = {}) => serviceRequest('invoke', { provider, input }, timeout)
    },
    methods: { register(name, handler, { exclusive = false, resource, resourceExclusive = false } = {}) {
      if (!/^[a-z][a-zA-Z0-9.]+$/.test(name) || methods.has(name) || typeof handler !== 'function') {
        throw Error('插件方法名称重复或无效');
      }
      methods.set(name, { handler, exclusive, resourceExclusive });
      if (resource) {
        resources.set(name, resource);
      }
    } },
    lifecycle: { register(value) { lifecycle = value; } },
    views: { register(view) {
      if (!view.id || !view.title || !view.entry || views.some((item) => item.id === view.id)) {
        throw Error('插件视图需要 id/title/entry 且 ID 不能重复');
      }
      views.push(view);
    } }
  };
  try {
    await module.activate(context);
    return { views, services, methods: [...methods].map(([name, { exclusive, resourceExclusive }]) => ({ name, exclusive, resourceExclusive, resource: resources.has(name) })) };
  } catch (error) {
    try {
      await module.deactivate();
    } catch (cleanupError) {
      console.error('[plugin:activation-cleanup]', { pluginId: id, message: cleanupError.message });
    }
    throw error;
  }
}

process.on('message', async (message) => {
  if (message.type === 'service.result') {
    const request = pending.get(message.requestId);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.requestId);
      message.error ? request.reject(Object.assign(Error(message.error.message), message.error)) : request.resolve(message.value);
    }
    return;
  }
  const { id, method, args, deadline } = message;
  await calls.run({ id, deadline }, async () => {
    try {
      let value;
      if (method === '$activate') {
        value = await activate(...args);
      } else if (method === '$resource') {
        value = await resources.get(args[0])(...args[1]);
      } else if (method === '$snapshot') {
        value = await lifecycle.snapshot();
      } else if (method === '$stop') {
        value = await lifecycle.stop(...args);
      } else if (method === '$deactivate') {
        value = await module.deactivate();
      } else {
        const registered = methods.get(method);
        if (!registered) {
          throw Object.assign(Error('插件方法不存在'), { code: 'METHOD_NOT_FOUND' });
        }
        value = await registered.handler(...args);
      }
      send({ id, value });
    } catch (error) {
      send({ id, error: { code: error.code || 'PLUGIN_ERROR', message: error.message, details: error.details } });
    }
  });
});
process.on('disconnect', () => process.exit(0));
