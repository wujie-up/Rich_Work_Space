const { contextBridge, ipcRenderer } = require('electron');

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
  plugins: methods('plugins', ['list', 'install', 'start', 'enable', 'preview', 'disable', 'forceDisable', 'close', 'forceClose', 'remove', 'retryCleanup', 'invoke', 'setIcon', 'resetIcon']),
  storage: methods('storage', ['getPreferences', 'savePreferences']),
  host: methods('host', ['chooseDirectory', 'chooseFile', 'openExternal', 'info', 'quit']),
  capabilities: methods('capabilities', ['approve']),
  events: { capabilityApproval: subscribe('capabilities.approval'), configure: subscribe('host.configure'), pluginsChanged: subscribe('plugins.changed'), pluginClosed: subscribe('plugins.closed'), pluginEvent: subscribe('plugins.event'), error: subscribe('host.error') }
});
