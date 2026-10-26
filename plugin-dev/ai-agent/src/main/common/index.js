import { EngineManager } from './engines.js';
import { AgentTasks, registerTasks } from './tasks.js';
import { Conversations } from './conversations.js';
import { homedir } from 'node:os';
import { resolveLaunchConfig } from './launch-config.js';
import { readGit } from './git.js';
import { Sessions } from './sessions.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createClaudeAdapter } from './adapters/claude.js';
import { createCustomCliAdapter } from './adapters/custom-cli.js';
import { CaptureManager } from './capture/manager.js';

export async function activate(context) {
  const id = context.pluginId;
  const storage = context.storage;
  const adapters = new Map();
  const runtime = new EngineManager({ root: await storage.path(`plugin-data/${id}`), tar: await context.importModule('tar') });
  let conversationPids = [];
  const reportProcesses = () => context.ownProcesses([...sessions.active.values()].map(session => session.pid).concat(conversationPids, runtime.loginChild?.pid).filter(Boolean));
  const sessions = new Sessions({ storage, spawn: (await context.importModule('node-pty')).spawn,
    emit: (channel, value) => {
      context.emit(channel, value);
      reportProcesses();
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
  for (const factory of [createCodexAdapter, createClaudeAdapter, createCustomCliAdapter]) {
    const adapter = factory();
    adapter.buildLaunch = async (input) => {
      const config = await storage.readJson(`plugin-data/${id}/config.json`, {});
      const settings = config[adapter.id] || {};
      const legacy = input.legacy === true || settings.mode === 'legacy' || (input.mode !== 'new' && !input.runtimeId && input.contextId);
      const launchOverrides = await resolveLaunchConfig(context, adapter.id, input);
      if (adapter.id === 'claude' || (adapter.id === 'codex' && !legacy)) {
        const managed = await runtime.launch(input.profileId, adapter.id);
        if (input.runtimeId && input.runtimeId !== managed.runtimeId) {
          throw Error('会话固定的引擎版本尚未安装，不能自动切换版本');
        }
        const launch = factory().buildLaunch({ ...input, launchOverrides });
        return { ...launch, ...managed, args: [...managed.args, ...launch.args] };
      }
      return factory(settings).buildLaunch({ ...input, launchOverrides });
    };
    adapters.set(adapter.id, adapter);
  }
  await sessions.loadPlugin(id);
  const conversations = new Conversations({ storage, pluginId: id, runtime, capabilities: context.capabilities,
    emit: (channel, value) => context.emit(channel, value),
    ownProcesses: pids => { conversationPids = pids; reportProcesses(); } });
  await conversations.load();
  const capture = new CaptureManager({ root: await storage.path(`plugin-data/${id}/capture`), conversations });
  conversations.capture = capture;
  context.methods.register('capture.service', input => capture.handle(input));
  context.services.register({ contract: 'agent.capture.v2', method: 'capture.service' });
  const tasks = new AgentTasks({ conversations, storage, pluginId: id });
  await tasks.load();
  await registerTasks(context.capabilities, tasks);
  runtime.onProcesses = reportProcesses;
  context.methods.register('runtime.status', async () => (await runtime.list()).find(engine => engine.id === 'codex'));
  context.methods.register('runtime.install', archive => runtime.install('codex', archive));
  context.methods.register('engines.list', () => runtime.list());
  context.methods.register('engines.config', () => runtime.config());
  context.methods.register('engines.configure', input => runtime.configure(input), { exclusive: true });
  context.methods.register('engines.install', (engineId, archive) => runtime.install(engineId, archive));
  for (const method of ['remove', 'importAuth']) {
    context.methods.register(`engines.${method}`, async engineId => {
      if (sessions.launching || [...sessions.active.values()].some(session => !session.exited && session.adapterId === engineId) || runtime.loginChild) {
        throw Error('请先结束该引擎的终端会话或登录');
      }
      await conversations.prepareEngineChange(engineId);
      return runtime[method](engineId);
    }, { exclusive: true });
  }
  for (const method of ['list', 'read', 'create', 'send', 'cancel', 'approve', 'answer', 'account', 'registerWindow', 'listWindows', 'attachWindow']) {
    context.methods.register(`conversation.${method}`, (...args) => conversations[method](...args));
  }
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
        exited: session.exited, collapsed: (layout.collapsed || []).includes(session.id), error: session.error })).concat(conversations.list().map(record => ({
        id: record.id, name: record.name, exited: record.state !== 'running', state: record.state, protocol: record.protocol
      })));
    },
    stop: async (reason) => {
      runtime.stop();
      await tasks.stop();
      await conversations.stop();
      await capture.close();
      await sessions.stopAndArchive(id, reason);
    }
  });
  // The launcher opens the session workbench; the global AI entry keeps its dedicated conversation view.
  context.views.register({ id: 'sessions', title: 'AI Agent 会话', entry: 'dist/renderer/index.html' });
  context.views.register({ id: 'conversation', title: 'AI 对话', entry: 'dist/renderer/conversation.html',
    contributes: { entries: ['global-conversation'] } });
}

export function deactivate() {}
