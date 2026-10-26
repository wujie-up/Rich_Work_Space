const pending = new Map();
let sequence = 0;
export function request(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('桌面连接超时')); }, 25000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'desk:invoke', id, method, args }, 'desk-host://desktop');
  });
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== 'desk-host://desktop') { return; }
  const message = event.data;
  if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
    window.dispatchEvent(new Event('editor-theme'));
  }
  if (message?.type !== 'desk:result') { return; }
  const entry = pending.get(message.id);
  if (!entry) { return; }
  clearTimeout(entry.timer);
  pending.delete(message.id);
  message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.value);
});
export const invoke = (method, ...args) => request('plugin.invoke', method, args);
export const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
