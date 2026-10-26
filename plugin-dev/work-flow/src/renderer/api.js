const pending = new Map();
const listeners = new Map();
let sequence = 0;

function request(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('桌面连接超时，请重新打开插件')); }, 35000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'desk:invoke', id, method, args }, 'desk-host://desktop');
  });
}

window.addEventListener('message', event => {
  // Only the owning host frame may deliver results, events or theme changes.
  if (event.source !== parent || event.origin !== 'desk-host://desktop') {
    return;
  }
  const message = event.data;
  if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
    return;
  }
  if (message?.type === 'desk:event') {
    for (const callback of listeners.get(message.channel) || []) {
      callback(message.value);
    }
    return;
  }
  if (message?.type !== 'desk:result') {
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) {
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(message.id);
  message.error ? entry.reject(Object.assign(Error(message.error.message), message.error)) : entry.resolve(message.value);
});

export const invoke = (method, ...args) => request('plugin.invoke', method, args);
export const chooseDirectory = () => request('host.chooseDirectory');
export const preferences = () => request('storage.getPreferences');
export const subscribe = channel => callback => {
  const callbacks = listeners.get(channel) || new Set();
  listeners.set(channel, callbacks);
  callbacks.add(callback);
  return () => callbacks.delete(callback);
};
export const escape = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
