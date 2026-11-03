import { AgentClient } from './agent-client.js';
import { MessageBridge } from './service.js';
import { channelFactory } from './channels/index.js';

let bridge;
export async function activate(context) {
  const agent = new AgentClient(context.capabilities);
  bridge = new MessageBridge({ pluginId: context.pluginId, storage: context.storage, emit: context.emit, agent, channelFactory });
  await bridge.load();
  const methods = {
    snapshot: async () => ({ ...bridge.snapshot(), authorized: await agent.ready() }),
    authorize: () => agent.authorize(), revoke: () => bridge.revoke(), catalog: () => agent.call('catalog'),
    saveChannel: input => bridge.saveChannel(input), removeChannel: id => bridge.removeChannel(id),
    saveRoute: input => bridge.saveRoute(input), unbindRoute: id => bridge.unbindRoute(id),
    retry: (id, accepted) => bridge.retryDelivery(id, accepted),
    login: id => bridge.loginChannel(id),
    verify: async (id, code) => { const channel = await bridge.transport(id); channel.verify?.(code); }
  };
  for (const [name, handler] of Object.entries(methods)) {
    context.methods.register(`bridge.${name}`, handler, { exclusive: !['snapshot', 'catalog'].includes(name),
      nativeOnly: ['authorize', 'revoke', 'saveChannel', 'removeChannel', 'login', 'verify', 'saveRoute', 'unbindRoute', 'retry'].includes(name) });
  }
  context.views.register({ id: 'bridge', title: '消息对接', entry: 'dist/renderer/index.html' });
  context.lifecycle.register({ snapshot: () => bridge.snapshot().exchanges.filter(item => !item.closed
    && ['received', 'queued', 'submitting', 'running', 'waiting_input'].includes(item.state)).map(item => ({ id: item.id, name: `消息任务 ${item.id.slice(0, 8)}` })), stop: deactivate });
  await bridge.start();
}

export async function deactivate() { await bridge?.stop(); }
