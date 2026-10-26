import { Credentials } from './credentials.js';
import { Runs } from './runs.js';
import { Engine } from './engine.js';
import { createRegistry } from './nodes.js';
import { createAgents, AGENT_CONTRACT } from './agents.js';
import { Workflows } from './workflows.js';
import { Scheduler, MODES, UNITS } from './triggers.js';
import { fail } from './errors.js';
import { MenuWorkflows } from './menu-workflow.js';
import { TaskClient } from './task-client.js';
import { MessageConnections } from './message-connections.js';
import { MessageQueue } from './message-queue.js';
import { MessageTriggers } from './message-triggers.js';
import { validateMessageConnection } from './message-input.js';

export const WORKFLOW_CONTRACT = 'workflow.run.v1';
let cleanup = null;

export async function activate(context) {
  const id = context.pluginId;
  const logger = (level, event, fields) => console[level](`[work-flow:${event}]`, { pluginId: id, ...fields });
  const credentials = new Credentials({ storage: context.storage, pluginId: id });
  const tasks = new TaskClient(context.capabilities);
  const menus = new MenuWorkflows({ storage: context.storage, tasks, pluginId: id });
  const registry = createRegistry({ credentials, menus });
  const workflows = new Workflows({ storage: context.storage, pluginId: id,
    classify: typeId => registry.list().find(type => type.type === typeId) || {} });
  const runs = new Runs({ storage: context.storage, pluginId: id });
  const agents = createAgents({ tasks });
  let messages;
  const engine = new Engine({ runs, credentials, agents, pluginId: id, logger, emit: (channel, value) => { context.emit(channel, value); messages?.changed(value); },
    registry });
  const triggers = new Scheduler({ workflows, engine, logger, pluginId: id });
  const connections = new MessageConnections({ storage: context.storage, pluginId: id });
  const queue = new MessageQueue({ storage: context.storage, pluginId: id });
  messages = new MessageTriggers({ connections, queue, workflows, engine, storage: context.storage, pluginId: id, logger,
    emit: (channel, value) => context.emit(channel, value) });
  let stopping;
  cleanup = reason => stopping ||= (async () => {
    triggers.stop();
    await messages.stop();
    await engine.stop(reason);
    await menus.stop();
  })();
  // One workflow runs one instance at a time; a trigger arriving while a run is active is rejected, not queued.
  const startRun = async workflowId => {
    if (engine.activeRun(workflowId)) {
      throw fail('RUN_BUSY', '该工作流正在运行中，请等待结束后再触发');
    }
    return engine.start(await workflows.read(workflowId));
  };
  const menuAction = (stages, action) => async input => {
    const run = await engine.get(input.runId);
    if (run?.pending?.kind !== 'manual' || !stages.includes(run.pending.stage)) {
      throw fail('MENU_STAGE', '该操作不属于当前人工确认步骤，请刷新运行状态');
    }
    return action(input, run);
  };
  const exclusive = ['workflows.save', 'workflows.remove', 'credentials.save', 'credentials.remove',
    'messages.connections.save', 'messages.connections.remove', 'messages.connections.test', 'messages.connections.disconnect',
    'messages.connections.reconnect', 'messages.queue.clear', 'messages.queue.retry'];
  const methods = {
    'nodes.types': () => engine.types(),
    'agents.providers': async () => ({ contract: AGENT_CONTRACT, providers: await agents.providers() }),
    'workflows.list': () => workflows.list(),
    'workflows.save': input => messages.change(async () => {
      validateMessageConnection(input, await connections.list());
      const saved = await workflows.save(input);
      // Saving can turn a schedule on or off, so the timers follow the write.
      await triggers.refresh();
      return saved;
    }),
    'workflows.remove': workflowId => messages.change(async () => {
      for (const run of engine.records.values()) {
        if (run.workflowId === workflowId && engine.active.has(run.id)) { await engine.cancel(run.id); }
      }
      await workflows.remove(workflowId);
      await triggers.refresh();
    }),
    'triggers.options': () => ({ modes: MODES, units: UNITS, contract: WORKFLOW_CONTRACT }),
    'triggers.next': () => triggers.list(),
    'runs.list': workflowId => runs.list(workflowId),
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
    // The view advances long Agent tasks through short host capability calls.
    'runs.resume': runId => engine.get(runId).origin?.kind === 'message' ? engine.get(runId) : engine.resume(runId),
    'runs.loop': input => engine.decideLoop(input.runId, input.decision),
    'runs.retry': runId => engine.retry(runId),
    'runs.respond': input => engine.respond(input.runId, input),
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
    'credentials.list': () => credentials.list(),
    'credentials.save': input => credentials.save(input),
    'credentials.remove': credentialId => credentials.remove(credentialId)
  };
  for (const [name, handler] of Object.entries(methods)) {
    context.methods.register(name, handler, { exclusive: exclusive.includes(name) || name.startsWith('menu.') && !['menu.providers', 'menu.read', 'menu.sql'].includes(name) });
  }
  context.services.register({ contract: WORKFLOW_CONTRACT, method: 'runs.trigger' });
  context.lifecycle.register({ snapshot: () => [...engine.snapshot(), ...messages.snapshot()], stop: reason => cleanup(reason) });
  context.views.register({ id: 'editor', title: '工作流编排', entry: 'dist/renderer/index.html' });
  await queue.recover();
  await messages.refresh();
  const planned = await triggers.refresh();
  logger('info', 'activated', { methods: Object.keys(methods).length, scheduled: planned.length });
}

export async function deactivate() {
  await cleanup?.('deactivate');
  cleanup = null;
}
