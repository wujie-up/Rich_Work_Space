import { randomBytes } from 'node:crypto';
import { AgentSessions } from './agent-sessions.js';
import { fail } from './errors.js';

export const AGENT_CONTRACT = 'agent.task.start.v1';

// The host coordinates short capability calls; the AI plugin owns the long-running task.
export function createAgents({ tasks, logger = () => {} }) {
  const sessions = tasks.capabilities?.authorize ? new AgentSessions(tasks) : null;
  return {
    release: (runId, reachable) => sessions?.release(runId, reachable),
    history: (binding, options) => sessions?.history(binding, options),
    async providers() {
      const catalogs = await Promise.all([tasks.providers('agent.session.start.v1'), tasks.providers(AGENT_CONTRACT)]);
      return [...new Map(catalogs.flat().map(provider => [provider.pluginId, provider])).values()];
    },

    async run(request, options = {}) {
      const { signal } = options;
      // The existing scoped code capability has a legacy menu name; adaptation belongs to this node.
      const contract = request.mode === 'code' ? 'agent.menu.code.start.v1' : AGENT_CONTRACT;
      const sessionProviders = sessions && options.runId ? await tasks.providers('agent.session.start.v1') : [];
      if (!request.taskKey && !request.sessionId) {
        // Snapshots retain old plugin IDs; resolve current versioned contracts before creating any owned task handles.
        const catalogs = [...sessionProviders, ...await tasks.providers(contract)];
        const providers = [...new Map(catalogs.map(provider => [provider.pluginId, provider])).values()];
        const target = providers.find(item => item.pluginId === request.providerId) || (providers.length === 1 ? providers[0] : null);
        if (!target) {
          throw providers.length
            ? fail('AGENT_PROVIDER_AMBIGUOUS', `无法唯一确定 Agent 提供方，请在节点中选择：${providers.map(item => item.pluginId).join('、')}`)
            : fail('AGENT_PROVIDER_MISSING', '当前没有可用的兼容 Agent 提供方，请在工作台启用 AI Agent 插件后重试');
        }
        signal?.throwIfAborted();
        if (request.providerId && request.providerId !== target.pluginId) {
          logger('info', 'agent-provider-adapted', { runId: options.runId, nodeId: options.nodeId, workflowId: options.workflowId,
            previousProviderId: request.providerId, providerId: target.pluginId });
        }
        request.providerId = target.pluginId;
      }
      const supportsSessions = request.sessionId
        || !request.taskKey && sessionProviders.some(item => item.pluginId === request.providerId);
      if (sessions && options.runId && supportsSessions) {
        const result = await sessions.run(request, options);
        if (['failed', 'cancelled', 'interrupted'].includes(result.state)) {
          throw fail('AGENT_TASK_FAILED', result.error || 'Agent 任务未完成');
        }
        return { ...result, provider: request.providerId };
      }
      if (!request.taskKey) {
        signal?.throwIfAborted();
        request.taskKey = randomBytes(32).toString('hex');
        await tasks.call(contract, { taskKey: request.taskKey, prompt: request.prompt,
          ...(request.cwd ? { cwd: request.cwd } : {}), ...(request.mode === 'code' ? { files: request.files } : {}) }, { providerId: request.providerId, signal });
      }
      const result = await tasks.call('agent.task.read.v1', { taskKey: request.taskKey }, { providerId: request.providerId, signal });
      if (['failed', 'cancelled', 'interrupted'].includes(result.state)) {
        throw fail('AGENT_TASK_FAILED', result.error || 'Agent 任务未完成，请检查 AI Agent 插件配置');
      }
      if (result.state === 'succeeded' && typeof result.output === 'string') {
        return { state: result.state, output: result.output, provider: request.providerId };
      }
      if (!['starting', 'running'].includes(result.state)) {
        throw fail('AGENT_PROVIDER_INCOMPATIBLE', 'AI Agent 插件返回的任务状态或结果不符合能力契约');
      }
      return { state: result.state, requests: result.requests || [] };
    },

    respond(request, { requestId, answers, decision }) {
      if (request.sessionId) { return sessions.respond(request, { requestId, answers, decision }); }
      return tasks.call('agent.task.respond.v1', { taskKey: request.taskKey, requestId,
        ...(answers ? { answers } : { decision }) }, { providerId: request.providerId });
    },

    async cancel(request) {
      if (request.sessionId) { return sessions.cancel(request); }
      if (request.taskKey) {
        await tasks.call('agent.task.cancel.v1', { taskKey: request.taskKey }, { providerId: request.providerId });
      }
    }
  };
}
