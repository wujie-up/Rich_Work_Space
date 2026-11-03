import { pluginHostOrigin } from '../../../../desk/src/resource/plugin-host.js';
const hostOrigin = pluginHostOrigin();
const origin = hostOrigin;
const pending = new Map();
let sequence = 0;

window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== origin) {
    return;
  }
  const message = event.data;
  if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
  } else if (message?.type === 'desk:result') {
    const entry = pending.get(message.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(Object.assign(Error(message.error.message), message.error));
      } else {
        entry.resolve(message.value);
      }
    }
  }
});

export function request(method, args = []) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('插件请求超时，请重试'));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'desk:invoke', id, method, args }, origin);
  });
}

export const invoke = (method, ...args) => request('plugin.invoke', [method, args]);

request('storage.getPreferences').then(value => {
  document.documentElement.dataset.theme = value.theme === 'dark' ? 'dark' : 'light';
}).catch(() => {});

window.addEventListener('pagehide', () => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(Error('页面已关闭'));
  }
  pending.clear();
});
