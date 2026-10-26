import { setTimeout as delay } from 'node:timers/promises';
import { requireMenu } from './menu-catalog.js';

// Each short call rediscovers the provider handle; plugin reloads invalidate old host handles.
export class TaskClient {
  constructor(capabilities) { this.capabilities = capabilities; }
  async providers(id = 'agent.menu.plan.start.v1') {
    const catalog = await this.capabilities.discover();
    return catalog.providers.filter(item => item.state === 'ready' && item.descriptor.id === id)
      .map(item => ({ pluginId: item.handle.pluginId, title: item.descriptor.title }));
  }
  async call(id, input, { providerId = '', signal } = {}) {
    signal?.throwIfAborted();
    const catalog = await this.capabilities.discover();
    const providers = catalog.providers.filter(item => item.state === 'ready' && item.descriptor.id === id
      && (!providerId || item.handle.pluginId === providerId));
    requireMenu(providers.length === 1, providers.length ? '发现多个 Agent，请选择提供方' : '请启用支持该能力的 AI Agent 插件');
    signal?.throwIfAborted();
    const invocation = await this.capabilities.invoke(providers[0].handle, input, {});
    try {
      const deadline = Date.now() + 28000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const result = await this.capabilities.getInvocation(invocation.invocationId);
        if (result.state === 'succeeded') { return result.result; }
        requireMenu(!['failed', 'cancelled', 'interrupted'].includes(result.state), result.error?.message || 'Agent 调用未完成');
        await delay(150, undefined, { signal });
      }
      throw Error('Agent 调用等待超时，请完成桌面能力审批后重试');
    } catch (error) {
      await this.capabilities.cancel(invocation.invocationId);
      throw error;
    }
  }
}
