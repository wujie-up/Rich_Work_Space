import { createScriptRunner } from './scripts.js';
import { Credentials } from './credentials.js';
import { Runs } from './runs.js';
import { WorkflowInteractions } from './workflow-interactions.js';
import { Engine } from './engine.js';
import { createRegistry } from './nodes.js';
import { createAgents, AGENT_CONTRACT } from './agents.js';
import { Workflows } from './workflows.js';
import { WorkflowTransfer } from './workflow-transfer.js';
import { Scheduler, MODES, UNITS } from './triggers.js';
import { ScheduledTasks } from './scheduled-tasks.js';
import { fail } from './errors.js';
import { MenuWorkflows } from './menu-workflow.js';
import { TaskClient } from './task-client.js';
import { MessageConnections } from './message-connections.js';
import { MessageQueue } from './message-queue.js';
import { MessageTriggers } from './message-triggers.js';
import { validateMessageConnection } from './message-input.js';
import { ensureDocumentReviewTemplate } from './document-review-template.js';
import { FeishuRobotSettings } from './feishu-robot-settings.js';
import { sendFeishuText, FEISHU_TEST_TEXT } from './feishu-robot.js';

export const WORKFLOW_CONTRACT = 'workflow.run.v1';
let cleanup = null;

export async function activate(context) {
  const id = context.pluginId;
  const logger = (level, event, fields) => console[level](`[work-flow:${event}]`, { pluginId: id, ...fields });
  const credentials = new Credentials({ storage: context.storage, pluginId: id });
  const tasks = new TaskClient(context.capabilities);
  const menus = new MenuWorkflows({ storage: context.storage, tasks, pluginId: id });
  const robots = new FeishuRobotSettings({ storage: context.storage, pluginId: id });
  const scripts = createScriptRunner({ ownProcesses: pids => context.ownProcesses(pids) });
  const registry = createRegistry({ credentials, menus, tasks, robots, scripts, logger });
  const workflows = new Workflows({ storage: context.storage, pluginId: id,
    classify: typeId => registry.list().find(type => type.type === typeId) || {} });
  await ensureDocumentReviewTemplate({ storage: context.storage, workflows, pluginId: id, logger });
  const runs = new Runs({ storage: context.storage, pluginId: id });
  const agents = createAgents({ tasks, logger });
  let messages;
  let triggers;
  const engine = new Engine({ hostMessages: Boolean(context.host?.messages), runs, credentials, agents, pluginId: id, logger,
    emit: (channel, value) => {
      context.emit(channel, value);
      messages?.changed(value);
      if (channel === 'runs.changed') {
        void triggers?.record(value);
      }
    }, registry });
  for (const workflow of await workflows.list()) { await engine.restore(workflow.id); }
  const scheduledTasks = new ScheduledTasks({ storage: context.storage, pluginId: id });
  triggers = new Scheduler({ workflows, engine, tasks: scheduledTasks, logger, pluginId: id,
    emit: (channel, value) => context.emit(channel, value) });
  const connections = new MessageConnections({ storage: context.storage, pluginId: id });
  const queue = new MessageQueue({ storage: context.storage, pluginId: id });
  messages = new MessageTriggers({ connections, queue, workflows, engine, storage: context.storage, pluginId: id, logger,
    emit: (channel, value) => context.emit(channel, value) });
  const interactions = context.host?.messages ? new WorkflowInteractions({ engine, messages: context.host.messages, logger }) : null;
  let stopping;
  cleanup = reason => stopping ||= (async () => {
    triggers.stop();
    await triggers.drain();
    await interactions?.stop();
    await messages.stop();
    scripts.stop();
    await engine.stop(reason);
    await interactions?.task;
    await menus.stop();
    await scheduledTasks.pending;
  })();
  // One workflow runs one instance at a time; a trigger arriving while a run is active is rejected, not queued.
  const startRun = async workflowId => {
    if (engine.activeRun(workflowId)) {
      throw fail('RUN_BUSY', '该工作流正在运行中，请等待结束后再触发');
    }
    const workflow = await workflows.read(workflowId);
    return ['once', 'daily', 'interval'].includes(workflow.trigger?.mode)
      ? triggers.triggerNow(workflowId) : engine.start(workflow);
  };
  const menuAction = (stages, action) => async input => {
    const run = await engine.get(input.runId);
    if (run?.pending?.kind !== 'manual' || !stages.includes(run.pending.stage)) {
      throw fail('MENU_STAGE', '该操作不属于当前人工确认步骤，请刷新运行状态');
    }
    return action(input, run);
  };
  const transfer = new WorkflowTransfer({ workflows, types: () => registry.list(), activeRun: id => engine.activeRun(id), logger });
  const setTriggerEnabled = ({ workflowId, enabled }) => messages.change(async () => {
    if (typeof enabled !== 'boolean') {
      throw fail('INVALID_ARGUMENT', '定时启用状态必须为布尔值');
    }
    const workflow = await workflows.read(workflowId);
    if (!['once', 'daily', 'interval'].includes(workflow.trigger?.mode)) {
      throw fail('INVALID_ARGUMENT', '该工作流没有配置定时运行');
    }
    // Persist only the switch against the latest definition; current runs and other windows' edits stay independent.
    const saved = workflow.trigger.enabled === enabled ? workflow
      : await workflows.save({ ...workflow, trigger: { ...workflow.trigger, enabled } });
    await triggers.refresh();
    logger('info', enabled ? 'trigger-enabled' : 'trigger-disabled', { workflowId, mode: saved.trigger.mode, enabled });
    return saved;
  });
  const exclusive = ['workflows.save', 'workflows.remove', 'workflows.renameGroup', 'workflows.createGroup', 'workflows.removeGroup',
    'workflows.moveGroup', 'workflows.reorder', 'workflows.reorderGroups', 'workflows.setGroupCollapsed', 'workflows.import', 'workflows.export', 'credentials.save', 'credentials.remove',
    'messages.connections.save', 'messages.connections.remove', 'messages.connections.test', 'messages.connections.disconnect',
    'messages.connections.reconnect', 'messages.queue.clear', 'messages.queue.retry', 'robots.feishu.save', 'robots.feishu.test',
    'triggers.enable', 'triggers.setEnabled'];
  const methods = {
    'nodes.types': () => engine.types(),
    'agents.providers': async () => ({ contract: AGENT_CONTRACT, providers: await agents.providers() }),
    'workflows.list': () => workflows.list(),
    'workflows.groups': input => workflows.listGroups(input),
    'workflows.createGroup': async input => {
      const group = await workflows.createGroup(input);
      logger('info', 'workflow-group-created', { groupId: group.id, name: group.name });
      return group;
    },
    'workflows.removeGroup': async input => {
      const moved = await workflows.removeGroup(input);
      logger('info', 'workflow-group-removed', { groupId: input.id, workflowIds: moved.map(item => item.id) });
      return moved;
    },
    'workflows.moveGroup': async input => {
      const moved = await workflows.moveGroup(input);
      logger('info', 'workflow-group-moved', { workflowId: input.workflowId, groupId: input.groupId });
      return moved;
    },
    'workflows.reorder': async input => {
      const order = await workflows.reorder(input);
      logger('info', 'workflow-reordered', { workflowId: input.workflowId, targetId: input.targetId, position: input.position });
      return order;
    },
    'workflows.setGroupCollapsed': input => workflows.setGroupCollapsed(input),
    'workflows.reorderGroups': async input => {
      const order = await workflows.reorderGroups(input);
      logger('info', 'workflow-groups-reordered', { groupId: input.id, targetId: input.targetId, position: input.position });
      return order;
    },
    'workflows.renameGroup': async input => {
      const renamed = await workflows.renameGroup(input);
      logger('info', 'workflow-group-renamed', { groupId: input.id, group: input.group, name: input.name.trim(), workflowIds: renamed.map(item => item.id) });
      return renamed;
    },
    'workflows.inspect': path => transfer.inspect(path),
    'workflows.export': input => transfer.export(input),
    'workflows.import': input => messages.change(async () => {
      const result = await transfer.import(input);
      await triggers.refresh();
      return result;
    }),
    'workflows.save': input => messages.change(async () => {
      validateMessageConnection(input, await connections.list());
      const saved = await workflows.save(input);
      // Saving can turn a schedule on or off, so the timers follow the write.
      await triggers.refresh();
      return saved;
    }),
    'workflows.remove': async workflowId => {
      const release = triggers.invalidate(workflowId);
      try {
        await triggers.drain(workflowId);
        await messages.change(async () => {
          for (const run of engine.records.values()) {
            if (run.workflowId === workflowId && engine.active.has(run.id)) { await engine.cancel(run.id); }
          }
          await workflows.remove(workflowId);
          await triggers.refresh();
        });
      } finally {
        release();
      }
    },
    'triggers.options': () => ({ modes: MODES, units: UNITS, contract: WORKFLOW_CONTRACT }),
    'triggers.next': () => triggers.list(),
    'triggers.enable': workflowId => setTriggerEnabled({ workflowId, enabled: true }),
    'triggers.setEnabled': setTriggerEnabled,
    'triggers.fire': workflowId => triggers.triggerNow(workflowId),
    'runs.list': workflowId => runs.list(workflowId),
    'runs.activity': () => [...engine.active.keys()].map(runId => engine.get(runId))
      .filter(run => ['running', 'waiting'].includes(run.status)),
    'runs.get': runId => engine.get(runId),
    'runs.start': async workflowId => await startRun(workflowId),
    // Other plugins trigger a run through the published contract; an explicit call is not limited by the mode.
    'runs.trigger': async input => {
      if (!input || input.version !== 1 || !String(input.workflowId || '')) {
        throw fail('INVALID_ARGUMENT', `${WORKFLOW_CONTRACT} 需要 version=1 与 workflowId`);
      }
      const run = await startRun(String(input.workflowId));
      return { version: 1, runId: run.id };
    },
    'runs.resume': runId => {
      const run = engine.get(runId);
      // The background coordinator may already have resumed this service before the view polls again.
      if (run.origin?.kind === 'message' || run.status !== 'waiting') {
        return run;
      }
      if (run.status !== 'waiting' || run.pending?.kind !== 'service') {
        return engine.resume(runId);
      }
      // Finish the view RPC before starting approval, so its deadline cannot bound the human wait.
      setImmediate(() => {
        const current = engine.get(runId);
        if (current.status === 'waiting' && current.pending?.kind === 'service') {
          engine.resume(runId).catch(error => logger('error', 'run-resume-failed', { runId, message: error.message }));
        }
      });
      return run;
    },
    'runs.loop': input => engine.decideLoop(input.runId, input.decision),
    'runs.retry': runId => engine.retry(runId),
    'runs.interrupt': runId => engine.interrupt(runId),
    'runs.continue': runId => engine.continue(runId),
    'runs.reselectFile': input => engine.reselectFile(input.runId, input.nodeId),
    'runs.respond': input => engine.respond(input.runId, input),
    'runs.answer': input => engine.answer(input.runId, input),
    'runs.sessions': async input => {
      const run = engine.records.get(input.runId) || (await runs.list(input.workflowId)).find(item => item.id === input.runId);
      if (!run) { throw fail('RUN_NOT_FOUND', '未找到运行记录'); }
      return run.sessions || [];
    },
    'runs.sessionHistory': async input => {
      const run = engine.records.get(input.runId) || (await runs.list(input.workflowId)).find(item => item.id === input.runId);
      const binding = run?.sessions?.find(item => item.sessionId === input.sessionId);
      if (!binding) { throw fail('SESSION_FORBIDDEN', '会话不属于当前运行'); }
      return agents.history(binding, { afterSequence: input.afterSequence, limit: input.limit });
    },
    'runs.confirm': input => {
      const run = engine.get(input.runId);
      if (!run.pending?.form) {
        throw fail('RUN_NOT_WAITING', '当前运行没有等待填写的输入请求');
      }
      return engine.complete(input.runId, input.nodeId, input);
    },
    'runs.cancel': async runId => ({ canceled: await engine.cancel(runId) }),
    'menu.providers': () => tasks.providers(),
    'menu.read': runId => menus.read(runId),
    'menu.load': menuAction(['load'], input => menus.load(input)),
    'menu.edit': menuAction(['tree'], input => menus.edit(input)),
    'menu.plan': menuAction(['tree'], input => menus.plan(input)),
    'menu.code': menuAction(['code'], input => menus.code(input)),
    'menu.poll': menuAction(['tree', 'code'], input => menus.poll(input)),
    'menu.respond': menuAction(['tree', 'code'], input => menus.respond(input)),
    'menu.stopTask': input => menus.stopTask(input),
    'menu.confirm': menuAction(['load', 'tree', 'code', 'sql'], (input, run) => engine.complete(input.runId, run.pending.nodeId, input)),
    'menu.reset': menuAction(['tree', 'code', 'sql'], async (input, run) => {
      if (!['load', 'tree'].includes(input.stage)) { throw fail('MENU_STAGE', '只能返回目录或资源树步骤'); }
      const session = await menus.session(input.runId);
      menus.check(session, input.revision);
      await menus.invalidate(session);
      if (input.stage === 'load') { session.confirmations = {}; }
      await menus.save(session);
      const workflow = await workflows.read(run.workflowId);
      const node = workflow.nodes.find(item => item.type === `menu.${input.stage}`);
      return engine.rewind(input.runId, node.id);
    }),
    'menu.preview': runId => menus.preview(runId),
    'menu.sql': runId => menus.sql(runId),
    'menu.export': input => menus.exportSql(input.runId, input.directory),
    'menu.roots': input => menus.roots(input),
    'menu.sync': input => menus.sync(input),
    'messages.connections.list': () => connections.list(),
    'messages.connections.save': input => messages.change(() => connections.save(input), input.id),
    'messages.connections.remove': connectionId => messages.change(async () => {
      const references = (await workflows.list()).filter(workflow => workflow.nodes.some(node => node.params?.connectionId === connectionId));
      return connections.remove(connectionId, references);
    }, connectionId),
    'messages.connections.test': connectionId => messages.test(connectionId),
    'messages.connections.disconnect': connectionId => messages.disconnect(connectionId),
    'messages.connections.reconnect': connectionId => messages.reconnect(connectionId),
    'messages.status': () => messages.status(),
    'messages.queue.list': workflowId => queue.list(workflowId),
    'messages.queue.clear': workflowId => messages.change(() => queue.clear(workflowId)),
    'messages.queue.retry': itemId => messages.retry(itemId),
    'robots.feishu.read': () => robots.read(),
    'robots.feishu.save': async input => {
      const result = await robots.save(input);
      logger('info', 'feishu-config-saved', { configured: result.configured });
      return result;
    },
    'robots.feishu.test': async () => {
      try {
        const result = await sendFeishuText(await robots.snapshot(), FEISHU_TEST_TEXT);
        logger('info', 'feishu-test-sent', result);
        return result;
      } catch (error) {
        logger('error', 'feishu-test-failed', { stack: error.stack });
        throw error;
      }
    },
    'credentials.list': () => credentials.list(),
    'credentials.save': input => credentials.save(input),
    'credentials.remove': credentialId => credentials.remove(credentialId)
  };
  for (const [name, handler] of Object.entries(methods)) {
    context.methods.register(name, handler, { nativeOnly: ['robots.feishu.save', 'robots.feishu.test'].includes(name),
      exclusive: exclusive.includes(name) || name.startsWith('menu.') && !['menu.providers', 'menu.read', 'menu.sql'].includes(name) });
  }
  context.services.register({ contract: WORKFLOW_CONTRACT, method: 'runs.trigger' });
  context.lifecycle.register({ snapshot: () => [...engine.snapshot(), ...messages.snapshot()], stop: reason => cleanup(reason) });
  context.views.register({ id: 'editor', title: '工作流编排', entry: 'dist/renderer/index.html' });
  await queue.recover();
  await messages.refresh();
  interactions?.start();
  const planned = await triggers.refresh();
  logger('info', 'activated', { methods: Object.keys(methods).length, scheduled: planned.length });
}

export async function deactivate() {
  await cleanup?.('deactivate');
  cleanup = null;
}
