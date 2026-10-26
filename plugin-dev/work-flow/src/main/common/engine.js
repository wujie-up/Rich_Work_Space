import { randomUUID } from 'node:crypto';
import { isMessageType } from './message-input.js';
import { normalizedMessage } from './message-receiver.js';
import { executionOrder, forwardEdges, descendants, isBranch } from './control-flow.js';
import { fail } from './errors.js';
import { resolveParams, value as resolveValue } from './template.js';

const MAX_TEXT = 4000;

// Runs execute asynchronously behind the RPC boundary; every transition is persisted and emitted.
export class Engine {
  constructor({ registry, runs, credentials, agents, emit, logger, pluginId, now = () => Date.now() }) {
    Object.assign(this, { registry, runs, credentials, agents, emit, logger, pluginId, now });
    this.active = new Map();
    this.records = new Map();
  }

  types() {
    return this.registry.list();
  }

  async start(workflow, { runId, entryNodeId, message } = {}) {
    const entry = workflow.nodes.find(node => node.id === entryNodeId && isMessageType(node.type));
    if (workflow.nodes.some(node => isMessageType(node.type))
      && (!entry || !normalizedMessage(message || {}) || entry.type !== `message.${message.channel}`
        || entry.params.connectionId !== message.connectionId)) {
      throw fail('MESSAGE_EVENT_REQUIRED', '消息工作流需要收到消息，请开启消息监听');
    }
    for (const node of workflow.nodes) {
      this.registry.get(node.type);
    }
    const reachable = this.#reachable(workflow, entryNodeId);
    const order = executionOrder(workflow).filter(node => reachable.has(node.id));
    const run = { id: runId || randomUUID(), workflowId: workflow.id, workflowName: workflow.name, status: 'running',
      startedAt: this.now(), endedAt: null, error: null, nodes: {} };
    if (entry) {
      run.origin = { kind: 'message', connectionId: message.connectionId, messageId: message.messageId, entryNodeId };
      run.input = structuredClone(message);
    }
    for (const node of workflow.nodes) {
      if (!reachable.has(node.id)) {
        run.nodes[node.id] = { status: 'skipped', startedAt: this.now(), endedAt: this.now(),
          reason: '不在开始节点可达的流程路径上' };
      }
    }
    const control = { canceled: false, workflow, order, message: run.input, outputs: {}, controller: new AbortController(),
      branching: workflow.nodes.some(node => isBranch(node.type)), loops: {}, loopContext: { iteration: 1, previous: {} } };
    this.active.set(run.id, control);
    this.records.set(run.id, run);
    this.logger('info', 'run-start', { pluginId: this.pluginId, runId: run.id, workflowId: workflow.id, nodes: order.length });
    try {
      await this.#persist(run);
    } catch (error) {
      // No node has started yet; a failed initial write must not reserve the workflow forever.
      this.active.delete(run.id);
      this.records.delete(run.id);
      throw error;
    }
    control.task = this.#runFrom(run, control, 0).catch(error => {
      this.logger('error', 'run-loop', { pluginId: this.pluginId, runId: run.id, message: error.message });
    });
    return compact(run);
  }

  // Pause long Agent tasks between short capability calls so they do not hold a view RPC open.
  async resume(runId) {
    const run = this.records.get(runId);
    const control = this.active.get(runId);
    if (!run || !control || run.status !== 'waiting' || !run.pending) {
      throw fail('RUN_NOT_WAITING', `运行不在等待服务调用状态：${runId}`);
    }
    if (run.pending.kind !== 'service') {
      throw fail('RUN_MANUAL_WAIT', '人工节点需要逐步确认');
    }
    if (control.resuming) {
      return compact(run);
    }
    control.resuming = this.#resume(run, control);
    try {
      return await control.resuming;
    } finally {
      control.resuming = null;
    }
  }

  async #resume(run, control) {
    const runId = run.id;
    const { nodeId, request } = run.pending;
    const node = control.workflow.nodes.find(entry => entry.id === nodeId);
    const type = this.registry.get(node.type);
    const startedAt = run.nodes[nodeId].startedAt;
    if (!request.taskKey) {
      this.logger('info', 'run-resume', { pluginId: this.pluginId, runId, nodeId, type: node.type });
    }
    try {
      const result = await this.agents.run(request, { signal: control.controller.signal });
      if (control.canceled) {
        return compact(run);
      }
      if (result.state !== 'succeeded') {
        if (JSON.stringify(run.pending.task) !== JSON.stringify(result)) {
          run.pending.task = result;
          await this.#persist(run);
        }
        return compact(run);
      }
      control.outputs[nodeId] = type.after(result, request);
      run.nodes[nodeId] = { status: 'succeeded', startedAt, endedAt: this.now(), output: truncate(control.outputs[nodeId]), iteration: control.loopContext.iteration };
      run.pending = null;
      run.status = 'running';
      await this.#persist(run);
    } catch (error) {
      if (control.canceled) {
        return compact(run);
      }
      await this.#cancelAgent(run);
      if (control.canceled) {
        return compact(run);
      }
      const failure = { status: 'failed', startedAt, endedAt: this.now(),
        error: { code: error.code || 'NODE_FAILED', message: error.message } };
      run.nodes[nodeId] = failure;
      run.pending = null;
      run.error = { nodeId, ...failure.error };
      this.logger('error', 'node-failed', { pluginId: this.pluginId, runId, nodeId, code: failure.error.code });
      this.#skipRest(control.order, control.order.indexOf(node) + 1, run);
      run.status = 'failed';
      run.endedAt = this.now();
      await this.#persist(run);
      return compact(run);
    }
    control.task = this.#runFrom(run, control, control.order.indexOf(node) + 1);
    await control.task;
    return compact(run);
  }

  async respond(runId, input) {
    const run = this.records.get(runId);
    if (run?.status !== 'waiting' || run.pending?.kind !== 'service'
      || !run.pending.task?.requests?.some(request => request.id === input.requestId)) {
      throw fail('RUN_NOT_WAITING', '该 Agent 问题或审批已失效');
    }
    await this.agents.respond(run.pending.request, input);
    return compact(run);
  }

  async #cancelAgent(run) {
    if (run.pending?.kind === 'service') {
      const { nodeId, request } = run.pending;
      try {
        await this.agents.cancel?.(request);
      } catch (error) {
        // Provider failure must not prevent local run archival; the host owns instance cleanup.
        this.logger('error', 'agent-cancel-failed', { pluginId: this.pluginId, runId: run.id,
          nodeId, message: error.message });
      }
    }
  }

  // A failed confirmation leaves the same node waiting; it never marks downstream work complete.
  async complete(runId, nodeId, input) {
    const run = this.records.get(runId);
    const control = this.active.get(runId);
    if (!control || control.completing || control.canceled || run?.status !== 'waiting'
      || run.pending?.kind !== 'manual' || run.pending.nodeId !== nodeId) {
      throw fail('RUN_NOT_WAITING', '该节点不在等待人工确认状态');
    }
    control.completing = true;
    const node = control.workflow.nodes.find(entry => entry.id === nodeId);
    try {
      const output = await this.registry.get(node.type).confirm(input, { runId, nodeId });
      if (control.canceled) {
        throw fail('RUN_CANCELED', '运行已停止');
      }
      control.outputs[nodeId] = output;
      run.nodes[nodeId] = { ...run.nodes[nodeId], status: 'succeeded', endedAt: this.now(), output: truncate(output) };
      run.pending = null;
      run.status = 'running';
      await this.#persist(run);
      control.task = this.#runFrom(run, control, control.order.indexOf(node) + 1);
      await control.task;
      return compact(run);
    } finally {
      control.completing = false;
    }
  }

  #checkRoute(control, node, route, runId) {
    if (!control.workflow.edges.some(edge => edge.from === node.id && edge.branch === route)) {
      throw fail('ROUTE_NOT_FOUND', `节点 ${node.id} 没有配置分支：${route}`);
    }
    this.logger('info', 'node-route', { pluginId: this.pluginId, runId, nodeId: node.id, route });
  }

  #clearFrom(run, control, nodeId) {
    const affected = descendants(forwardEdges(control.workflow), nodeId);
    for (const id of affected) {
      if (run.nodes[id]) {
        run.history = [...(run.history || []), { nodeId: id, ...run.nodes[id] }].slice(-100);
      }
      delete control.outputs[id];
      delete run.nodes[id];
    }
    return affected;
  }

  #repeat(run, control, node) {
    const target = control.workflow.edges.find(edge => edge.from === node.id && edge.branch === 'continue').to;
    const round = control.loops[node.id];
    round.iteration += 1;
    const previous = structuredClone(control.outputs);
    const affected = this.#clearFrom(run, control, target);
    for (const id of affected) {
      if (id !== node.id) { delete control.loops[id]; }
    }
    control.loopContext = { iteration: round.iteration, previous };
    control.repeatTarget = target;
    run.iterations = { ...run.iterations, [node.id]: round.iteration };
    this.logger('info', 'loop-repeat', { pluginId: this.pluginId, runId: run.id, nodeId: node.id, iteration: round.iteration });
    return control.order.findIndex(entry => entry.id === target);
  }

  async decideLoop(runId, decision) {
    const run = this.records.get(runId);
    const control = this.active.get(runId);
    if (!control || control.completing || control.canceled || run?.status !== 'waiting' || run.pending?.kind !== 'loop') {
      throw fail('RUN_NOT_WAITING', '当前没有等待确认的循环');
    }
    if (!['continue', 'exit'].includes(decision)) {
      throw fail('INVALID_ARGUMENT', '请选择继续循环或退出循环');
    }
    control.completing = true;
    try {
      const node = control.workflow.nodes.find(entry => entry.id === run.pending.nodeId);
      let index = control.order.indexOf(node) + 1;
      if (decision === 'continue') {
        control.loops[node.id].budget = control.loops[node.id].iteration;
        index = this.#repeat(run, control, node);
      } else {
        control.outputs[node.id] = { route: 'exit' };
        run.nodes[node.id] = { ...run.nodes[node.id], status: 'succeeded', endedAt: this.now(), output: { route: 'exit' } };
      }
      run.pending = null;
      run.status = 'running';
      await this.#persist(run);
      control.task = this.#runFrom(run, control, index);
      await control.task;
      return compact(run);
    } finally {
      control.completing = false;
    }
  }

  async retry(runId) {
    const run = this.records.get(runId);
    const control = this.active.get(runId);
    const node = control?.workflow.nodes.find(entry => entry.id === run?.error?.nodeId);
    if (!control || control.completing || control.canceled || run.status !== 'failed'
      || !node || !(this.registry.get(node.type).service || isBranch(node.type))) {
      throw fail('RUN_NOT_RETRYABLE', '只允许显式重试失败的 Agent 或路由节点');
    }
    if (this.activeRun(run.workflowId)) {
      throw fail('RUN_BUSY', '该工作流已有其他运行，请先停止后重试');
    }
    // Failure skips describe unfinished work, unlike branches deliberately excluded by routing.
    for (const entry of control.order) {
      if (run.nodes[entry.id]?.reason === '上游节点未完成') {
        delete run.nodes[entry.id];
      }
    }
    this.#clearFrom(run, control, node.id);
    run.error = null;
    run.endedAt = null;
    run.status = 'running';
    control.task = this.#runFrom(run, control, control.order.indexOf(node));
    await control.task;
    return compact(run);
  }

  async rewind(runId, nodeId) {
    const run = this.records.get(runId);
    const control = this.active.get(runId);
    if (!control || control.completing || control.canceled || run?.pending?.kind !== 'manual') {
      throw fail('RUN_NOT_WAITING', '只允许在人工等待时重新编辑');
    }
    const index = control.order.findIndex(node => node.id === nodeId);
    if (index < 0) {
      throw fail('NODE_NOT_FOUND', '找不到重新编辑节点');
    }
    for (const node of control.order.slice(index)) {
      delete control.outputs[node.id];
      delete run.nodes[node.id];
    }
    run.pending = null;
    run.status = 'running';
    control.task = this.#runFrom(run, control, index);
    await control.task;
    return compact(run);
  }

  async cancel(runId) {
    const control = this.active.get(runId);
    if (!control) {
      return false;
    }
    control.canceled = true;
    control.controller.abort();
    const run = this.records.get(runId);
    await this.#cancelAgent(run);
    if (run?.pending?.kind === 'manual') {
      const node = control.workflow.nodes.find(entry => entry.id === run.pending.nodeId);
      await this.registry.get(node.type).cancel?.({ runId });
    }
    // A paused run has no loop to notice the flag, so it is finalized here.
    if (run && run.status === 'waiting') {
      const index = control.order.findIndex(entry => entry.id === run.pending.nodeId);
      this.#skipRest(control.order, index, run);
      run.pending = null;
      run.status = 'canceled';
      run.endedAt = this.now();
      run.error = { code: 'RUN_CANCELED', message: '运行已停止' };
      await this.#persist(run);
    }
    this.logger('info', 'run-cancel', { pluginId: this.pluginId, runId });
    return true;
  }

  // Start nodes own the entry; flows saved before they existed fall back to nodes without a parent.
  #reachable(workflow, entryNodeId) {
    const starts = workflow.nodes.filter(node => this.registry.role(node.type) === 'start').map(node => node.id);
    const roots = entryNodeId ? [entryNodeId] : starts.length ? starts
      : workflow.nodes.filter(node => !workflow.edges.some(edge => edge.to === node.id)).map(node => node.id);
    const seen = new Set(roots);
    const queue = [...roots];
    while (queue.length) {
      const nodeId = queue.shift();
      for (const edge of workflow.edges) {
        if (edge.from === nodeId && !seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    return seen;
  }

  activeRun(workflowId) {
    return [...this.records.values()].some(run => run.workflowId === workflowId && ['running', 'waiting'].includes(run.status));
  }

  get(runId) {
    const run = this.records.get(runId);
    if (!run) {
      throw fail('RUN_NOT_FOUND', `未找到运行记录：${runId}`);
    }
    return compact(run);
  }

  snapshot() {
    return [...this.records.values()].filter(run => ['running', 'waiting'].includes(run.status))
      .map(run => ({ id: run.id, name: `${run.workflowName} · ${new Date(run.startedAt).toLocaleTimeString('zh-CN')}` }));
  }

  async stop(reason) {
    for (const run of this.records.values()) {
      if (run.pending?.kind === 'manual') {
        await this.cancel(run.id);
      }
    }
    const tasks = [...this.active.values()].map(control => {
      control.canceled = true;
      control.controller.abort();
      return Promise.all([control.task, control.resuming]);
    });
    for (const run of this.records.values()) {
      await this.#cancelAgent(run);
    }
    for (const task of tasks) {
      await task;
    }
    for (const run of this.records.values()) {
      if (!['running', 'waiting'].includes(run.status)) {
        continue;
      }
      // A paused run never reached its remaining nodes, so they are archived as skipped too.
      if (run.pending) {
        const control = this.active.get(run.id);
        this.#skipRest(control.order, control.order.findIndex(entry => entry.id === run.pending.nodeId), run);
      }
      run.pending = null;
      run.status = 'canceled';
      run.endedAt = this.now();
      run.error = { code: 'PLUGIN_STOPPED', message: `插件已停止：${reason}` };
      await this.runs.append(run);
    }
    this.logger('info', 'stop', { pluginId: this.pluginId, reason, runs: this.records.size });
  }

  async #runFrom(run, control, startIndex) {
    const { workflow, order, outputs } = control;
    let index = startIndex;
    for (; index < order.length; index += 1) {
      if (control.canceled) {
        break;
      }
      const node = order[index];
      // Re-entry clears only descendants of the return target; other completed branches must not run twice.
      if (['succeeded', 'skipped'].includes(run.nodes[node.id]?.status)) {
        continue;
      }
      const blocked = this.#blockedBy(workflow, node, outputs, run, control);
      if (blocked) {
        run.nodes[node.id] = { status: 'skipped', startedAt: this.now(), endedAt: this.now(), reason: `未激活的流程路径：${blocked}` };
        await this.#persist(run);
        continue;
      }
      run.nodes[node.id] = { status: 'running', startedAt: this.now(), endedAt: null, iteration: control.loopContext.iteration };
      await this.#persist(run);
      try {
        const outcome = await this.#runNode({ workflow, node, run, outputs, control });
        // Stop may arrive while persistence or prepare is awaited; never publish a new waiting state afterwards.
        if (control.canceled) {
          break;
        }
        if (outcome.pending) {
          run.nodes[node.id] = { ...run.nodes[node.id], status: 'waiting' };
          run.status = 'waiting';
          run.pending = { nodeId: node.id, kind: this.registry.get(node.type).manual ? 'manual' : 'service', request: outcome.pending };
          await this.#persist(run);
          return;
        }
        outputs[node.id] = outcome.output;
        if (isBranch(node.type)) {
          this.#checkRoute(control, node, outcome.output.route, run.id);
        }
        run.nodes[node.id] = { status: 'succeeded', startedAt: run.nodes[node.id].startedAt, endedAt: this.now(),
          output: truncate(outcome.output), iteration: control.loopContext.iteration };
        if (node.type === 'flow.loop' && outcome.output.route === 'continue') {
          const round = control.loops[node.id] || { iteration: 1, budget: 0 };
          control.loops[node.id] = round;
          run.iterations = { ...run.iterations, [node.id]: round.iteration };
          if (round.iteration - round.budget >= Number(node.params.maxIterations ?? 3)) {
            run.status = 'waiting';
            run.nodes[node.id].status = 'waiting';
            run.pending = { nodeId: node.id, kind: 'loop' };
            await this.#persist(run);
            return;
          }
          index = this.#repeat(run, control, node) - 1;
        } else if (node.type === 'flow.loop') {
          run.iterations = { ...run.iterations, [node.id]: control.loops[node.id]?.iteration || 1 };
        }
      } catch (error) {
        // A node broken by our own cancellation (a socket torn down on stop) is not an execution error.
        const failure = control.canceled
          ? { status: 'canceled', startedAt: run.nodes[node.id].startedAt, endedAt: this.now(), reason: '运行已停止' }
          : { status: 'failed', startedAt: run.nodes[node.id].startedAt, endedAt: this.now(),
            error: { code: error.code || 'NODE_FAILED', message: error.message } };
        run.nodes[node.id] = failure;
        run.error = control.canceled ? { code: 'RUN_CANCELED', message: '运行已停止' } : { nodeId: node.id, ...failure.error };
        if (failure.error) {
          this.logger('error', 'node-failed', { pluginId: this.pluginId, runId: run.id, nodeId: node.id, code: failure.error.code });
        }
        this.#skipRest(order, index + 1, run);
        run.status = control.canceled ? 'canceled' : 'failed';
        run.endedAt = this.now();
        await this.#persist(run);
        return;
      }
      await this.#persist(run);
    }
    if (control.canceled) {
      this.#skipRest(order, index, run);
      run.status = 'canceled';
      run.error = { code: 'RUN_CANCELED', message: '运行已停止' };
    } else {
      run.status = 'succeeded';
    }
    run.endedAt = this.now();
    await this.#persist(run);
  }

  async #runNode({ workflow, node, run, outputs, control }) {
    const type = this.registry.get(node.type);
    const variables = { ...outputs, loop: control.loopContext };
    const defaults = withDefaults(type, node.params);
    const params = resolveParams(defaults, variables);
    // Mapping JSON is parsed before interpolation so quotes and structured values stay intact.
    for (const spec of type.params || []) {
      if (spec.templated === false) { params[spec.name] = defaults[spec.name]; }
    }
    const context = { variables, message: control.message, runId: run.id, nodeId: node.id, params, timeoutMs: type.timeoutMs, shouldStop: () => control.canceled,
      parents: parentsOf(workflow, node.id).filter(id => run.nodes[id]?.status === 'succeeded')
        .map(id => ({ nodeId: id, output: outputs[id] })),
      value: name => resolveValue(name in params ? params[name] : '', variables),
      credential: id => this.credentials.secret(id) };
    this.logger('info', 'node-start', { pluginId: this.pluginId, runId: run.id, nodeId: node.id, type: node.type });
    // A service node only prepares its request here; the caller-owned resume performs the call.
    return type.service || type.manual ? { pending: await withTimeout(type.timeoutMs, type.prepare(context)) }
      : { output: await withTimeout(type.timeoutMs, type.resolve(context)) };
  }

  #blockedBy(workflow, node, outputs, run, control) {
    if (control.branching) {
      if (control.repeatTarget === node.id) {
        control.repeatTarget = null;
        return null;
      }
      const incoming = forwardEdges(workflow).filter(edge => edge.to === node.id);
      return incoming.length && !incoming.some(edge => run.nodes[edge.from]?.status === 'succeeded'
        && (!isBranch(workflow.nodes.find(source => source.id === edge.from).type) || outputs[edge.from]?.route === edge.branch)
        && !(this.registry.isGate(workflow.nodes.find(source => source.id === edge.from).type) && outputs[edge.from]?.passed === false))
        ? node.id : null;
    }
    for (const ancestor of ancestors(workflow, node.id)) {
      const source = workflow.nodes.find(entry => entry.id === ancestor);
      if (source && this.registry.isGate(source.type) && outputs[ancestor]?.passed === false) {
        return ancestor;
      }
    }
    return null;
  }

  #skipRest(order, index, run) {
    for (const node of order.slice(index)) {
      if (['succeeded', 'skipped'].includes(run.nodes[node.id]?.status)) {
        continue;
      }
      run.nodes[node.id] = { status: 'skipped', startedAt: this.now(), endedAt: this.now(), reason: '上游节点未完成' };
    }
  }

  async #persist(run) {
    await this.runs.append(run);
    this.emit('runs.changed', compact(run));
  }
}

function withTimeout(timeoutMs, promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('NODE_TIMEOUT',
      `节点执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function withDefaults(type, params) {
  const merged = { ...params };
  for (const spec of type.params || []) {
    if (merged[spec.name] === undefined || merged[spec.name] === '') {
      merged[spec.name] = spec.default;
    }
  }
  return merged;
}

function parentsOf(workflow, nodeId) {
  return workflow.edges.filter(edge => edge.to === nodeId).map(edge => edge.from);
}

function ancestors(workflow, nodeId) {
  const collected = new Set();
  const queue = parentsOf(workflow, nodeId);
  while (queue.length) {
    const current = queue.pop();
    if (collected.has(current)) {
      continue;
    }
    collected.add(current);
    queue.push(...parentsOf(workflow, current));
  }
  return [...collected];
}

function truncate(output) {
  if (typeof output === 'string') {
    return output.length > MAX_TEXT ? `${output.slice(0, MAX_TEXT)}…（已截断，共 ${output.length} 字符）` : output;
  }
  if (Array.isArray(output)) {
    return output.map(truncate);
  }
  if (output && typeof output === 'object') {
    return Object.fromEntries(Object.entries(output).map(([name, entry]) => [name, truncate(entry)]));
  }
  return output;
}

function compact(run) {
  return { id: run.id, ...(run.origin ? { origin: run.origin, input: run.input } : {}), workflowId: run.workflowId, workflowName: run.workflowName, status: run.status,
    startedAt: run.startedAt, endedAt: run.endedAt, error: run.error, pending: run.pending ? { nodeId: run.pending.nodeId,
      kind: run.pending.kind || 'service', ...(run.pending.request?.mode ? { mode: run.pending.request.mode } : {}),
      stage: run.pending.request?.stage, task: run.pending.task } : null, iterations: run.iterations, history: run.history, nodes: { ...run.nodes } };
}
