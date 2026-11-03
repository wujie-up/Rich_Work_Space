const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(method, ...args) {
  const result = await ipcRenderer.invoke('work-desk:invoke', method, args);
  if (!result.ok) {
    throw Object.assign(new Error(result.error.message), result.error);
  }
  return result.value;
}
const methods = (group, names) => Object.fromEntries(names.map((name) => [name, (...args) => invoke(`${group}.${name}`, ...args)]));
const subscribe = (channel) => (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('workDesk', {
  plugins: methods('plugins', ['list', 'install', 'upgrade', 'checkUpdates', 'scanUpdates', 'configureUpdates', 'upgradeLatest', 'start', 'enable', 'preview', 'disable', 'forceDisable', 'close', 'forceClose', 'remove', 'retryCleanup', 'invoke', 'setIcon', 'resetIcon', 'setMultipleWindows', 'setAutoStart']),
  desktop: { ...methods('desktop', ['list', 'read', 'create', 'import', 'resolve', 'openExternal', 'rename', 'trash', 'properties', 'copy', 'paste']), pathForFile: file => webUtils.getPathForFile(file) },
  web: methods('web', ['status', 'configure', 'listAccounts', 'saveAccount', 'removeAccount']),
  storage: methods('storage', ['getPreferences', 'savePreferences']),
  host: methods('host', ['chooseDirectory', 'chooseFile', 'readClipboardFiles', 'openExternal', 'info', 'quit']),
  messages: methods('messages', ['list', 'respond', 'defer']),
  capabilities: methods('capabilities', ['approve']),
  events: { messagesChanged: subscribe('messages.changed'), capabilityApproval: subscribe('capabilities.approval'), configure: subscribe('host.configure'), pluginsChanged: subscribe('plugins.changed'), pluginClosed: subscribe('plugins.closed'), pluginEvent: subscribe('plugins.event'), error: subscribe('host.error') }
});
