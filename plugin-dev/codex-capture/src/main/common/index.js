import { SessionCaptureClient } from './session-client.js';

let client;
let heartbeat;
export async function activate(context) {
  client = new SessionCaptureClient(context.services);
  for (const method of ['sources', 'status', 'list', 'read', 'configure']) {
    context.methods.register(`capture.${method}`, (...args) => client[method](...args), { exclusive: method === 'configure' });
  }
  heartbeat = setInterval(() => client.renew().catch(error => {
    context.emit('capture.event', { type: 'capture.error', code: 'AGENT_UNAVAILABLE', message: error.message });
  }), 5000);
  heartbeat.unref();
  context.views.register({ id: 'capture', title: 'Agent 抓包', entry: 'dist/renderer/index.html' });
  context.lifecycle.register({ snapshot: () => client.enabled ? [{ id: 'capture', name: '目标对话抓包' }] : [], stop: deactivate });
}

export async function deactivate() {
  clearInterval(heartbeat);
  try { await client?.stop(); }
  catch { console.info('[agent-capture:stop]', { message: '目标 Agent 已失联，记录租约将自动到期' }); }
}
