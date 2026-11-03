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
  }
  if (message?.type !== 'desk:result') {
    return;
  }
  const call = pending.get(message.id);
  if (call) {
    clearTimeout(call.timer);
    pending.delete(message.id);
    message.error ? call.reject(Object.assign(Error(message.error.message), message.error)) : call.resolve(message.value);
  }
});

export function request(method, args) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('请求超时，请重试或缩小范围'));
    }, 25000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'desk:invoke', id, method, args }, origin);
  });
}

export const invoke = (method, input = {}) => request('plugin.invoke', [`code.${method}`, [input]]);

window.addEventListener('pagehide', () => {
  for (const call of pending.values()) {
    clearTimeout(call.timer);
    call.reject(Error('页面已关闭'));
  }
  pending.clear();
}, { once: true });
