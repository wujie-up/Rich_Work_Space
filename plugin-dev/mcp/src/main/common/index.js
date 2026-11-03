import { readFile } from 'node:fs/promises';
import { McpServices } from './services.js';
import { LaunchConfig } from './launch-config.js';
import { McpDebug } from './debug.js';
import { BuiltinTools } from './builtin-tools.js';
import { BrowserTools } from './browser-tools.js';
let services;
let debug;
let builtin;
let browser;
export async function activate(context) {
  // Each provider reports its own children; publishing their union preserves service cleanup when a browser starts or stops.
  const owned = new Map();
  const owner = name => ({ ...context, ownProcesses: pids => {
    owned.set(name, pids);
    context.ownProcesses([...owned.values()].flat());
  } });
  services = new McpServices(owner('services'));
  debug = new McpDebug(context, services);
  builtin = new BuiltinTools(context);
  browser = new BrowserTools(owner('browser'));
  try {
    await browser.load();
  } catch (error) {
    await browser.close();
    console.error('[mcp:browser-register-failed]', { pluginId: context.pluginId }, error);
  }
  context.methods.register('mcp.builtin.status', () => builtin.status());
  context.methods.register('mcp.builtin.remove', () => builtin.remove(), { exclusive: true });
  context.methods.register('mcp.builtin.read', () => builtin.read());
  context.methods.register('mcp.builtin.save', input => builtin.save(input), { exclusive: true });
  // Optional workbench tools must not prevent existing MCP services from starting.
  try {
    await builtin.load();
  } catch (error) {
    await builtin.close();
    console.error('[mcp:builtin-start-failed]', { pluginId: context.pluginId }, error);
  }
  for (const method of ['list', 'source', 'save', 'remove', 'start', 'stop', 'tools', 'call', 'logs', 'clearLogs', 'connections']) {
    context.methods.register(`mcp.${method}`, (...args) => services[method](...args), {
      exclusive: ['save', 'remove', 'start', 'stop'].includes(method)
    });
  }
  context.services.register({ contract: 'mcp.connections.v1', method: 'mcp.connections' });
  for (const method of ['start', 'read', 'respond', 'cancel']) {
    context.methods.register(`mcp.debug.${method}`, (...args) => debug[method](...args));
  }
  const config = new LaunchConfig(context, () => services.connections());
  context.methods.register('mcp.ai.list', async () => ({ selected: await config.selected(), candidates: await config.candidates() }));
  context.methods.register('mcp.ai.save', selection => config.save(selection), { exclusive: true });
  context.methods.register('mcp.ai.launch', input => config.launch(input));
  context.services.register({ contract: 'agent.launch-config.v1', method: 'mcp.ai.launch' });
  context.lifecycle.register({
    snapshot: async () => [...(await services.list()).filter(value => value.state === 'running').map(value => ({ id: value.id, name: value.name })),
      ...[...debug.sessions.values()].filter(session => !session.cleaned).map(session => ({ id: session.id, name: 'MCP AI 调试' })),
      ...[...builtin.active].map(active => ({ id: active.id, name: active.id === 'mcp.computer.control' ? '电脑操作' : '飞书文档读取' })),
      ...(browser.server ? [{ id: 'mcp.browser.control', name: '浏览器操作' }] : [])],
    stop: async () => { await browser.close(); await builtin.close(); await debug.close(); await services.close(); }
  });
  const manifest = JSON.parse(await readFile(new URL('../../../plugin.json', import.meta.url), 'utf8'));
  context.views.register(manifest.views[0]);
  setImmediate(() => services.restore().catch(error => console.error('[mcp:restore]', { code: error.code })));
}
export async function deactivate() { await browser?.close(); await builtin?.close(); await debug?.close(); await services?.close(); }
