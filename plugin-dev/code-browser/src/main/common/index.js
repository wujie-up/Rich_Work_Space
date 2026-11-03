import { Workspace, fail } from './workspace.js';
import { GitReader } from './git.js';
import { GitManager } from './git-manager.js';
import { definitions } from './java.js';
import { mavenProjects } from './maven-projects.js';
import { editFile, saveFile } from './editor.js';
import { SpringRunner, springApps } from './spring.js';
import { MavenBuild } from './maven.js';
import { randomUUID } from 'node:crypto';
import { tools, descriptor } from './capabilities.js';

let shutdown = async () => {};

export async function activate(context) {
  const key = `plugin-data/${context.pluginId}/settings.json`;
  const settings = await context.storage.readJson(key, {}) || {};
  const viewKey = `plugin-data/${context.pluginId}/view-state.json`;
  let viewWrites = Promise.resolve();
  context.methods.register('code.viewState', input => {
    const operation = viewWrites.then(async () => {
      const state = await context.storage.readJson(viewKey, {}) || {};
      if (input?.key) {
        state[input.key] = input.value;
        await context.storage.writeJson(viewKey, state);
      }
      return state;
    });
    viewWrites = operation.catch(error => {
      console.error('[code-browser:view-state]', { pluginId: context.pluginId, key: input?.key, error });
    });
    return operation;
  });
  let workspace;
  let restoreError;
  let stopped = false;
  let selecting = false;
  let gitStarting = false;
  let saving = false;
  let gitCompletion;
  const operations = new Map();
  const processes = new Map();
  const report = owner => pids => {
    processes.set(owner, pids);
    context.ownProcesses([...processes.values()].flat());
  };
  const git = new GitReader(report('git'));
  const maven = new MavenBuild(report('maven'));
  const manager = new GitManager(report('git-write'));
  const spring = new SpringRunner(report('spring'));
  const gitBusy = () => gitStarting || manager.starting || manager.snapshot()?.state === 'running';
  if (settings?.root) {
    workspace = await Workspace.open(settings.root).catch(error => {
      restoreError = `项目目录不可用：${error.message}`;
      console.error('[code-browser:restore]', { pluginId: context.pluginId, root: settings.root, message: error.message });
    });
  }
  const current = () => {
    if (!workspace) {
      throw fail('NO_WORKSPACE', '请先在coding插件中选择项目目录');
    }
    return workspace;
  };
  const handlers = {
    workspace: async () => ({ root: workspace?.root || null, error: restoreError || null,
      history: [...new Set([workspace?.root, ...(settings.history || [])].filter(Boolean))].slice(0, 20) }),
    list: input => current().list(input),
    read: input => current().read(input),
    edit: input => editFile(current(), input),
    save: async input => {
      if (saving || selecting || gitBusy()) {
        throw fail('WORKSPACE_BUSY', '项目正在切换或执行 Git 任务，请稍后保存');
      }
      saving = true;
      try {
        return await saveFile(current(), input);
      } finally {
        saving = false;
      }
    },
    springApps: async (_, signal) => ({ ...await springApps(current(), signal), tasks: spring.tasks() }),
    springTask: async ({ id }) => ({ task: spring.snapshot(id) }),
    startSpring: async (input, signal) => {
      if (saving || selecting || gitBusy() || maven.starting || maven.snapshot()?.state === 'running') {
        throw fail('WORKSPACE_BUSY', '正在切换项目或执行 Git / Maven 任务');
      }
      return { task: await spring.start(current(), input, signal) };
    },
    stopSpring: async ({ id }) => ({ task: await spring.cancel(id) }),
    definitions: (input, signal) => definitions(current(), input, signal),
    search: (input, signal) => current().search(input, signal),
    log: (input, signal) => git.log(current(), input, signal),
    diff: (input, signal) => git.diff(current(), input, signal),
    show: (input, signal) => git.show(current(), input, signal),
    gitStatus: (_, signal) => manager.status(current(), signal),
    gitTask: async () => ({ task: manager.snapshot() }),
    cancelGit: async ({ id }) => ({ task: await manager.cancel(id) }),
    gitOperation: async (input, signal) => {
      const selected = current();
      if (saving || selecting || gitBusy() || maven.starting || maven.snapshot()?.state === 'running' || spring.busy) {
        throw fail('WORKSPACE_BUSY', '项目正在执行 Git 或 Maven 任务或 Spring Boot 服务，请稍后重试');
      }
      gitStarting = true;
      let lease;
      try {
        const root = await manager.repository(selected, signal);
        if (!context.resources?.acquire) {
          throw fail('HOST_UPDATE_REQUIRED', '请升级工作台以支持仓库资源互斥');
        }
        lease = await context.resources.acquire(`git:${root}`, { exclusive: true });
        signal.throwIfAborted();
        const task = await manager.start(selected, input);
        // The lease covers the child process, beyond the initiating RPC lifetime.
        gitCompletion = manager.wait(task.id).finally(() => lease.release());
        gitCompletion.catch(error => console.error('[code-browser:git-release]', {
          pluginId: context.pluginId, taskId: task.id, root, message: error.message
        }));
        return { task };
      } catch (error) {
        await lease?.release();
        throw error;
      } finally {
        gitStarting = false;
      }
    },
    mavenProjects: (input, signal) => mavenProjects(current(), signal),
    compile: async input => {
      if (saving || selecting || gitBusy() || spring.busy) {
        throw fail('WORKSPACE_BUSY', '正在切换项目或执行 Git 任务，请稍后编译');
      }
      return { task: await maven.start(current(), input) };
    },
    build: async () => ({ task: maven.snapshot() }),
    cancelBuild: async ({ id }) => ({ task: await maven.cancel(id) })
  };
  const guard = (name, handler) => async (input = {}, call = {}) => {
    if (stopped) {
      throw fail('STOPPED', '插件已停止');
    }
    const controller = new AbortController();
    const signal = call.signal ? AbortSignal.any([controller.signal, call.signal]) : controller.signal;
    const operation = { id: call.invocationId || randomUUID(), title: name };
    const completion = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const value = await handler(input, signal);
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(value)) > 900 * 1024) {
        throw fail('OUTPUT_LIMIT', '结果过大，请缩小目录、文件或行范围');
      }
      return value;
    });
    operations.set(controller, { ...operation, completion });
    try {
      return await completion;
    } catch (error) {
      console.error('[code-browser:operation]', { pluginId: context.pluginId, taskId: operation.id, operation: name,
        path: input?.path, message: error.message });
      throw error;
    } finally {
      operations.delete(controller);
    }
  };
  for (const tool of tools) {
    const handler = guard(tool.name, handlers[tool.name]);
    context.methods.register(`code.${tool.name}`, handler);
    await context.capabilities.register(descriptor(tool), handler);
  }
  context.methods.register('code.gitPushPreview', guard('gitPushPreview', (input, signal) => manager.pushPreview(current(), input, signal)));
  context.methods.register('code.springTasks', guard('springTasks', async () => ({ tasks: spring.tasks() })));
  context.methods.register('code.branches', guard('branches', (_, signal) => git.branches(current(), signal)));
  context.methods.register('code.select', guard('select', async ({ root }) => {
    if (saving || selecting || gitBusy() || maven.starting || maven.snapshot()?.state === 'running' || spring.busy) {
      throw fail('BUILD_BUSY', '正在执行 Git 或 Maven 任务或 Spring Boot 服务，请先停止任务再切换项目');
    }
    selecting = true;
    try {
      const selected = await Workspace.open(root);
      const history = [selected.root, ...(settings.history || []).filter(path => path !== selected.root)].slice(0, 20);
      await context.storage.writeJson(key, { ...settings, root: selected.root, history });
      Object.assign(settings, { root: selected.root, history });
      workspace = selected;
      restoreError = null;
      console.info('[code-browser:workspace]', { pluginId: context.pluginId, root: selected.root });
      return { root: selected.root, history: settings.history };
    } finally {
      selecting = false;
    }
  }), { exclusive: true });
  shutdown = async () => {
    stopped = true;
    for (const controller of operations.keys()) {
      controller.abort();
    }
    await Promise.all([git.stop(), manager.stop(), maven.stop(), spring.stop()]);
    await Promise.allSettled([...operations.values()].map(operation => operation.completion));
    await gitCompletion?.catch(() => {});
  };
  context.lifecycle.register({ snapshot: async () => [
    ...[...operations.values()].map(({ id, title }) => ({ id, title })),
    ...(manager.snapshot()?.state === 'running' ? [{ id: manager.snapshot().id, title: 'Git operation' }] : []),
    ...spring.tasks().filter(task => task.state === 'running').map(task => ({ id: task.id, title: `Spring Boot: ${task.mainClass}` })),
    ...(maven.snapshot()?.state === 'running' ? [{ id: maven.snapshot().id, title: 'Maven compile' }] : [])
  ], stop: shutdown });
  console.info('[code-browser:start]', { pluginId: context.pluginId, root: workspace?.root || null });
}

export async function deactivate() {
  await shutdown();
}
