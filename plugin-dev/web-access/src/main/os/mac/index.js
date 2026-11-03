import { MacAssistant } from './assistant.js';

export function macPlatform(context) {
  return { loadEngine: () => import('@number0/iroh'),
    createAssistant: executable => new MacAssistant(context, executable) };
}
