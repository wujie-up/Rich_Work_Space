import { randomUUID } from 'node:crypto';
import { isApprovalRequest } from '../../../shared/contracts.js';

const finished = task => ['completed', 'failed', 'cancelled', 'interrupted', 'uncertain'].includes(task.state);
const fail = message => { throw Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Bridge records belong to a stable caller plugin; live authority belongs only to its current runtime instance.
export class BridgeSessions {
  constructor(options) {
    Object.assign(this, options);
    this.now ||= Date.now;
    this.state = { bindings: {}, tasks: {} };
    this.leases = new Map();
    this.writes = Promise.resolve();
  }

  async load() {
    this.state = await this.storage.readJson(`plugin-data/${this.pluginId}/bridge-state.json`, this.state);
    await this.edit(state => {
      Object.values(state.bindings).filter(binding => binding.state !== 'released').forEach(binding => { binding.state = 'paused'; });
      Object.values(state.tasks).filter(task => !finished(task)).forEach(task => {
        task.state = task.state === 'submitting' ? 'uncertain' : 'interrupted';
        task.error = 'AI 插件已重启；旧请求不会重新提交';
      });
    });
  }

  // Publish only a successfully replaced snapshot; failed disk writes must never authorize native execution.
  edit(action) {
    const work = this.writes.then(async () => {
      const next = structuredClone(this.state);
      const result = await action(next);
      await this.storage.writeJson(`plugin-data/${this.pluginId}/bridge-state.json`, next);
      this.state = next;
      return structuredClone(result);
    });
    this.writes = work.catch(error => {
      console.error('[ai:bridge-persist]', { pluginId: this.pluginId, stack: error.stack });
    });
    return work;
  }

  owner(binding, context, mutate = false) {
    if (!binding || binding.callerPluginId !== context.caller?.pluginId) { fail('只能访问所属插件的桥接绑定 owner'); }
    const lease = this.leases.get(binding.bindingId);
    if (mutate && (!context.authorizationId || lease?.instanceId !== context.caller.instanceId)) { fail('桥接授权或运行实例 instance 已失效'); }
    return binding;
  }

  async catalog() {
    const conversations = this.conversations.list().filter(record => !record.archivedAt && !record.task?.background && !record.developmentId)
      .map(record => ({ targetRef: { kind: 'conversation', id: record.id }, name: record.name, engineId: record.engineId || 'codex',
        cwd: record.cwd, available: true, executionPolicy: record.task?.kind === 'plan' ? 'readOnly' : 'existing' }));
    const terminals = [...this.sessions.active.values()].map(session => ({ targetRef: { kind: 'terminal', id: session.restoredFrom || session.id },
      name: session.name, engineId: session.adapterId, cwd: session.cwd, available: false, reason: 'native_turn_correlation_unavailable' }));
    return { targets: conversations.concat(terminals) };
  }

  async bind(input, context) {
    // Persist the binding identity before creating a context, so retries can reconcile a successful context write.
    const intent = await this.edit(async state => {
      if (!context.authorizationId || this.stopped) { fail('需要当前实例的工作台授权'); }
      let binding = Object.values(state.bindings).find(item => item.callerPluginId === context.caller.pluginId
        && item.bindingKey === input.bindingKey && item.state !== 'released');
      const configuration = { sourceScope: input.sourceScope, target: input.target, executionPolicy: input.executionPolicy };
      if (binding && !same(binding.configuration, configuration)) { fail('binding_conflict：请先显式解绑再修改范围、目标或权限'); }
      const reused = Boolean(binding);
      if (!binding) {
        let targetRef = input.target.targetRef;
        if (input.target.mode === 'dedicated') {
          if (input.executionPolicy.mode !== 'readOnly') { fail('专属会话仅支持 readOnly policy'); }
        } else {
          const target = (await this.catalog()).targets.find(item => same(item.targetRef, targetRef));
          if (!target?.available) { fail('目标暂不支持可靠原生轮次桥接'); }
          if (target.executionPolicy === 'existing' && !(input.executionPolicy.mode === 'existing' && input.executionPolicy.accepted === true)) {
            fail('必须明确接受已有会话的实际权限 policy');
          }
        }
        binding = { bindingId: randomUUID(), bindingKey: input.bindingKey, configuration, callerPluginId: context.caller.pluginId,
          targetRef, ownership: input.target.mode, createdAt: this.now() };
        state.bindings[binding.bindingId] = binding;
      }
      binding.state = 'creating';
      return { ...binding, reused };
    });
    const binding = await this.edit(async state => {
      const current = state.bindings[intent.bindingId];
      if (this.stopped || current.state === 'released') { fail('绑定已关闭'); }
      if (!current.targetRef && current.ownership === 'dedicated') {
        let record = this.conversations.list().find(item => item.task?.bridgeBindingId === current.bindingId);
        record ||= await this.conversations.create({ cwd: input.target.cwd, engineId: input.target.engineId,
          task: { kind: 'plan', bridge: true, bridgeBindingId: current.bindingId } });
        current.targetRef = { kind: 'conversation', id: record.id };
      }
      current.state = 'active';
      return { ...current, reused: intent.reused };
    });
    this.leases.set(binding.bindingId, { instanceId: context.caller.instanceId, touchedAt: this.now() });
    return binding;
  }

  async submit(input, context) {
    return this.edit(state => {
      const binding = this.owner(state.bindings[input.bindingId], context, true);
      if (this.stopped || binding.state !== 'active') { fail('绑定已暂停或释放'); }
      const duplicate = Object.values(state.tasks).find(task => task.callerPluginId === context.caller.pluginId && task.requestKey === input.requestKey);
      if (duplicate) {
        if (duplicate.bindingId !== input.bindingId || duplicate.sourceMessageKey !== input.sourceMessageKey || duplicate.text !== input.text) {
          fail('request_conflict：同一请求不能改变绑定或内容');
        }
        return this.publicTask(duplicate);
      }
      const queued = Object.values(state.tasks).filter(task => task.targetId === binding.targetRef.id && !finished(task));
      if (queued.length >= 20) { fail('会话队列已满'); }
      const task = { ...input, taskId: randomUUID(), callerPluginId: context.caller.pluginId, targetId: binding.targetRef.id,
        state: 'queued', createdAt: this.now() };
      state.tasks[task.taskId] = task;
      return this.publicTask(task);
    });
  }

  task(input, context) {
    const task = input.taskId ? this.state.tasks[input.taskId] : Object.values(this.state.tasks).find(item => item.requestKey === input.requestKey
      && item.bindingId === input.bindingId);
    if (!task) { fail('请求不存在'); }
    this.owner(this.state.bindings[task.bindingId], context);
    return task;
  }

  publicTask(task) {
    const { text, callerPluginId, eventStartSequence, targetId, sourceMessageKey, ...value } = task;
    return structuredClone(value);
  }

  async read(input, context) {
    const task = this.task(input, context);
    const lease = this.leases.get(task.bindingId);
    if (context.authorizationId && lease?.instanceId === context.caller.instanceId) { lease.touchedAt = this.now(); }
    await this.update(task.taskId);
    return this.publicTask(this.state.tasks[task.taskId]);
  }

  async update(taskId) {
    const task = this.state.tasks[taskId];
    if (!task.turnId || finished(task) || task.closed) { return; }
    const record = await this.conversations.read(task.targetId);
    // Only correlated native events can leave this session; local answer acknowledgments carry only the native request ID.
    const events = record.events.filter(event => event.sequence > task.eventStartSequence && (event.method === 'approval/answered'
      || event.params?.threadId === task.threadId && (event.params.turnId || event.params.turn?.id) === task.turnId));
    const answered = new Set(events.filter(event => event.method === 'approval/answered').map(event => event.params.requestId));
    const requests = events.filter(event => event.id !== undefined && !answered.has(event.id));
    const completion = events.find(event => event.method === 'turn/completed' && event.params.turn.id === task.turnId);
    await this.edit(state => {
      const current = state.tasks[taskId];
      if (current.closed) { return; }
      current.questions = requests.filter(event => event.method === 'item/tool/requestUserInput')
        .map(event => ({ requestId: event.id, questions: event.params.questions }));
      current.localApproval = requests.some(isApprovalRequest);
      if (completion) {
        const messages = events.filter(event => event.method === 'item/completed' && event.params.item?.type === 'agentMessage')
          .map(event => event.params.item);
        for (const item of completion.params.turn.items || []) {
          if (item.type === 'agentMessage' && !messages.some(message => message.id && message.id === item.id)) { messages.push(item); }
        }
        const final = messages.filter(item => item.phase === 'final_answer');
        current.state = completion.params.turn.status === 'completed' ? 'completed' : 'failed';
        current.output = (final.length ? final : messages.filter(item => !item.phase)).map(item => item.text || '').join('\n');
        current.completedAt = this.now();
        current.questions = [];
        current.localApproval = false;
      } else if (['failed', 'cancelled', 'interrupted'].includes(record.state)) {
        current.state = 'interrupted';
        current.error = '原生会话已中断';
      } else {
        current.state = current.questions.length || current.localApproval ? 'waiting_input' : 'running';
        if (current.state === 'waiting_input') { current.waitingAt ||= this.now(); }
        else { delete current.waitingAt; }
      }
    });
  }

  queueReason(binding) {
    const id = binding.targetRef.id;
    const record = this.conversations.records.get(id);
    if (!record || record.archivedAt) { return 'target_unavailable'; }
    if (this.conversations.stopped || this.conversations.locks.has(id) || record.state === 'running') { return 'busy'; }
    return this.composerReason(binding);
  }

  composerReason(binding) {
    const open = [...this.conversations.composers.values()].some(view => view.conversationId === binding.targetRef.id && !view.detached);
    return binding.ownership === 'existing' || open ? this.conversations.composerReason(binding.targetRef.id) : null;
  }

  pump() {
    if (this.pumping) { return this.pumping; }
    this.pumping = this.pumpOnce().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  async pumpOnce() {
    if (this.stopped) { return; }
    for (const binding of Object.values(this.state.bindings).filter(item => item.state === 'active')) {
      const lease = this.leases.get(binding.bindingId);
      if (!lease || this.now() - lease.touchedAt > 60000) {
        await this.closeBinding(binding, 'lease_expired');
      }
    }
    for (const snapshot of Object.values(this.state.tasks).filter(task => !finished(task))) {
      const binding = this.state.bindings[snapshot.bindingId];
      if (binding.state !== 'active') { continue; }
      await this.update(snapshot.taskId);
      const task = this.state.tasks[snapshot.taskId];
      if (finished(task)) { continue; }
      if (this.now() - (task.startedAt || task.createdAt) > (task.state === 'queued' ? 600000 : 1800000)
        || task.waitingAt && this.now() - task.waitingAt > 600000) {
        await this.closeTask(task, 'timeout', binding.ownership === 'dedicated');
        continue;
      }
      if (task.state !== 'queued') { continue; }
      const blocked = this.queueReason(binding) || (Object.values(this.state.tasks).some(other => other.taskId !== task.taskId
        && other.targetId === task.targetId && ['submitting', 'running', 'waiting_input'].includes(other.state)) ? 'busy' : null);
      if (blocked) {
        if (task.queueReason !== blocked) { await this.edit(state => { state.tasks[task.taskId].queueReason = blocked; }); }
        continue;
      }
      await this.startTask(task, binding);
    }
  }

  async startTask(task, binding) {
    try {
      await this.conversations.send(task.targetId, task.text, {
        beforeStart: () => {
          const current = this.state.bindings[binding.bindingId];
          if (this.stopped || current.state !== 'active' || this.composerReason(binding)) {
            throw Object.assign(Error('会话输入状态已改变'), { code: 'BRIDGE_BLOCKED' });
          }
        },
        ready: async record => {
          await this.edit(state => {
            Object.assign(state.tasks[task.taskId], { state: 'submitting', threadId: record.threadId,
              eventStartSequence: record.events.length, startedAt: this.now(), queueReason: null });
          });
        },
        turnStarted: turn => this.edit(state => { Object.assign(state.tasks[task.taskId], { turnId: turn.id, state: 'running' }); })
      });
      console.info('[ai:bridge-submitted]', { pluginId: this.pluginId, bindingId: binding.bindingId, taskId: task.taskId });
      await this.update(task.taskId);
    } catch (error) {
      await this.edit(state => {
        const current = state.tasks[task.taskId];
        current.state = error.code === 'BRIDGE_BLOCKED' ? 'queued' : current.state === 'submitting' ? 'uncertain' : 'failed';
        current.error = error.code === 'BRIDGE_BLOCKED' ? undefined : '原生提交失败，请在 AI 会话检查，勿自动重试';
      });
      console.error('[ai:bridge-submit-failed]', { pluginId: this.pluginId, taskId: task.taskId, bindingId: binding.bindingId, stack: error.stack });
    }
  }

  async respond(input, context) {
    const task = this.task(input, context);
    this.owner(this.state.bindings[task.bindingId], context, true);
    await this.update(task.taskId);
    const current = this.state.tasks[task.taskId];
    const question = current.questions?.find(item => item.requestId === input.requestId);
    if (finished(current) || current.closed || !question) { fail('问题已失效；权限请求必须在本地 local 处理'); }
    if (input.decision !== undefined) { fail('权限审批必须在本地 local 处理'); }
    this.conversations.answer(task.targetId, input.requestId, input.answers);
    await this.update(task.taskId);
    return { accepted: true };
  }

  async closeTask(task, reason, interrupt) {
    await this.edit(state => {
      const current = state.tasks[task.taskId];
      Object.assign(current, { closed: true, closedAt: this.now(), closeReason: reason });
      if (!finished(current)) { current.state = 'cancelled'; }
      delete current.output;
      current.questions = [];
    });
    // Existing local work survives bridge shutdown; only a matching externally owned turn may be interrupted.
    if (interrupt && task.turnId && this.conversations.records.get(task.targetId)?.turnId === task.turnId) {
      await this.conversations.cancel(task.targetId);
    }
  }

  async cancel(input, context) {
    const task = this.task(input, context);
    this.owner(this.state.bindings[task.bindingId], context, true);
    await this.closeTask(task, 'cancelled', true);
    return this.publicTask(this.state.tasks[task.taskId]);
  }

  async closeBinding(binding, reason, released = false) {
    await this.edit(state => { state.bindings[binding.bindingId].state = released ? 'released' : 'paused'; });
    for (const task of Object.values(this.state.tasks).filter(item => item.bindingId === binding.bindingId && !item.closed)) {
      await this.closeTask(task, reason, binding.ownership === 'dedicated');
    }
    return { bindingId: binding.bindingId, state: released ? 'released' : 'paused' };
  }

  suspend(input, context) { return this.closeBinding(this.owner(this.state.bindings[input.bindingId], context, true), 'suspended'); }
  unbind(input, context) { return this.closeBinding(this.owner(this.state.bindings[input.bindingId], context, true), 'released', true); }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pumping;
    for (const binding of Object.values(this.state.bindings).filter(item => item.state === 'active')) { await this.closeBinding(binding, 'plugin_stopped'); }
    await this.writes;
  }

  start() {
    this.timer = setInterval(() => this.pump().catch(error => {
      console.error('[ai:bridge-pump]', { pluginId: this.pluginId, stack: error.stack });
    }), 1000);
    this.timer.unref();
  }
}
