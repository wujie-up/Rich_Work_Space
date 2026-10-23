const pending = new Map();
let sequence = 0;
function request(method, ...args) {
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
  if (message?.type === 'desk:theme') { document.documentElement.dataset.theme = message.theme; }
  if (message?.type !== 'desk:result') { return; }
  const request = pending.get(message.id);
  if (!request) { return; }
  pending.delete(message.id);
  clearTimeout(request.timer);
  message.error ? request.reject(Error(message.error.message)) : request.resolve(message.value);
});
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export async function action(work) {
  const status = document.querySelector('#status');
  status.textContent = '处理中…';
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await work(); status.textContent = '已完成'; }
  catch (error) { status.textContent = error.message; }
  finally { document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}

export const invoke = (method, ...args) => request('plugin.invoke', method, args);
const preferences = await request('storage.getPreferences');
document.documentElement.dataset.theme = preferences.theme;
