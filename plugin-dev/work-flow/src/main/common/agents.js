import { randomBytes } from 'node:crypto';
import { fail } from './errors.js';

export const AGENT_CONTRACT = 'agent.task.start.v1';

// The host coordinates short capability calls; the AI plugin owns the long-running task.
export function createAgents({ tasks }) {
  return {
    providers: () => tasks.providers(AGENT_CONTRACT),

    async run(request, { signal } = {}) {
      if (!request.taskKey) {
        // The existing scoped code capability has a legacy menu name; adaptation belongs to this node.
        const contract = request.mode === 'code' ? 'agent.menu.code.start.v1' : AGENT_CONTRACT;
        const providers = await tasks.providers(contract);
        const target = request.providerId ? providers.find(item => item.pluginId === request.providerId) : providers[0];
        if (!target) {
          throw fail('AGENT_PROVIDER_MISSING', '请在工作台启用或升级 AI Agent 插件，然后刷新能力列表');
        }
        if (!request.providerId && providers.length > 1) {
          throw fail('AGENT_PROVIDER_AMBIGUOUS', '发现多个 AI Agent 插件，请在节点配置中选择提供方');
        }
        signal?.throwIfAborted();
        request.providerId = target.pluginId;
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
      return tasks.call('agent.task.respond.v1', { taskKey: request.taskKey, requestId,
        ...(answers ? { answers } : { decision }) }, { providerId: request.providerId });
    },

    async cancel(request) {
      if (request.taskKey) {
        await tasks.call('agent.task.cancel.v1', { taskKey: request.taskKey }, { providerId: request.providerId });
      }
    }
  };
}
