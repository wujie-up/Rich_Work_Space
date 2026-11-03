import { pluginHostOrigin } from '../../../../desk/src/resource/plugin-host.js';

const origin = pluginHostOrigin();
const requests = new Map();
let sequence = 0;

export function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(Error('工作台响应超时')); }, 30000);
    requests.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: 'desk:invoke', id, method: 'plugin.invoke', args: [method, args] }, origin);
  });
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== origin) { return; }
  const value = event.data;
  if (value?.type === 'desk:theme') { document.documentElement.dataset.theme = value.theme; }
  if (value?.type !== 'desk:result') { return; }
  const request = requests.get(value.id);
  if (!request) { return; }
  clearTimeout(request.timer);
  requests.delete(value.id);
  if (value.error) { request.reject(Error(value.error.message)); } else { request.resolve(value.value); }
});
