import { createHash } from 'node:crypto';
const fail = message => Object.assign(Error(message), { code: 'MCP_SELECTION_UNAVAILABLE' });

export class LaunchConfig {
  constructor(context, connections) {
    this.context = context;
    this.connections = connections;
    this.key = `plugin-data/${context.pluginId}/ai-config.json`;
  }
  async selected() { return this.context.storage.readJson(this.key, []); }
  async save(selection) {
    if (!Array.isArray(selection) || selection.some(value => !value || typeof value.pluginId !== 'string' || !value.pluginId
      || typeof value.serviceId !== 'string' || !value.serviceId)
      || new Set(selection.map(value => `${value.pluginId}:${value.serviceId}`)).size !== selection.length) {
      throw Error('服务选择无效或重复');
    }
    // Credentials and gateway addresses are resolved at launch, never persisted here.
    await this.context.storage.writeJson(this.key, selection.map(({ pluginId, serviceId }) => ({ pluginId, serviceId })));
    console.info('[mcp:ai-selection]', { pluginId: this.context.pluginId, serviceIds: selection.map(value => value.serviceId) });
  }
  async providers() {
    const providers = await this.context.services.discover('mcp.connections.v1');
    return [{ pluginId: this.context.pluginId }, ...providers.filter(value => value.pluginId !== this.context.pluginId)];
  }
  async resolve(provider) {
    // Internal calls stay inside the MCP domain instead of re-entering the host's cycle guard.
    return provider.pluginId === this.context.pluginId ? this.connections()
      : this.context.services.invoke(provider, {}, { timeout: 3000 });
  }
  async candidates() {
    const providers = await this.providers();
    const groups = await Promise.all(providers.map(async provider => {
      try {
        const result = await this.resolve(provider);
        if (result.version !== 1 || !Array.isArray(result.services)) { throw Error('MCP 服务契约版本不兼容'); }
        return result.services.map(({ id, name, state }) => ({ pluginId: provider.pluginId, serviceId: id, name, state }));
      } catch (error) {
        console.error('[mcp:ai-provider]', { pluginId: provider.pluginId, message: error.message });
        return [{ pluginId: provider.pluginId, state: 'unavailable', name: '服务提供方暂不可用' }];
      }
    }));
    return groups.flat();
  }
  async launch({ clientId }) {
    if (!['codex', 'claude'].includes(clientId)) { return { version: 1, overrides: [] }; }
    // Local enabled connections are opt-in at start; old local selections must not block after stop/removal.
    const local = await this.connections();
    const selected = [...(await this.selected()).filter(value => value.pluginId !== this.context.pluginId),
      ...local.services.filter(value => value.state === 'running')
        .map(value => ({ pluginId: this.context.pluginId, serviceId: value.id }))];
    const providers = await this.providers();
    const groups = new Map();
    const overrides = [];
    const mcpServers = {};
    for (const selection of selected) {
      const provider = providers.find(value => value.pluginId === selection.pluginId);
      if (!provider) { throw fail(`MCP 提供方 ${selection.pluginId} 不可用，请检查 AI 接入选择`); }
      if (!groups.has(provider.pluginId)) {
        groups.set(provider.pluginId, await this.resolve(provider));
      }
      const result = groups.get(provider.pluginId);
      const service = result.version === 1 && result.services?.find(value => value.id === selection.serviceId);
      if (!service || service.state !== 'running' || !service.url || !service.headers?.Authorization) {
        throw fail(`MCP 服务 ${selection.serviceId} 未就绪，请启动服务或取消选择`);
      }
      const name = `desk_${createHash('sha256').update(`${provider.pluginId}:${service.id}`).digest('hex').slice(0, 16)}`;
      // Client-specific serialization belongs to the MCP provider, not the AI plugin.
      if (clientId === 'claude') {
        mcpServers[name] = { type: 'http', url: service.url, headers: { Authorization: service.headers.Authorization } };
        continue;
      }
      overrides.push(`mcp_servers.${name}.url=${JSON.stringify(service.url)}`,
        `mcp_servers.${name}.http_headers={ Authorization = ${JSON.stringify(service.headers.Authorization)} }`);
    }
    console.info('[mcp:ai-launch]', { clientId, serviceCount: selected.length });
    return clientId === 'claude' ? { version: 1, mcpConfig: { mcpServers } } : { version: 1, overrides };
  }
}
