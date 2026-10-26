import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const finished = state => ['passed', 'incomplete', 'failed', 'cancelled'].includes(state);

// Coordinate through public workbench capabilities; no imports from the AI plugin or system Agent environment.
export class McpDebug {
  constructor(context, services) {
    Object.assign(this, { context, services });
    this.sessions = new Map();
  }

  start(input, prompt = '') {
    if (typeof prompt !== 'string' || prompt.length > 80000) { throw Error('调试目标最多 80000 字符'); }
    if ([...this.sessions.values()].some(session => !session.cleaned)) { throw Error('请先结束当前调试'); }
    this.sessions.clear();
    const id = randomUUID();
    const session = { id, serviceId: `debug-${id}`, taskKey: randomBytes(32).toString('hex'), controller: new AbortController(),
      state: 'starting', stage: '准备当前代码和配置', evidence: { discovered: 0, calls: [] }, cleaned: false };
    this.sessions.set(id, session);
    session.work = this.run(session, structuredClone(input), prompt);
    return { id };
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) { throw Error('调试已结束或插件已重启'); }
    return session;
  }

  read(id) {
    const { state, stage, evidence, output, error, requests, cleaned } = this.get(id);
    return structuredClone({ state, stage, evidence, output, error, requests, cleaned });
  }

  async invoke(session, capabilityId, input, signal = session.controller.signal) {
    signal?.throwIfAborted();
    const catalog = await this.context.capabilities.discover();
    const providers = catalog.providers.filter(item => item.state === 'ready' && item.descriptor.id === capabilityId
      && (!session.providerId || item.handle.pluginId === session.providerId));
    if (providers.length !== 1) { throw Error(providers.length ? '存在多个 AI 提供方，请只启用一个后重试' : '请启用支持 MCP 调试的 AI Agent 插件'); }
    session.providerId = providers[0].handle.pluginId;
    signal?.throwIfAborted();
    // Once submitted, cancellation must cover a task even if its start response is lost.
    if (capabilityId === 'agent.mcp.debug.start.v1') { session.taskStarted = true; }
    const invocation = await this.context.capabilities.invoke(providers[0].handle, input, {});
    try {
      const deadline = Date.now() + 28000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const result = await this.context.capabilities.getInvocation(invocation.invocationId);
        if (result.state === 'succeeded') { return result.result; }
        if (['failed', 'cancelled', 'interrupted'].includes(result.state)) { throw Error(result.error?.message || 'AI 能力调用失败'); }
        await delay(150, undefined, signal ? { signal } : {});
      }
      throw Error('等待 AI 能力超时，请检查工作台审批');
    } catch (error) {
      await this.context.capabilities.cancel(invocation.invocationId);
      throw error;
    }
  }

  async run(session, input, prompt) {
    let outcome = 'failed';
    try {
      // Copy the owned revision into a separate deployment so unsaved edits never overwrite a live service.
      if (input.transport === 'script' && !input.files) {
        const saved = (await this.services.definitions()).find(config => config.id === input.id);
        if (saved?.deployment) { input.files = await this.services.deployments.files(saved); }
      }
      session.controller.signal.throwIfAborted();
      session.config = await this.services.prepare({ ...input, id: session.serviceId });
      session.config.debug = true;
      session.controller.signal.throwIfAborted();
      await this.services.start(session.serviceId, false, session.config);
      session.controller.signal.throwIfAborted();
      session.evidence = this.services.active(session.serviceId).evidence;
      session.stage = 'AI 正在发现并调用目标 MCP；需要审批时请在工作台确认';
      session.state = 'running';
      await this.invoke(session, 'agent.mcp.debug.start.v1', {
        taskKey: session.taskKey, serviceId: session.serviceId, providerId: this.context.pluginId,
        prompt: `验证本次临时 MCP 服务。先读取服务实际提供的工具说明，再根据参数结构执行一次合适的工具调用并解释返回结果。`
          + `只使用本次服务；不得通过命令行、文件或网络绕过工具接口。不得猜测缺失的业务参数或宣称未执行的调用成功。`
          + `需要真实业务信息时向用户提问；有副作用的操作须遵循审批。测试目标：${prompt.trim() || '验证服务可被 AI 正常发现和调用；优先选择无副作用的调用。'}`
      });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const task = await this.invoke(session, 'agent.task.read.v1', { taskKey: session.taskKey });
        session.requests = task.requests || [];
        session.output = task.output || '';
        if (task.state === 'succeeded') {
          const evidence = session.evidence;
          outcome = evidence.discovered > 0 && evidence.calls.some(call => call.state === 'succeeded')
            && evidence.calls.every(call => call.state === 'succeeded') ? 'passed' : 'incomplete';
          break;
        }
        if (['failed', 'cancelled', 'interrupted'].includes(task.state)) { throw Error(task.error || 'AI 调试未完成'); }
        await delay(400, undefined, { signal: session.controller.signal });
      }
      if (outcome === 'failed') { throw Error('AI 调试超过 10 分钟，请重试'); }
    } catch (error) {
      outcome = session.controller.signal.aborted ? 'cancelled' : 'failed';
      session.error = outcome === 'cancelled' ? '' : error.message;
      console[outcome === 'failed' ? 'error' : 'info']('[mcp:debug]', { serviceId: session.serviceId, state: outcome });
    } finally {
      session.state = 'stopping';
      session.stage = '正在停止 AI 任务并清理临时服务';
      await this.cleanup(session, outcome);
    }
  }

  async cleanup(session, outcome) {
    try {
      // Local resources can be released even when the other plugin cannot acknowledge cancellation.
      try {
        await this.services.stop(session.serviceId, false);
        if (session.taskStarted) {
          await this.invoke(session, 'agent.task.cancel.v1', { taskKey: session.taskKey }, null);
        }
      } finally {
        if (session.config?.deployment) { await this.services.deployments.remove(session.config); }
        this.services.states.delete(session.serviceId);
        this.services.entries.delete(session.serviceId);
      }
      session.cleaned = true;
      session.state = outcome;
      session.stage = { passed: 'AI 已发现工具并完成调用', incomplete: '调试未通过：缺少成功的发现或调用记录',
        cancelled: '调试已取消，临时资源已清理', failed: '调试失败，临时资源已清理' }[outcome];
      console.info('[mcp:debug-cleaned]', { serviceId: session.serviceId, state: outcome });
    } catch (error) {
      session.state = 'cleanup-failed';
      session.error = `清理尚未完成：${error.message}；请再次点击结束调试`;
      console.error('[mcp:debug-cleanup]', { serviceId: session.serviceId, message: error.message });
    }
  }

  async respond(id, input) {
    const session = this.get(id);
    if (session.state !== 'running') { throw Error('调试已不在运行'); }
    return this.invoke(session, 'agent.task.respond.v1', { ...input, taskKey: session.taskKey });
  }

  async cancel(id) {
    const session = this.get(id);
    session.controller.abort();
    // Cancel service initialization before waiting for its owning run's final cleanup.
    await this.services.stop(session.serviceId, false);
    await session.work;
    if (!session.cleaned) { await this.cleanup(session, 'cancelled'); }
    return this.read(id);
  }

  async close() {
    for (const session of this.sessions.values()) {
      if (!session.cleaned || !finished(session.state)) { await this.cancel(session.id); }
    }
    if ([...this.sessions.values()].some(session => !session.cleaned)) { throw Error('MCP AI 调试清理尚未完成'); }
  }
}
