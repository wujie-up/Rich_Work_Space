import { McpServices } from './services.js';
import { LaunchConfig } from './launch-config.js';
let services;
export async function activate(context) {
  services = new McpServices(context);
  for (const method of ['list', 'save', 'remove', 'start', 'stop', 'tools', 'call', 'logs', 'connections']) {
    context.methods.register(`mcp.${method}`, (...args) => services[method](...args), {
      exclusive: ['save', 'remove', 'start', 'stop'].includes(method)
    });
  }
  context.services.register({ contract: 'mcp.connections.v1', method: 'mcp.connections' });
  const config = new LaunchConfig(context, () => services.connections());
  context.methods.register('mcp.ai.list', async () => ({ selected: await config.selected(), candidates: await config.candidates() }));
  context.methods.register('mcp.ai.save', selection => config.save(selection), { exclusive: true });
  context.methods.register('mcp.ai.launch', input => config.launch(input));
  context.services.register({ contract: 'agent.launch-config.v1', method: 'mcp.ai.launch' });
  context.lifecycle.register({
    snapshot: async () => (await services.list()).filter(value => value.state === 'running').map(value => ({ id: value.id, name: value.name })),
    stop: () => services.close()
  });
  context.views.register({ id: 'services', title: 'MCP 服务', entry: 'dist/renderer/index.html' });
}
export async function deactivate() { await services?.close(); }
