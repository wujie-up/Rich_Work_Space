import { randomBytes } from 'node:crypto';
import { fail } from './errors.js';

const sessionContract = id => /^agent\.session\.(start|read|history|respond|cancel|close)\.v1$/.test(id);

// Leases stay in memory; persisted bindings contain only opaque session handles and display metadata.
export class AgentSessions {
  constructor(tasks) {
    this.tasks = tasks;
    this.runs = new Map();
  }

  async run(request, { runId, nodeId, workflowId, name, signal }) {
    let run = this.runs.get(runId);
    if (!run) {
      run = { bindings: new Map(), authorizations: new Map(), authorizing: new Map() };
      this.runs.set(runId, run);
    }
    let binding = run.bindings.get(nodeId);
    if (!binding || binding.archivedAt) {
      const providers = await this.tasks.providers('agent.session.start.v1');
      const target = request.providerId ? providers.find(item => item.pluginId === request.providerId) : providers[0];
      if (!target) { throw fail('AGENT_PROVIDER_MISSING', '请启用支持后台会话的 AI Agent 插件'); }
      if (!request.providerId && providers.length > 1) { throw fail('AGENT_PROVIDER_AMBIGUOUS', '请在节点中选择 Agent 提供方'); }
      binding = { nodeId, name, providerId: target.pluginId, bindingKey: `${runId}:${nodeId}`, iteration: 0 };
      run.bindings.set(nodeId, binding);
    }
    if (!run.authorizations.has(binding.providerId)) {
      // Parallel nodes share the in-flight consent request as well as the granted lease.
      if (!run.authorizing.has(binding.providerId)) {
        const authorization = this.#authorize(run, binding, workflowId, signal)
          .finally(() => run.authorizing.delete(binding.providerId));
        run.authorizing.set(binding.providerId, authorization);
      }
      await run.authorizing.get(binding.providerId);
    }
    const authorization = await this.tasks.capabilities.authorization(run.authorizations.get(binding.providerId).id);
    signal?.throwIfAborted();
    if (authorization.state === 'pending') { return { state: 'starting', requests: [] }; }
    if (authorization.state !== 'granted') { throw fail('AGENT_AUTHORIZATION_DENIED', '后台 Agent 授权被拒绝或已失效'); }
    const options = { providerId: binding.providerId, signal, authorizationId: authorization.id };
    if (!request.taskKey) { request.taskKey = randomBytes(32).toString('hex'); }
    if (binding.taskKey !== request.taskKey) {
      const result = await this.tasks.call('agent.session.start.v1', { bindingKey: binding.bindingKey,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}), taskKey: request.taskKey, name, prompt: request.prompt,
        mode: request.mode || 'plan', ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.mode === 'code' ? { files: request.files } : {}) }, options);
      if (signal?.aborted) {
        await this.tasks.call('agent.session.close.v1', { sessionId: result.sessionId },
          { providerId: binding.providerId, authorizationId: authorization.id });
        signal.throwIfAborted();
      }
      binding.sessionId = result.sessionId;
      binding.taskKey = request.taskKey;
      binding.iteration += 1;
    }
    Object.assign(request, { sessionId: binding.sessionId, providerId: binding.providerId, runId });
    const result = await this.tasks.call('agent.session.read.v1', { sessionId: binding.sessionId }, options);
    return { ...result, binding: this.public(binding) };
  }

  async #authorize(run, binding, workflowId, signal) {
    const catalog = await this.tasks.capabilities.discover();
    const handles = catalog.providers.filter(item => item.state === 'ready' &&
      (sessionContract(item.descriptor.id) && item.handle.pluginId === binding.providerId
        || !item.descriptor.id.startsWith('agent.') && item.descriptor.id !== 'workflow.run.v1')).map(item => item.handle);
    const lease = await this.tasks.capabilities.authorize({ scopeKey: `workflow:${workflowId}:${binding.providerId}`,
      title: '工作流后台 Agent 完全授权', providers: handles });
    if (signal?.aborted) {
      await this.tasks.capabilities.revoke(lease.id);
      signal.throwIfAborted();
    }
    run.authorizations.set(binding.providerId, lease);
  }

  public({ nodeId, name, providerId, sessionId, iteration, archivedAt }) {
    return { nodeId, name, providerId, sessionId, iteration, archivedAt };
  }

  respond(request, input) {
    const { requestId, answers, decision } = input;
    return this.tasks.call('agent.session.respond.v1', { sessionId: request.sessionId, requestId,
      ...(answers ? { answers } : { decision }) }, { providerId: request.providerId,
      authorizationId: this.runs.get(request.runId)?.authorizations.get(request.providerId)?.id });
  }

  cancel(request) {
    return this.tasks.call('agent.session.cancel.v1', { sessionId: request.sessionId }, { providerId: request.providerId,
      authorizationId: this.runs.get(request.runId)?.authorizations.get(request.providerId)?.id });
  }

  async release(runId, reachable = new Set()) {
    const run = this.runs.get(runId);
    if (!run) { return []; }
    const failures = [];
    try {
      for (const binding of run.bindings.values()) {
        if (!binding.sessionId || binding.archivedAt || reachable.has(binding.nodeId)) { continue; }
        try {
          const result = await this.tasks.call('agent.session.close.v1', { sessionId: binding.sessionId },
            { providerId: binding.providerId, authorizationId: run.authorizations.get(binding.providerId)?.id });
          binding.archivedAt = result.archivedAt;
        } catch (error) {
          failures.push(`${binding.nodeId}/${binding.sessionId}: ${error.message}`);
        }
      }
    } finally {
      if (!reachable.size) {
        for (const authorization of run.authorizations.values()) { await this.tasks.capabilities.revoke(authorization.id); }
        run.authorizations.clear();
      }
    }
    if (failures.length) { throw fail('SESSION_CLOSE_FAILED', failures.join('；')); }
    return [...run.bindings.values()].filter(item => item.sessionId).map(item => this.public(item));
  }

  history(binding, { afterSequence = 0, limit = 100 } = {}) {
    return this.tasks.call('agent.session.history.v1', { sessionId: binding.sessionId, afterSequence, limit },
      { providerId: binding.providerId });
  }
}
