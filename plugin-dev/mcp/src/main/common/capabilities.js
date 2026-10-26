import { createHash } from 'node:crypto';

// Publish service adapters without reading tools; the existing AI gateway discovers them through the workbench.
export class McpCapabilities {
  constructor(context, services) {
    Object.assign(this, { context, services });
    this.registered = new Map();
  }

  async publish(id) {
    if (!this.context.capabilities) { return; }
    await this.remove(id);
    const { config } = this.services.active(id);
    const entries = [];
    const actions = [
      ['describe', '工具说明', `读取 ${config.name} MCP 服务实际提供的工具及参数结构。调用该服务前先获取此说明。`,
        { type: 'object', properties: {}, additionalProperties: false }, ['network.read'], () => this.services.tools(id)],
      ['call', '调用工具', `调用 ${config.name} MCP 服务。根据该服务工具说明选择工具和参数；不得猜测业务数据。`,
        { type: 'object', properties: { name: { type: 'string', minLength: 1 }, arguments: { type: 'object' } },
          required: ['name', 'arguments'], additionalProperties: false }, ['mcp.tool'],
        (input, { signal }) => this.services.call(id, input.name, input.arguments, signal)]
    ];
    try {
      for (const [action, title, description, inputSchema, effects, handler] of actions) {
        const capabilityId = `mcp.${createHash('sha256').update(`${id}:${action}`).digest('hex').slice(0, 24)}`;
        await this.context.capabilities.register({ id: capabilityId, version: 1, title: `${config.name} · ${title}`,
          description, inputSchema, outputSchema: { type: 'object' }, effects, confirmation: 'policy',
          execution: { timeoutMs: 20000, cancellable: true, retry: 'never' },
          source: { serviceId: id, ...(config.debug ? { debug: true } : {}) } }, handler);
        entries.push(capabilityId);
      }
      this.registered.set(id, entries);
    } catch (error) {
      for (const capabilityId of entries) { await this.context.capabilities.unregister(capabilityId, 1); }
      throw error;
    }
  }

  async remove(id) {
    for (const capabilityId of this.registered.get(id) || []) {
      await this.context.capabilities.unregister(capabilityId, 1);
    }
    this.registered.delete(id);
  }
}
