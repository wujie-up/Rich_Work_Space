const owner = location.hostname;
const pending = new Map();
const listeners = new Map();
let sequence = 0;
const invoke = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(Error('桌面连接超时，请重新打开插件'));
  }, 35000);
  pending.set(id, { resolve, reject, timer });
  window.parent.postMessage({ type: 'desk:invoke', id, method, args }, 'desk-host://desktop');
});
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== 'desk-host://desktop') {
    return;
  }
  const message = event.data;
  if (message?.type === 'desk:result') {
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.id);
      message.error ? request.reject(Object.assign(Error(message.error.message), message.error)) : request.resolve(message.value);
    }
  } else if (message?.type === 'desk:event') {
    for (const callback of listeners.get(message.channel) || []) {
      callback(message.value);
    }
  } else if (message?.type === 'desk:theme') {
    document.documentElement.dataset.theme = message.theme;
    window.dispatchEvent(new CustomEvent('desk-theme', { detail: message.theme }));
  }
});
const methods = (group, names) => Object.fromEntries(names.map((name) => [name, (id, ...args) => {
  if (id !== owner) {
    return Promise.reject(Error('插件数据归属不符'));
  }
  return invoke('plugin.invoke', `${group}.${name}`, args);
}]));
const subscribe = (channel) => (callback) => {
  const callbacks = listeners.get(channel) || new Set();
  listeners.set(channel, callbacks);
  callbacks.add(callback);
  return () => callbacks.delete(callback);
};
export const api = {
  sessions: methods('sessions', ['list', 'create', 'write', 'saveImage', 'resize', 'rename', 'archive', 'attach', 'readArchive', 'restore', 'fork',
    'deleteArchive', 'gitInfo', 'switchBranch']),
  storage: { ...methods('storage', ['getLayout', 'saveLayout', 'getAdapterConfig', 'saveAdapterConfig']),
    getPreferences: () => invoke('storage.getPreferences') },
  host: { getLaunchContext: () => invoke('host.getLaunchContext'), chooseDirectory: () => invoke('host.chooseDirectory'), chooseFile: options => invoke('host.chooseFile', options),
    openExternal: url => invoke('host.openExternal', url), openView: (entry, context) => invoke('host.openView', entry, context) },
  events: { sessionsChanged: subscribe('sessions.changed'), output: subscribe('sessions.output'), error: subscribe('host.error') }
};
export const conversationApi = {
  call: (method, ...args) => invoke('plugin.invoke', method, args),
  onEvent: subscribe('conversation.event'), onAccount: subscribe('conversation.account')
};
export const adapters = () => invoke('plugin.invoke', 'adapters.list', []);
