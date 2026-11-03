import { setTimeout as delay } from 'node:timers/promises';
import { requireMenu } from './menu-catalog.js';
import { fail } from './errors.js';

// Each short call rediscovers the provider handle; plugin reloads invalidate old host handles.
export class TaskClient {
  constructor(capabilities) { this.capabilities = capabilities; }
  async providers(id = 'agent.menu.plan.start.v1') {
    const catalog = await this.capabilities.discover();
    return catalog.providers.filter(item => item.state === 'ready' && item.descriptor.id === id)
      .map(item => ({ pluginId: item.handle.pluginId, title: item.descriptor.title }));
  }
  async call(id, input, { providerId = '', signal, authorizationId } = {}) {
    signal?.throwIfAborted();
    const catalog = await this.capabilities.discover();
    const providers = catalog.providers.filter(item => item.state === 'ready' && item.descriptor.id === id
      && (!providerId || item.handle.pluginId === providerId));
    requireMenu(providers.length === 1, providers.length ? '发现多个 Agent，请选择提供方' : '请启用支持该能力的 AI Agent 插件');
    // Older providers may still impose a prompt cap; report it before the host's generic schema rejection.
    const promptLimit = providers[0].descriptor.inputSchema?.properties?.prompt?.maxLength;
    if (typeof input.prompt === 'string' && Number.isFinite(promptLimit) && input.prompt.length > promptLimit) {
      throw fail('AGENT_INPUT_TOO_LARGE', `节点输入超限：实际 ${input.prompt.length} 字符，提供方上限 ${promptLimit} 字符。请精简输入或升级 AI Agent。`);
    }
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (bytes > 1048576) {
      throw fail('AGENT_INPUT_TOO_LARGE', `节点输入超限：实际 ${bytes} 字节，工作台传输上限 1048576 字节。请减少重复文档或拆分输入。`);
    }
    signal?.throwIfAborted();
    const invocation = await this.capabilities.invoke(providers[0].handle, input, authorizationId ? { authorizationId } : {});
    try {
      let deadline = Date.now() + 28000;
      while (true) {
        signal?.throwIfAborted();
        const result = await this.capabilities.getInvocation(invocation.invocationId);
        if (result.state === 'succeeded') { return result.result; }
        requireMenu(!['failed', 'cancelled', 'interrupted'].includes(result.state), result.error?.message || 'Agent 调用未完成');
        // Approval is a human wait; the host owns execution and parent-call deadlines.
        if (result.approvalRequired || result.state === 'awaiting_approval') {
          deadline = Date.now() + 28000;
        } else if (Number.isFinite(result.deadline)) {
          deadline = result.deadline;
        }
        requireMenu(Date.now() < deadline, 'Agent 调用执行超时');
        await delay(150, undefined, { signal });
      }
    } catch (error) {
      await this.capabilities.cancel(invocation.invocationId);
      throw error;
    }
  }
}
