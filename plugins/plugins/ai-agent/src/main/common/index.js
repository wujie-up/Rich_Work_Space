import { homedir } from 'node:os';
import { resolveLaunchConfig } from './launch-config.js';
import { readGit } from './git.js';
import { Sessions } from './sessions.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createCustomCliAdapter } from './adapters/custom-cli.js';

export async function activate(context) {
  const id = context.pluginId;
  const storage = context.storage;
  const adapters = new Map();
  const sessions = new Sessions({ storage, spawn: (await context.importModule('node-pty')).spawn,
    emit: (channel, value) => {
      context.emit(channel, value);
      context.ownProcesses([...sessions.active.values()].map((session) => session.pid));
      context.resources.report([...sessions.active.values()].filter((session) => session.git).map((session) => ({
        key: `git:${session.git.root}`, busy: session.exited || Boolean(session.closing) || Boolean(session.blocked)
          || !['idle', 'done', 'error'].includes(session.activity), busyUntil: (session.lastInputAt || 0) + 1000
      })));
    } });
  let creating = false;
  sessions.guard = async (_id, work) => {
    if (creating) {
      throw Object.assign(Error('插件正在创建会话'), { code: 'PLUGIN_BUSY' });
    }
    creating = true;
    try {
      return await work();
    } finally {
      creating = false;
    }
  };
  sessions.adapter = (_id, adapterId) => {
    const adapter = adapters.get(adapterId);
    if (!adapter) {
      throw Object.assign(Error('适配器未注册'), { code: 'ADAPTER_NOT_FOUND' });
    }
    return adapter;
  };
  // Resolve CLI configuration for each launch without disturbing other sessions.
  for (const factory of [createCodexAdapter, createCustomCliAdapter]) {
    const adapter = factory();
    adapter.buildLaunch = async (input) => {
      const config = await storage.readJson(`plugin-data/${id}/config.json`, {});
      const launchOverrides = await resolveLaunchConfig(context, adapter.id, input);
      return factory(config[adapter.id]).buildLaunch({ ...input, launchOverrides });
    };
    adapters.set(adapter.id, adapter);
  }
  await sessions.loadPlugin(id);
  const resource = async (method, ...args) => {
    if (method === 'create' || method === 'restore') {
      const input = method === 'create' ? args[0] : await sessions.readArchive(id, args[0]);
      const info = typeof input.cwd === 'string' ? await readGit(input.cwd.replace(/^~(?=\/|$)/, homedir())) : null;
      return info ? `git:${info.root}` : null;
    }
    const session = sessions.get(id, args[0]);
    return session.git ? `git:${session.git.root}` : null;
  };
  for (const method of ['list', 'create', 'write', 'saveImage', 'resize', 'rename', 'archive', 'attach', 'readArchive', 'restore', 'fork',
    'deleteArchive', 'gitInfo', 'switchBranch']) {
    context.methods.register(`sessions.${method}`, (...args) => {
      const result = sessions[method](id, ...args);
      if (method === 'write') {
        sessions.publish(id);
      }
      return result;
    }, { exclusive: ['create', 'restore', 'fork', 'switchBranch'].includes(method),
      resource: ['create', 'restore', 'fork', 'write', 'switchBranch'].includes(method) ? (...args) => resource(method, ...args) : undefined,
      resourceExclusive: method === 'switchBranch' });
  }
  for (const [suffix, file] of [['Layout', 'layout'], ['AdapterConfig', 'config']]) {
    context.methods.register(`storage.get${suffix}`, () => storage.readJson(`plugin-data/${id}/${file}.json`, {}));
    context.methods.register(`storage.save${suffix}`, (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(Error('配置必须为对象'), { code: 'INVALID_ARGUMENT' });
      }
      return storage.writeJson(`plugin-data/${id}/${file}.json`, value);
    }, { exclusive: true });
  }
  context.methods.register('adapters.list', () => [...adapters.values()].map(({ id, name, capabilities, permissionModes }) =>
    ({ id, name, capabilities, permissionModes })));
  context.lifecycle.register({
    snapshot: async () => {
      const layout = await storage.readJson(`plugin-data/${id}/layout.json`, {});
      return sessions.list(id).sessions.map((session) => ({ id: session.id, name: session.name, pid: session.pid,
        exited: session.exited, collapsed: (layout.collapsed || []).includes(session.id), error: session.error }));
    },
    stop: (reason) => sessions.stopAndArchive(id, reason)
  });
  context.views.register({ id: 'sessions', title: 'AI Agent 会话', entry: 'dist/renderer/index.html' });
}

export function deactivate() {}
