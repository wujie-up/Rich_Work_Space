import { randomUUID } from 'node:crypto';
import { isMessageType } from './message-input.js';
import { normalizedMessage } from './message-receiver.js';
import { executionOrder, forwardEdges, descendants, isBranch } from './control-flow.js';
import { questionBatch, manualQuestions, answerQuestion } from './interaction-questions.js';
import { parallelGroup } from './parallel-flow.js';
import { loopPause } from './loop-limits.js';
import { fail } from './errors.js';
import { resolveParams, value as resolveValue } from './template.js';

const MAX_TEXT = 4000;

// Runs execute asynchronously behind the RPC boundary; every transition is persisted and emitted.
export class Engine {
  constructor({ registry, runs, credentials, agents, emit, logger, pluginId, hostMessages = false, now = () => Date.now() }) {
    Object.assign(this, { registry, runs, credentials, agents, emit, logger, pluginId, hostMessages, now });
    this.active = new Map();
    this.records = new Map();
  }

  types() {
    return this.registry.list();
  }

  async start(workflow, { runId, entryNodeId, message } = {}) {
    if (this.activeRun(workflow.id)) { throw fail('RUN_BUSY', '该工作流已有运行，请先停止后再触发'); }
    workflow = structuredClone(workflow);
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
      hostMessages: this.hostMessages, startedAt: this.now(), endedAt: null, error: null, nodes: {} };
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

  // Restore snapshots without starting external work; only an explicit continue may execute again.
  async restore(workflowId) {
    for (const stored of await this.runs.list(workflowId, { checkpoints: true })) {
      const { checkpoint, ...run } = stored;
      if (this.records.has(run.id)) { continue; }
      this.records.set(run.id, run);
      if (checkpoint?.version !== 1) {
        run.resumable = false;
        if (['running', 'waiting'].includes(run.status)) {
          run.status = 'interrupted';
          run.error = { code: 'RUN_INTERRUPTED', message: '旧版本未保存续跑数据，请重新运行；历史结果已保留' };
          run.endedAt = this.now();
          await this.runs.append(run);
        }
        continue;
      }
      const workflow = checkpoint.workflow;
      const control = { ...checkpoint, workflow, order: checkpoint.orderIds.map(id => workflow.nodes.find(node => node.id === id)),
        message: run.input, canceled: true, interrupted: true, controller: new AbortController(),
        branching: workflow.nodes.some(node => isBranch(node.type)) };
      delete control.version;
      delete control.orderIds;
      this.active.set(run.id, control);
      if (['running', 'waiting'].includes(run.status)) {
        run.status = 'interrupted';
        run.error = { code: 'RUN_INTERRUPTED', message: '插件已重启，可从中断节点继续' };
        run.endedAt = this.now();
      }
      this.#recoverService(run.pending || control.suspendedPending);
      await this.#persist(run);
    }
  }

  #recoverService(pending) {
    if (pending?.kind !== 'service') { return; }
    const focus = pending.parallel?.entries.find(entry => entry.nodeId === pending.focusNodeId)
      || pending.parallel?.entries.find(entry => entry.request?.taskKey && entry.request.taskKey === pending.request?.taskKey);
    if (focus) {
      pending.request = focus.request;
      pending.answeredRequests = focus.answeredRequests;
    }
    const requests = pending.parallel?.entries.filter(entry => entry.request).map(entry => entry.request) || [pending.request];
    for (const request of requests) {
      delete request.taskKey;
      delete request.sessionId;
      delete request.runId;
    }
    pending.restarted = true;
    pending.task = null;
  }

  async interrupt(runId) {
    const run = this.records.get(runId);
    const control = this.active.get(runId);
    if (!control || !['running', 'waiting'].includes(run?.status)) {
      throw fail('RUN_NOT_WAITING', '当前运行不能中断');
    }
    control.canceled = true;
    control.interrupted = true;
    control.controller.abort();
    run.status = 'interrupted';
    run.endedAt = this.now();
    run.error = { code: 'RUN_INTERRUPTED', message: '已保存进度，点击继续完成当前节点' };
    this.logger('info', 'run-interrupted', { runId, workflowId: run.workflowId, nodeId: run.pending?.nodeId });
    await this.#persist(run);
    return compact(run);
  }

  async continue(runId) {
    const run = this.records.get(runId);
    const previous = this.active.get(runId);
    if (!previous || previous.completing || !run.resumable || !['interrupted', 'failed', 'canceled'].includes(run.status)) {
      throw fail('RUN_NOT_CONTINUABLE', '该运行没有可恢复的进度');
    }
    if (this.activeRun(run.workflowId)) { throw fail('RUN_BUSY', '该工作流已有其他运行，请先停止后继续'); }
    // An aborted call may still settle late; it must finish before the same run object is reused.
    previous.completing = true;
    try {
      await Promise.allSettled([previous.task, previous.resuming]);
      if (this.activeRun(run.workflowId)) { throw fail('RUN_BUSY', '该工作流已有其他运行，请先停止后继续'); }
    } finally {
      previous.completing = false;
    }
    const control = { ...previous, canceled: false, interrupted: false, controller: new AbortController(),
      resuming: null, completing: false, answering: false, task: null };
    this.active.set(runId, control);
    run.pending ||= control.suspendedPending;
    delete control.suspendedPending;
    for (const [id, state] of Object.entries(run.nodes)) {
      if (state.reason === '上游节点未完成' || ['failed', 'canceled', 'running'].includes(state.status)) { delete run.nodes[id]; }
    }
    run.error = null;
    run.endedAt = null;
    run.resumeCount = (run.resumeCount || 0) + 1;
    run.status = run.pending ? 'waiting' : 'running';
    if (run.pending) {
      run.nodes[run.pending.nodeId] = { ...run.nodes[run.pending.nodeId], status: 'waiting' };
    }
    this.logger('info', 'run-continue', { runId, workflowId: run.workflowId, nodeId: run.pending?.nodeId });
    await this.#persist(run);
    if (!run.pending) {
      control.task = this.#runFrom(run, control, 0).catch(error => {
        this.logger('error', 'run-loop', { runId, message: error.message });
      });
    }
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
    if (control.resuming || (run.pending.interaction && !run.pending.parallel)) {
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
    if (run.pending.parallel) { return this.#resumeParallel(run, control); }
    const runId = run.id;
    const { nodeId, request } = run.pending;
    const node = control.workflow.nodes.find(entry => entry.id === nodeId);
    const type = this.registry.get(node.type);
    const startedAt = run.nodes[nodeId].startedAt;
    if (!request.taskKey) {
      this.logger('info', 'run-resume', { pluginId: this.pluginId, runId, nodeId, type: node.type });
    }
    try {
      if (run.pending.restarted) { run.pending.answeredRequests = []; }
      const result = await this.agents.run(request, { signal: control.controller.signal, runId, nodeId,
        workflowId: run.workflowId, name: node.title });
      if (control.canceled) {
        return compact(run);
      }
      run.pending.restarted = false;
      if (result.binding) {
        run.sessions = [...(run.sessions || []).filter(binding => binding.sessionId !== result.binding.sessionId), result.binding];
      }
      if (result.state !== 'succeeded') {
        const question = result.requests?.find(entry => entry.method === 'item/tool/requestUserInput' && entry.params?.questions?.length
          && !(run.pending.answeredRequests || []).includes(entry.id));
        if (question && !run.pending.interaction) {
          run.pending.interaction = questionBatch(`${nodeId}:${request.taskKey}:${question.id}`, question.params.questions);
          run.pending.interaction.nativeRequestId = question.id;
        }
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

  async answer(runId, { batchId, questionId, text }) {
    const run = this.records.get(runId);
    const control = this.active.get(runId);
    const pending = run?.pending;
    if (!control || control.answering || control.canceled || run.status !== 'waiting' || pending?.interaction?.id !== batchId) {
      throw fail('QUESTION_EXPIRED', '该问题已失效，请刷新当前问题');
    }
    control.answering = true;
    try {
      const batch = structuredClone(pending.interaction);
      const complete = answerQuestion(batch, questionId, text);
      if (complete && pending.kind === 'service') {
        if (!pending.restarted) {
          await this.agents.respond(pending.request, { requestId: batch.nativeRequestId, answers: batch.answers });
        }
        // Confirmed answers also travel with a restarted provider, whose native request IDs have expired.
        const answers = batch.questions.map(question => `${question.question}\n${batch.answers[question.id]}`).join('\n\n');
        pending.request.prompt += `\n\n用户已确认的补充信息：\n${answers}`;
        if (control.canceled || run.pending !== pending) { return compact(run); }
        (pending.answeredRequests ||= []).push(batch.nativeRequestId);
        pending.interaction = null;
      } else if (complete) {
        const answer = batch.questions.map(question => batch.questions.length === 1 ? batch.answers[question.id]
          : `${question.question}\n${batch.answers[question.id]}`).join('\n\n');
        await this.complete(runId, pending.nodeId, { requestId: pending.request.form.id, text: answer });
      } else {
        pending.interaction = batch;
      }
      await this.#persist(run);
      return compact(run);
    } finally {
      control.answering = false;
    }
  }

  async #cancelAgent(run) {
    if (run.pending?.kind === 'service') {
      const entries = run.pending.parallel?.entries.filter(entry => run.nodes[entry.nodeId]?.status !== 'succeeded')
        || [{ nodeId: run.pending.nodeId, request: run.pending.request }];
      await Promise.all(entries.map(async ({ nodeId, request }) => {
        try {
          await this.agents.cancel?.(request);
        } catch (error) {
          // One provider failure must not leave the other parallel branches running.
          this.logger('error', 'agent-cancel-failed', { pluginId: this.pluginId, runId: run.id, nodeId, message: error.message });
        }
      }));
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
      const output = await this.registry.get(node.type).confirm(input, { runId, nodeId, request: run.pending.request });
      if (control.canceled) {
        throw fail('RUN_CANCELED', '运行已停止');
      }
      control.outputs[nodeId] = output;
      run.nodes[nodeId] = { ...run.nodes[nodeId], status: 'succeeded', endedAt: this.now(), output: truncate(output) };
      run.pending = null;
      run.status = 'running';
      this.logger('info', 'manual-confirmed', { pluginId: this.pluginId, runId, nodeId });
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
    round.completed = false;
    const previous = structuredClone(control.outputs);
    const affected = this.#clearFrom(run, control, target);
    const enclosing = descendants(forwardEdges(control.workflow), node.id);
    for (const id of affected) {
      if (id === node.id) { continue; }
      if (!control.workflow.nodes.some(entry => entry.id === id && Number(entry.params.maxTotalIterations))) {
        delete control.loops[id];
      } else if (control.loops[id] && !enclosing.has(id)) {
        // A successful branch can bypass its loop gate; an outer return still finishes that inner round.
        control.loops[id].completed = true;
      }
    }
    control.loopContext = { iteration: round.iteration, previous };
    control.repeatTarget = target;
    run.iterations = { ...run.iterations, [node.id]: round.iteration };
    this.logger('info', 'loop-repeat', { pluginId: this.pluginId, runId: run.id, nodeId: node.id, iteration: round.iteration });
    return control.order.findIndex(entry => entry.id === target);
  }

  #pauseLoop(run, node, round, pause) {
    run.status = 'waiting';
    run.nodes[node.id] = { ...run.nodes[node.id], status: 'waiting', iteration: round.iteration };
    run.iterations = { ...run.iterations, [node.id]: round.iteration };
    run.pending = { nodeId: node.id, kind: 'loop', ...pause };
    this.logger('info', 'loop-paused', { pluginId: this.pluginId, runId: run.id, nodeId: node.id,
      iteration: round.iteration, stagnantIterations: round.stagnantIterations || 0, reason: pause.reason });
  }

  // A parent loop or file correction may re-enter a completed inner loop without its own continue edge.
  #enterLoopBody(run, control, target) {
    const loops = control.workflow.nodes.filter(node => node.type === 'flow.loop' && Number(node.params.maxTotalIterations)
      && control.workflow.edges.some(edge => edge.from === node.id && edge.branch === 'continue' && edge.to === target));
    const exhausted = loops.find(node => control.loops[node.id]?.completed
      && control.loops[node.id].iteration >= Number(node.params.maxTotalIterations));
    if (exhausted) {
      this.#pauseLoop(run, exhausted, control.loops[exhausted.id], loopPause(exhausted.params, control.loops[exhausted.id]));
      return false;
    }
    for (const node of loops) {
      const round = control.loops[node.id] ||= { iteration: 1, budget: 0 };
      if (round.completed) {
        round.iteration += 1;
        round.completed = false;
      }
      control.loopContext.iteration = round.iteration;
      run.iterations = { ...run.iterations, [node.id]: round.iteration };
    }
    return true;
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
        // Check the persisted count as well as the UI flag so RPC calls and restored runs cannot bypass the hard cap.
        const total = Number(node.params.maxTotalIterations || 0);
        if (total && control.loops[node.id].iteration >= total) {
          throw fail('LOOP_TOTAL_LIMIT', `节点 ${node.title} 已达到总轮次上限 ${total}，不能追加轮次`);
        }
        control.loops[node.id].budget = control.loops[node.id].iteration;
        control.loops[node.id].stagnantIterations = 0;
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
      || !node || !(this.registry.get(node.type).service || isBranch(node.type) || node.type === 'flow.parallel')) {
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

  // File correction is explicit and only available at a saved pause, never during Agent execution.
  async reselectFile(runId, nodeId) {
    const run = this.records.get(runId);
    const previous = this.active.get(runId);
    if (!previous || previous.completing || previous.answering || !run.resumable
      || !(run.status === 'interrupted' || run.status === 'waiting' && ['manual', 'loop'].includes(run.pending?.kind))) {
      throw fail('RUN_NOT_PAUSED', '请先暂停流程，再重新选择文件');
    }
    const node = previous.workflow.nodes.find(entry => entry.id === nodeId);
    if (node?.type !== 'flow.user-input' || node.params.interaction !== 'file' || run.nodes[nodeId]?.status !== 'succeeded') {
      throw fail('RUN_FILE_NOT_EDITABLE', '只能重新选择已确认的文件输入节点');
    }
    if ([...this.records.values()].some(entry => entry.id !== runId && entry.workflowId === run.workflowId
      && ['running', 'waiting'].includes(entry.status))) {
      throw fail('RUN_BUSY', '该工作流已有其他运行，请先暂停后修改');
    }
    const affectedLoops = descendants(forwardEdges(previous.workflow), nodeId);
    const exhausted = previous.workflow.nodes.find(entry => affectedLoops.has(entry.id) && Number(entry.params.maxTotalIterations)
      && previous.loops[entry.id]?.iteration >= Number(entry.params.maxTotalIterations));
    if (exhausted) {
      throw fail('LOOP_TOTAL_LIMIT', `节点 ${exhausted.title} 已达到总轮次上限，请调整资料后新建运行`);
    }
    previous.completing = true;
    previous.canceled = true;
    previous.controller.abort();
    // Reserve the workflow while old calls settle so another start cannot overtake the rollback.
    run.status = 'running';
    try {
      await Promise.allSettled([previous.task, previous.resuming]);
      await this.#cancelAgent(run);
      if (run.status !== 'running') { return compact(run); }
      const control = { ...previous, canceled: false, interrupted: false, controller: new AbortController(),
        resuming: null, answering: false, task: null };
      this.active.set(runId, control);
      const affected = this.#clearFrom(run, control, nodeId);
      const resetLoop = [...affected].some(id => control.loops[id]);
      for (const id of affected) {
        if (!control.workflow.nodes.some(entry => entry.id === id && Number(entry.params.maxTotalIterations))) {
          delete control.loops[id];
          delete run.iterations?.[id];
        } else if (control.loops[id]) {
          control.loops[id].completed = true;
        }
        delete control.loopContext.previous[id];
      }
      if (resetLoop) { control.loopContext.iteration = 1; }
      if (affected.has(control.repeatTarget)) { delete control.repeatTarget; }
      delete control.suspendedPending;
      run.pending = null;
      run.error = null;
      run.endedAt = null;
      this.logger('info', 'run-file-reselected', { runId, workflowId: run.workflowId, nodeId, affected: affected.size });
      try {
        control.task = this.#runFrom(run, control, control.order.indexOf(node));
        await control.task;
        return compact(run);
      } finally {
        control.completing = false;
      }
    } finally {
      previous.completing = false;
    }
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
      if (Number(node.params.maxTotalIterations) && control.loops[node.id]) {
        control.loops[node.id].completed = true;
      }
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
    control.suspendedPending = structuredClone(run?.pending || null);
    this.#recoverService(control.suspendedPending);
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
      if (['running', 'waiting'].includes(run.status)) { await this.interrupt(run.id); }
      const control = this.active.get(run.id);
      if (control) {
        control.canceled = true;
        control.controller.abort();
        await this.#cancelAgent(run);
        this.#recoverService(run.pending || control.suspendedPending);
        await Promise.allSettled([control.task, control.resuming]);
        await this.#persist(run);
      }
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
      if (!this.#enterLoopBody(run, control, node.id)) {
        await this.#persist(run);
        return;
      }
      run.nodes[node.id] = { status: 'running', startedAt: this.now(), endedAt: null, iteration: control.loopContext.iteration };
      await this.#persist(run);
      if (control.canceled) { break; }
      try {
        const outcome = node.type === 'flow.parallel' ? await this.#prepareParallel(run, control, node)
          : await this.#runNode({ workflow, node, run, outputs, control });
        // Stop may arrive while persistence or prepare is awaited; never publish a new waiting state afterwards.
        if (control.canceled) {
          break;
        }
        if (outcome.pending) {
          run.nodes[node.id] = { ...run.nodes[node.id], status: 'waiting' };
          run.status = 'waiting';
          run.pending = { nodeId: node.id, kind: this.registry.get(node.type).manual ? 'manual' : 'service', request: outcome.pending, ...(outcome.parallel ? { parallel: outcome.parallel } : {}) };
          if (outcome.pending.form) { run.pending.interaction = manualQuestions(outcome.pending.form); }
          await this.#persist(run);
          return;
        }
        outputs[node.id] = outcome.output;
        if (isBranch(node.type)) {
          this.#checkRoute(control, node, outcome.output.route, run.id);
        }
        run.nodes[node.id] = { status: 'succeeded', startedAt: run.nodes[node.id].startedAt, endedAt: this.now(),
          output: truncate(outcome.output), iteration: control.loopContext.iteration };
        if (node.type === 'flow.loop' && control.loops[node.id]) {
          control.loops[node.id].completed = true;
        }
        if (node.type === 'flow.loop' && outcome.output.route === 'continue') {
          const round = control.loops[node.id] || { iteration: 1, budget: 0 };
          control.loops[node.id] = round;
          run.iterations = { ...run.iterations, [node.id]: round.iteration };
          const pause = loopPause(node.params, round, outcome.output.progress);
          if (pause) {
            this.#pauseLoop(run, node, round, pause);
            await this.#persist(run);
            return;
          }
          index = this.#repeat(run, control, node) - 1;
        } else if (node.type === 'flow.loop') {
          run.iterations = { ...run.iterations, [node.id]: control.loops[node.id]?.iteration || 1 };
        }
      } catch (error) {
        if (control.interrupted) { return; }
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
    if (control.interrupted) { return; }
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

  async #prepareParallel(run, control, node) {
    const { branches, join } = parallelGroup(control.workflow, node);
    const entries = [];
    // Preparation only builds requests; all provider calls start together in resume.
    for (const branch of branches) {
      if (run.nodes[branch.id]?.status === 'succeeded') {
        entries.push({ nodeId: branch.id });
        continue;
      }
      run.nodes[branch.id] = { status: 'waiting', startedAt: this.now(), endedAt: null, iteration: control.loopContext.iteration };
      const outcome = await this.#runNode({ workflow: control.workflow, node: branch, run, outputs: control.outputs, control });
      entries.push({ nodeId: branch.id, request: outcome.pending, answeredRequests: [] });
    }
    this.logger('info', 'parallel-start', { pluginId: this.pluginId, runId: run.id, nodeId: node.id, branches: branches.map(item => item.id) });
    return { pending: {}, parallel: { entries, joinNodeId: join.id } };
  }

  async #resumeParallel(run, control) {
    const pending = run.pending;
    // A question freezes its own branch; other running sessions still publish their latest status.
    const entries = pending.parallel.entries.filter(entry => run.nodes[entry.nodeId].status !== 'succeeded'
      && (!pending.interaction || (!pending.restarted && entry.nodeId !== pending.focusNodeId && !entry.task?.requests?.length)));
    if (!entries.length) { return compact(run); }
    const results = await Promise.allSettled(entries.map(async entry => {
        const node = control.workflow.nodes.find(item => item.id === entry.nodeId);
        if (pending.restarted) { entry.answeredRequests = []; }
        const result = await this.agents.run(entry.request, { signal: control.controller.signal, runId: run.id,
          nodeId: node.id, workflowId: run.workflowId, name: node.title });
        if (control.canceled) { return; }
        entry.task = result;
        if (result.binding) {
          run.sessions = [...(run.sessions || []).filter(binding => binding.sessionId !== result.binding.sessionId), result.binding];
        }
        if (result.state === 'succeeded') {
          const output = this.registry.get(node.type).after(result, entry.request);
          control.outputs[node.id] = output;
          run.nodes[node.id] = { ...run.nodes[node.id], status: 'succeeded', endedAt: this.now(), output: truncate(output) };
        }
        await this.#persist(run);
      }));
    if (control.canceled) { return compact(run); }
    pending.restarted = false;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      await this.#cancelAgent(run);
      if (control.canceled) { return compact(run); }
      run.error = { nodeId: pending.nodeId, code: failure.reason.code || 'NODE_FAILED', message: failure.reason.message };
      run.nodes[pending.nodeId] = { ...run.nodes[pending.nodeId], status: 'failed', endedAt: this.now(), error: run.error };
      this.#skipRest(control.order, control.order.findIndex(node => node.id === pending.nodeId) + 1, run);
      results.forEach((result, index) => {
        if (result.status !== 'rejected') { return; }
        const nodeId = entries[index].nodeId;
        run.nodes[nodeId] = { status: 'failed', startedAt: run.nodes[pending.nodeId].startedAt, endedAt: this.now(),
          iteration: control.loopContext.iteration, error: { code: result.reason.code || 'NODE_FAILED', message: result.reason.message } };
        this.logger('error', 'node-failed', { pluginId: this.pluginId, runId: run.id, nodeId, ...run.nodes[nodeId].error });
      });
      run.pending = null;
      run.status = 'failed';
      run.endedAt = this.now();
      this.logger('error', 'parallel-failed', { pluginId: this.pluginId, runId: run.id, ...run.error });
      await this.#persist(run);
      return compact(run);
    }
    if (pending.interaction) { return compact(run); }
    const unfinished = pending.parallel.entries.filter(entry => run.nodes[entry.nodeId].status !== 'succeeded');
    if (unfinished.length) {
      // Present one native question at a time while the other provider sessions remain alive.
      const unanswered = entry => entry.task?.requests?.some(request => !entry.answeredRequests.includes(request.id));
      const focus = unfinished.find(entry => entry.request === pending.request && unanswered(entry))
        || unfinished.find(unanswered) || unfinished[0];
      pending.focusNodeId = focus.nodeId;
      pending.request = focus.request;
      pending.task = focus.task;
      pending.answeredRequests = focus.answeredRequests;
      const question = focus.task?.requests?.find(entry => entry.method === 'item/tool/requestUserInput'
        && entry.params?.questions?.length && !focus.answeredRequests.includes(entry.id));
      if (question && !pending.interaction) {
        pending.interaction = questionBatch(`${focus.nodeId}:${focus.request.taskKey}:${question.id}`, question.params.questions);
        pending.interaction.nativeRequestId = question.id;
      }
      await this.#persist(run);
      return compact(run);
    }
    control.outputs[pending.nodeId] = { branches: pending.parallel.entries.map(entry => entry.nodeId) };
    run.nodes[pending.nodeId] = { ...run.nodes[pending.nodeId], status: 'succeeded', endedAt: this.now(),
      output: control.outputs[pending.nodeId] };
    run.pending = null;
    run.status = 'running';
    this.logger('info', 'parallel-complete', { pluginId: this.pluginId, runId: run.id, nodeId: pending.nodeId });
    await this.#persist(run);
    control.task = this.#runFrom(run, control, control.order.findIndex(node => node.id === pending.nodeId) + 1);
    await control.task;
    return compact(run);
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
    if (run.sessions?.length || !['running', 'waiting'].includes(run.status)) {
      const control = this.active.get(run.id);
      // Unfinished nodes include all possible loop returns; only proven unreachable bindings are released.
      const future = ['running', 'waiting', 'interrupted'].includes(run.status) ? control.workflow.nodes.filter(node =>
        !['succeeded', 'skipped'].includes(run.nodes[node.id]?.status)).map(node => node.id) : [];
      const reachable = new Set(future.flatMap(nodeId => [...descendants(control.workflow.edges, nodeId)]));
      try {
        const bindings = await this.agents.release?.(run.id, reachable);
        if (bindings?.length) {
          run.sessions = [...(run.sessions || []).filter(item => !bindings.some(binding => binding.sessionId === item.sessionId)), ...bindings];
        }
      } catch (error) {
        this.logger('error', 'agent-close-failed', { runId: run.id, sessions: run.sessions, message: error.message });
      }
    }
    const control = this.active.get(run.id);
    const resumable = control && run.status !== 'succeeded';
    run.resumable = Boolean(resumable);
    const checkpoint = resumable ? { version: 1, workflow: control.workflow, orderIds: control.order.map(node => node.id),
      outputs: control.outputs, loops: control.loops, loopContext: control.loopContext, repeatTarget: control.repeatTarget,
      suspendedPending: control.suspendedPending } : undefined;
    await this.runs.append({ ...run, checkpoint });
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
  return { id: run.id, resumable: run.resumable, resumeCount: run.resumeCount, hostMessages: run.hostMessages, ...(run.origin ? { origin: run.origin, input: run.input } : {}), workflowId: run.workflowId, workflowName: run.workflowName, status: run.status,
    startedAt: run.startedAt, endedAt: run.endedAt, error: run.error, pending: run.pending ? { nodeId: run.pending.nodeId,
      kind: run.pending.kind || 'service', ...(run.pending.request?.mode ? { mode: run.pending.request.mode } : {}),
      ...(run.pending.kind === 'loop' ? { reason: run.pending.reason, canContinue: run.pending.canContinue, message: run.pending.message } : {}),
      ...(run.pending.request?.form ? { form: run.pending.request.form } : {}),
      tasks: run.pending.parallel?.entries.filter(entry => run.nodes[entry.nodeId]?.status !== 'succeeded').map(entry => entry.task || { state: 'starting' }),
      interaction: run.pending.interaction, stage: run.pending.request?.stage, task: run.pending.task } : null, sessions: run.sessions || [], iterations: run.iterations, history: run.history, nodes: { ...run.nodes } };
}
