import { app, BrowserWindow, ipcMain, dialog, Menu, protocol } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdir, readdir, access } from 'node:fs/promises';
import { monitorPluginViews } from './plugin-views.js';
import { Storage } from './storage.js';
import { Plugins } from './plugins.js';
import { createHandlers, dispatch } from './ipc.js';
import { loadLoginPath, windowOptions, hideOnClose } from '../os/index.js';
import { registerPluginProtocol, registerDesktopProtocol } from './plugin-protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
app.setName('Work Desk');
app.commandLine.appendSwitch('site-per-process');
protocol.registerSchemesAsPrivileged(['desk-host', 'desk-plugin'].map((scheme) =>
  ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } })));
// A separate data directory also permits safe integration tests of the packaged app.
const requestedData = process.argv.find((arg) => arg.startsWith('--desk-data='))?.slice(12);
if (requestedData) {
  app.setPath('userData', requestedData);
}
let window;
let plugins;
let allowQuit = false;
let quitPending = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (!allowQuit && plugins) {
      event.preventDefault();
      requestQuit();
    }
  });
  // Electron waits for the ESM entry to finish before ready; do not top-level-await ready itself.
  app.whenReady().then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
    const storage = new Storage(app.getPath('userData'));
    const emit = (channel, value) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(channel, value);
      }
    };
    const builtins = [];
    const directory = join(root, 'plugins/plugins');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && await access(join(directory, entry.name, 'plugin.json')).then(() => true, () => false)) {
        builtins.push(join(directory, entry.name));
      }
    }
    plugins = new Plugins({ storage, builtins, emit });
    const warning = await loadLoginPath();
    await plugins.load();
    registerPluginProtocol(protocol, storage, plugins);
    registerDesktopProtocol(protocol, join(root, 'desk/dist/renderer'));
    const handlers = createHandlers({ plugins, storage, selectPackage: async () => {
      const result = await dialog.showOpenDialog(window, { title: '选择可信 .plg 插件包（插件代码可访问本机）',
        properties: ['openFile'], filters: [{ name: 'Work Desk 插件', extensions: ['plg'] }] });
      return result.canceled ? null : result.filePaths[0];
    }, selectDirectory: async (title) => {
      const result = await dialog.showOpenDialog(window, { title, properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    } });
    handlers['host.info'] = () => ({ version: app.getVersion(), userData: app.getPath('userData'), warning, packaged: app.isPackaged });
    handlers['host.quit'] = () => { requestQuit(); };
    ipcMain.handle('work-desk:invoke', (event, method, args) => dispatch(event, window?.webContents, handlers, method, args));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Work Desk', submenu: [{ role: 'about' }, { type: 'separator' },
        { id: 'configuration', label: '配置…', accelerator: 'CmdOrCtrl+,', click: openConfiguration },
        { type: 'separator' }, { label: '退出 Work Desk', accelerator: 'CmdOrCtrl+Q', click: requestQuit },
        { id: 'force-quit', label: '强制退出 Work Desk…', click: requestForceQuit }] },
      { role: 'editMenu' }, { label: '视图', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' }
    ]));
    showWindow();
  }).catch((error) => {
    console.error('[host:startup]', { message: error.message });
    dialog.showErrorBox('Work Desk 启动失败', error.message);
    allowQuit = true;
    app.quit();
  });
}

function showWindow() {
  if (!app.isReady()) {
    return;
  }
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 620, title: 'Work Desk',
    backgroundColor: '#181818', ...windowOptions,
    webPreferences: { preload: join(root, 'desk/src/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  monitorPluginViews(app, window.webContents, (id, error) => {
    const record = plugins.record(id);
    record.lastError = { ...error, stage: 'view' };
    console.error('[plugin:view-crashed]', { pluginId: id, ...error });
    plugins.persist().catch((error) => console.error('[plugin:registry]', { pluginId: id, message: error.message }));
    window.webContents.send('host.error', { pluginId: id, ...error });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (hideOnClose && !allowQuit) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => { window = null; });
  window.loadURL('desk-host://desktop/index.html');
}

// Menu actions also work after the macOS close button has hidden the window.
function openConfiguration() {
  showWindow();
  console.info('[host:configuration-open]');
  window.webContents.send('host.configure');
}

// The emergency path is independent of a pending normal quit and renderer responsiveness.
async function requestForceQuit() {
  const result = await dialog.showMessageBox({ type: 'warning', title: '强制退出 Work Desk',
    message: '强制结束 Work Desk 和全部插件进程？', detail: '保留已保存配置和历史，未保存内容可能丢失。',
    buttons: ['取消', '强制退出'], defaultId: 0, cancelId: 0 });
  if (result.response !== 1) {
    return;
  }
  console.info('[host:force-quit]', { pid: process.pid });
  allowQuit = true;
  // app.exit bypasses before-quit and window close vetoes even if cleanup does not settle.
  const deadline = setTimeout(() => app.exit(0), 2000);
  try {
    await plugins.forceQuit();
  } finally {
    clearTimeout(deadline);
    app.exit(0);
  }
}

// Quit holds the same launch gate as plugin transitions, including failed archives.
async function requestQuit() {
  if (quitPending) {
    return;
  }
  quitPending = true;
  try {
    const pending = await plugins.prepareQuit();
    if (pending.length) {
      showWindow();
      const result = await dialog.showMessageBox(window, { type: 'warning', title: '退出 Work Desk',
        message: `关闭 ${pending.length} 个插件任务后退出？`,
        detail: pending.map((s) => `${s.name}${s.exited ? '（已停止，待归档）' : ''}`).join('\n'),
        buttons: ['取消', '关闭任务并退出'], defaultId: 0, cancelId: 0 });
      if (result.response === 0) {
        plugins.cancelQuit();
        return;
      }
    }
    await plugins.confirmQuit();
    allowQuit = true;
    app.quit();
  } catch (error) {
    if (allowQuit) {
      return;
    }
    plugins.cancelQuit();
    console.error('[host:quit]', { code: error.code, message: error.message });
    showWindow();
    await dialog.showMessageBox(window, { type: 'error', message: '退出未完成，请重试', detail: error.message });
  } finally {
    quitPending = false;
  }
}
