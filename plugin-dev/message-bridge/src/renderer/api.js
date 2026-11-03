import { pluginHostOrigin } from '../../../../desk/src/resource/plugin-host.js';
const hostOrigin = pluginHostOrigin();
const pending = new Map();
const subscribers = new Set();
let sequence = 0;

function invoke(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('插件连接超时')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: 'desk:invoke', id, method, args }, hostOrigin);
  });
}

export const call = (method, ...args) => invoke('plugin.invoke', [method, args]);

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== hostOrigin) { return; }
  const message = event.data;
  if (message?.type === 'desk:result') {
    const request = pending.get(message.id);
    if (!request) { return; }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) { request.reject(Error(message.error.message)); } else { request.resolve(message.value); }
  } else if (message?.type === 'desk:event' && message.channel === 'bridge.changed') {
    for (const listener of subscribers) { listener(message.value); }
  } else if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
  }
});

export function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
