import { roleCatalog } from '../../shared/agent-roles.js';
import { BackgroundSessions, registerBackgroundSessions } from './background-sessions.js';
import { BridgeSessions } from './bridge/sessions.js';
import { registerBridge } from './bridge/capabilities.js';
import { filterLaunchServices, serviceCatalog } from './mcp-selection.js';
import { EngineManager } from './engines.js';
import { AgentTasks, registerTasks } from './tasks.js';
import { Conversations } from './conversations.js';
import { homedir } from 'node:os';
import { McpRelay } from './mcp-relay.js';
import { resolveLaunchConfig, createConversationMcp } from './launch-config.js';
import { readGit } from './git.js';
import { sessionTranscript } from './session-transcript.js';
import { Sessions } from './sessions.js';
import { SessionMessages } from './session-messages.js';
import { SessionCoordination } from './session-coordination.js';
import { SessionGroups } from './session-groups.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createClaudeAdapter } from './adapters/claude.js';
import { createCustomCliAdapter } from './adapters/custom-cli.js';
import { deleteNativeContext } from './session-deletion.js';
import { CaptureManager } from './capture/manager.js';
import { registerAppearance } from './appearance.js';

export async function activate(context) {
  const id = context.pluginId;
  const storage = context.storage;
  registerAppearance(context);
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
  const messages = context.host?.channels ? new SessionMessages({ pluginId: id, sessions, channels: context.host.channels }) : null;
  sessions.messages = messages;
  sessions.deleteContext = session => deleteNativeContext(runtime, session);
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
  const liveMcpLaunch = async (engineId, input, overrides, build) => {
    if (!input.sessionId || !['codex', 'claude'].includes(engineId)) { return build(overrides); }
    const relay = new McpRelay({ pluginId: id, sessionId: input.sessionId, importModule: context.importModule,
      capabilities: context.capabilities,
      builtin: messages ? { get tools() { return messages.tools(input.sessionId); }, call: (name, args) => messages.call(input.sessionId, name, args) } : undefined,
      resolve: name => resolveLaunchConfig(context, engineId, { ...input, mcpServerName: name }) });
    try {
      const launchOverrides = await relay.start(engineId, overrides);
      return { ...build(launchOverrides), mcpConnection: relay };
    } catch (error) {
      await relay.close();
      throw error;
    }
  };
  // Resolve CLI configuration for each launch without disturbing other sessions.
  for (const factory of [createCodexAdapter, createClaudeAdapter, createCustomCliAdapter]) {
    const adapter = factory({ dataRoot: runtime.root });
    adapter.buildLaunch = async (input) => {
      const config = await storage.readJson(`plugin-data/${id}/config.json`, {});
      const settings = config[adapter.id] || {};
      const legacy = input.legacy === true || settings.mode === 'legacy' || (input.mode !== 'new' && !input.runtimeId && input.contextId);
      let launchOverrides;
      if (adapter.id === 'claude' || (adapter.id === 'codex' && !legacy)) {
        // Codex resumes the same isolated context with the currently installed CLI after an engine update.
        const runtimeId = adapter.id === 'codex' ? undefined : input.runtimeId;
        const managed = await runtime.launch(input.profileId, adapter.id, { runtimeId, snapshot: input.launchSettings });
        launchOverrides = filterLaunchServices(adapter.id, await resolveLaunchConfig(context, adapter.id, input), managed.launchSettings?.mcp);
        if (runtimeId && runtimeId !== managed.runtimeId) {
          throw Error('会话固定的引擎版本尚未安装，不能自动切换版本');
        }
        if (input.runtimeId && input.runtimeId !== managed.runtimeId) {
          console.info('[session:runtime-upgrade]', { pluginId: id, sessionId: input.sessionId,
            previousRuntimeId: input.runtimeId, runtimeId: managed.runtimeId });
        }
        const launch = await liveMcpLaunch(adapter.id, input, launchOverrides, overrides =>
          factory().buildLaunch({ ...input, launchOverrides: overrides }));
        return { ...launch, ...managed, args: [...managed.args, ...launch.args] };
      }
      launchOverrides = await resolveLaunchConfig(context, adapter.id, input);
      return liveMcpLaunch(adapter.id, input, launchOverrides, overrides =>
        factory(settings).buildLaunch({ ...input, launchOverrides: overrides }));
    };
    adapters.set(adapter.id, adapter);
  }
  sessions.validateMcpReconnect = async session => {
    const config = await resolveLaunchConfig(context, session.adapterId, session);
    filterLaunchServices(session.adapterId, config, session.launchSettings?.mcp);
  };
  const groups = new SessionGroups({ pluginId: id, storage, sessions });
  sessions.groups = groups;
  await sessions.loadPlugin(id);
  // Recover logical session identities before matching legacy coordinators to their existing contexts.
  await groups.load();
  if (messages) {
    const coordination = new SessionCoordination({ pluginId: id, sessions, storage, messages });
    await coordination.load();
    sessions.coordination = coordination;
  }
  const conversations = new Conversations({ storage, pluginId: id, runtime, capabilities: context.capabilities,
    createNativeMcp: (record, launch) => createConversationMcp(context, record, launch),
    emit: (channel, value) => context.emit(channel, value),
    ownProcesses: pids => { conversationPids = pids; reportProcesses(); } });
  await conversations.load();
  let bridge = null;
  try {
    bridge = new BridgeSessions({ pluginId: id, storage, conversations, sessions });
    await bridge.load();
    await registerBridge(context.capabilities, bridge);
    bridge.start();
  } catch (error) {
    bridge = null;
    console.error('[ai:bridge-unavailable]', { pluginId: id, stack: error.stack });
  }
  context.methods.register('conversation.composer', (conversationId, report) => conversations.composer(conversationId, report));
  const capture = new CaptureManager({ sessions, root: await storage.path(`plugin-data/${id}/capture`), conversations });
  conversations.capture = capture;
  sessions.capture = capture;
  context.methods.register('capture.service', input => capture.handle(input));
  context.services.register({ contract: 'agent.capture.v2', method: 'capture.service' });
  const tasks = new AgentTasks({ conversations, storage, pluginId: id });
  await tasks.load();
  const backgroundSessions = new BackgroundSessions({ tasks, conversations, storage, pluginId: id });
  await backgroundSessions.load();
  await registerBackgroundSessions(context.capabilities, backgroundSessions);
  await registerTasks(context.capabilities, tasks);
  runtime.onProcesses = reportProcesses;
  context.methods.register('runtime.status', async () => (await runtime.list()).find(engine => engine.id === 'codex'));
  context.methods.register('runtime.install', archive => runtime.install('codex', archive));
  context.methods.register('providers.list', () => runtime.providers.list());
  context.methods.register('providers.save', input => runtime.providers.save(input));
  context.methods.register('providers.remove', providerId => runtime.providers.remove(providerId));
  context.methods.register('providers.test', (engineId, providerId) => runtime.providers.test(engineId, providerId));
  context.methods.register('mcp.catalog', async () => serviceCatalog(await context.capabilities.discover()));
  context.methods.register('engines.list', () => runtime.list());
  context.methods.register('engines.config', () => runtime.config());
  context.methods.register('engines.configure', input => runtime.configure(input), { exclusive: true });
  context.methods.register('engines.versions', engineId => runtime.releases.list(engineId));
  context.methods.register('engines.install', (engineId, archive, version) => runtime.install(engineId, archive, version));
  for (const method of ['remove', 'importAuth']) {
    context.methods.register(`engines.${method}`, async engineId => {
      if (sessions.launching || [...sessions.active.values()].some(session => !session.exited && session.adapterId === engineId) || runtime.loginChild) {
        throw Error('请先结束该引擎的终端会话或登录');
      }
      await conversations.prepareEngineChange(engineId);
      return runtime[method](engineId);
    }, { exclusive: true });
  }
  for (const method of ['list', 'read', 'create', 'send', 'reconnect', 'cancel', 'approve', 'answer', 'elicit', 'account',
    'registerWindow', 'listWindows', 'attachWindow']) {
    context.methods.register(`conversation.${method}`, (...args) => conversations[method](...args));
  }
  const resource = async (method, ...args) => {
    if (method === 'create' || method === 'restore') {
      const input = method === 'create' ? args[0]
        : sessions.active.has(args[0]) ? sessions.get(id, args[0]) : await sessions.readArchive(id, args[0]);
      const info = typeof input.cwd === 'string' ? await readGit(input.cwd.replace(/^~(?=\/|$)/, homedir())) : null;
      return info ? `git:${info.root}` : null;
    }
    const session = sessions.get(id, args[0]);
    return session.git ? `git:${session.git.root}` : null;
  };
  context.methods.register('sessions.composer', (sessionId, report) => messages?.composer(sessionId, report));
  context.methods.register('groups.create', input => groups.create(input), {
    exclusive: true, resource: input => resource('create', input)
  });
  for (const method of ['rename', 'delete', 'archive']) {
    context.methods.register(`groups.${method}`, (...args) => groups[method](...args), { exclusive: true });
  }
  context.methods.register('groups.assign', (sessionId, groupId) => groups.assign(sessionId, groupId), { exclusive: true });
  const readTranscript = sessionTranscript(runtime.root);
  context.methods.register('sessions.transcript', sessionId => readTranscript(sessions.get(id, sessionId)));
  context.methods.register('sessions.recover', (windowId, hostWindows) => sessions.recover(id, windowId,
    hostWindows.map(window => conversations.windowViews.get(window.id)).filter(Boolean)));
  for (const method of ['list', 'setTheme', 'create', 'write', 'saveImage', 'fileReferences', 'resize', 'rename', 'archive', 'attach', 'attachWindow', 'readArchive', 'restore', 'reconnect', 'resetContext', 'fork',
    'delete', 'deleteArchive', 'updateArchiveDirectory', 'gitInfo', 'refreshGit', 'switchBranch']) {
    context.methods.register(`sessions.${method}`, (...args) => {
      const result = sessions[method](id, ...args);
      if (method === 'write') {
        sessions.publish(id);
      }
      return result;
    }, { exclusive: ['updateArchiveDirectory', 'create', 'restore', 'reconnect', 'resetContext', 'fork', 'delete', 'switchBranch'].includes(method),
      resource: ['create', 'restore', 'reconnect', 'resetContext', 'fork', 'write', 'switchBranch'].includes(method) ? (...args) => resource(method, ...args) : undefined,
      resourceExclusive: method === 'switchBranch' });
  }
  for (const [suffix, file] of [['Layout', 'layout'], ['AdapterConfig', 'config'], ['Roles', 'roles']]) {
    context.methods.register(`storage.get${suffix}`, () => storage.readJson(`plugin-data/${id}/${file}.json`, {}));
    context.methods.register(`storage.save${suffix}`, (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(Error('配置必须为对象'), { code: 'INVALID_ARGUMENT' });
      }
      return storage.writeJson(`plugin-data/${id}/${file}.json`, suffix === 'Roles' ? roleCatalog(value) : value);
    }, { exclusive: true });
  }
  context.methods.register('adapters.list', () => [...adapters.values()].map(({ id, name, capabilities, permissionModes }) =>
    ({ id, name, capabilities, permissionModes })));
  context.lifecycle.register({
    snapshot: async () => {
      const layout = await storage.readJson(`plugin-data/${id}/layout.json`, {});
      return sessions.list(id).sessions.map((session) => ({ id: session.id, name: session.name, pid: session.pid,
        exited: session.exited, collapsed: (layout.collapsed || []).includes(session.restoredFrom || session.id), error: session.error })).concat(conversations.list().map(record => ({
        id: record.id, name: record.name, exited: record.state !== 'running', state: record.state, protocol: record.protocol
      })));
    },
    stop: async (reason) => {
      sessions.blockInput();
      try {
        await bridge?.stop();
      } catch (error) {
        bridge = null;
        console.error('[ai:bridge-stop-failed]', { pluginId: id, reason, stack: error.stack });
      }
      await messages?.stop();
      runtime.stop();
      await backgroundSessions.stop();
      await tasks.stop();
      await conversations.stop();
      await sessions.stopAndArchive(id, reason);
      await capture.close();
    }
  });
  // The launcher opens the session workbench; the global AI entry keeps its dedicated conversation view.
  messages?.start();
  context.views.register({ id: 'sessions', title: 'AI Agent 会话', entry: 'dist/renderer/index.html' });
  context.views.register({ id: 'conversation', title: 'AI 对话', entry: 'dist/renderer/conversation.html',
    contributes: { entries: ['global-conversation'] } });
}

export function deactivate() {}
