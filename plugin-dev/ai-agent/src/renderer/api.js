import { pluginHostOrigin, pluginIdentity } from '../../../../desk/src/resource/plugin-host.js';
const hostOrigin = pluginHostOrigin();
const owner = pluginIdentity();
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
  window.parent.postMessage({ type: 'desk:invoke', id, method, args }, hostOrigin);
});
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== hostOrigin) {
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
  groups: methods('groups', ['create', 'assign', 'rename', 'delete', 'archive']),
  sessions: methods('sessions', ['transcript', 'list', 'setTheme', 'create', 'write', 'composer', 'saveImage', 'fileReferences', 'resize', 'rename', 'archive', 'attach', 'attachWindow', 'readArchive', 'restore', 'recover', 'reconnect', 'resetContext', 'fork',
    'delete', 'deleteArchive', 'updateArchiveDirectory', 'gitInfo', 'refreshGit', 'switchBranch']),
  storage: { ...methods('storage', ['getLayout', 'saveLayout', 'getAdapterConfig', 'saveAdapterConfig', 'getRoles', 'saveRoles']),
    getPreferences: () => invoke('storage.getPreferences') },
  host: { getWindowContext: () => invoke('host.getWindowContext'), getLaunchContext: () => invoke('host.getLaunchContext'),
    listWindows: () => invoke('host.listWindows'),
    chooseDirectory: options => invoke('host.chooseDirectory', options), chooseFile: options => invoke('host.chooseFile', options),
    openExternal: url => invoke('host.openExternal', url), openView: (entry, context) => invoke('host.openView', entry, context) },
  events: { sessionsChanged: subscribe('sessions.changed'), output: subscribe('sessions.output'), error: subscribe('host.error') }
};
export const conversationApi = {
  call: (method, ...args) => invoke('plugin.invoke', method, args),
  onEvent: subscribe('conversation.event'), onAccount: subscribe('conversation.account'), onAppearance: subscribe('appearance.changed')
};
export const adapters = () => invoke('plugin.invoke', 'adapters.list', []);
