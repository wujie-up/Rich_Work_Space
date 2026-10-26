const pending = new Map();
const subscribers = new Set();
let sequence = 0;

export function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('插件连接超时')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: 'desk:invoke', id, method: 'plugin.invoke', args: [method, args] }, 'desk-host://desktop');
  });
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== 'desk-host://desktop') { return; }
  const message = event.data;
  if (message?.type === 'desk:result') {
    const request = pending.get(message.id);
    if (!request) { return; }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) { request.reject(Error(message.error.message)); } else { request.resolve(message.value); }
  } else if (message?.type === 'desk:event' && message.channel === 'capture.event') {
    for (const listener of subscribers) { listener(message.value); }
  } else if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
  }
});

export function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
