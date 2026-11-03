import { setTimeout as delay } from 'node:timers/promises';

export class AgentClient {
  constructor(capabilities) { this.capabilities = capabilities; }

  async providers() {
    const { providers } = await this.capabilities.discover();
    return providers.filter(item => item.state === 'ready' && item.handle.pluginId === 'ai-agent-sessions'
      && /^agent\.bridge\.\w+\.v1$/.test(item.descriptor.id));
  }

  async authorize() {
    const providers = await this.providers();
    if (providers.length !== 8) { throw Error('请先启用包含消息桥接能力的 AI Agent 插件'); }
    this.lease = await this.capabilities.authorize({ scopeKey: 'message-bridge:agent', title: '允许消息规则使用选定 Agent 会话',
      providers: providers.map(item => item.handle) });
    return this.capabilities.authorization(this.lease.id);
  }

  async ready() {
    if (!this.lease) { return false; }
    const authorization = await this.capabilities.authorization(this.lease.id);
    return authorization.state === 'granted';
  }

  async call(method, input = {}) {
    if (!await this.ready()) { throw Error('请在本地授权消息桥接'); }
    const provider = (await this.providers()).find(item => item.descriptor.id === `agent.bridge.${method}.v1`);
    if (!provider) { throw Error('AI 插件桥接能力暂不可用'); }
    const invocation = await this.capabilities.invoke(provider.handle, input, { authorizationId: this.lease.id });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await this.capabilities.getInvocation(invocation.invocationId);
      if (result.state === 'succeeded') { return result.result; }
      if (['failed', 'cancelled', 'interrupted'].includes(result.state)) { throw Error(result.error?.message || 'AI 桥接调用失败'); }
      await delay(100);
    }
    throw Error('AI 桥接回执超时；请检查任务状态，勿重复提交');
  }

  async revoke() {
    if (this.lease) { await this.capabilities.revoke(this.lease.id); }
    this.lease = null;
  }
}
