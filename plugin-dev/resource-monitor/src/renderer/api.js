const origin = 'desk-host://desktop';
const pending = new Map();
let sequence = 0;
export let collapsed = false;

window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== origin) {
    return;
  }
  const message = event.data;
  if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
  } else if (message?.type === 'desk:presentation') {
    collapsed = message.collapsed === true;
  } else if (message?.type === 'desk:result') {
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(Object.assign(Error(message.error.message), message.error));
      } else {
        request.resolve(message.value);
      }
    }
  }
});

export function send(message) {
  parent.postMessage(message, origin);
}

export function request(method, args) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('资源监控请求超时'));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    send({ type: 'desk:invoke', id, method, args });
  });
}

export const invoke = (method, ...args) => request('plugin.invoke', [method, args]);

window.addEventListener('pagehide', () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(Error('页面已关闭'));
  }
  pending.clear();
}, { once: true });
