import { pluginHostOrigin } from '../../../../desk/src/resource/plugin-host.js';

const origin = pluginHostOrigin();
const pending = new Map();
let sequence = 0;

window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== origin) {
    return;
  }
  const message = event.data;
  if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
  }
  const request = message?.type === 'desk:result' && pending.get(message.id);
  if (request) {
    clearTimeout(request.timer);
    pending.delete(message.id);
    message.error ? request.reject(Error(message.error.message)) : request.resolve(message.value);
  }
});

export function request(method, args = []) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('请求超时，请刷新状态后再试')); }, 25000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'desk:invoke', id, method, args }, origin);
  });
}

export const invoke = (method, ...args) => request('plugin.invoke', [method, args]);

window.addEventListener('pagehide', () => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(Error('页面已关闭'));
  }
  pending.clear();
});
