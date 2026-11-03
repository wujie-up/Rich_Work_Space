import { AccessService } from './access.js';
import { createPlatform } from '../os/index.js';

let access;
let assistant;

export function activate(context) {
  const platform = createPlatform(context);
  access = new AccessService({ context, platform });
  assistant = platform.createAssistant();
  // Native-only metadata is enforced by the host before any plugin handler executes.
  const methods = {
    'access.status': () => ({ ...access.status(), assistantRunning: assistant.running }),
    'assistant.open': () => assistant.open(),
    'access.start': () => access.start(),
    'access.stop': () => access.stop(),
    'pairing.create': () => access.createInvitation(),
    'pairing.confirm': requestId => access.confirm(requestId),
    'devices.revoke': deviceId => access.revoke(deviceId)
  };
  Object.entries(methods).forEach(([name, handler]) => context.methods.register(name, handler, { nativeOnly: true, exclusive: true }));
  context.lifecycle.register({ snapshot: () => [], stop });
}

async function stop() {
  try {
    await access?.stop();
  } finally {
    await assistant?.stop();
  }
}

export async function deactivate() {
  await stop();
  access = null;
  assistant = null;
}
