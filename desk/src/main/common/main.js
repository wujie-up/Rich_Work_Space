import { translate } from '../../shared/i18n.js';
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdir, readdir, access } from 'node:fs/promises';
import { startupProfile } from './startup-profile.js';
import { monitorPluginViews } from './plugin-views.js';
import { Storage } from './storage.js';
import { Plugins } from './plugins.js';
import { createHandlers, dispatch } from './ipc.js';
import { loadLoginPath, windowOptions, hideOnClose, ensureInstallation } from '../os/index.js';
import { registerPluginProtocol, registerDesktopProtocol } from './plugin-protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
app.setName('DeckPg');
app.commandLine.appendSwitch('site-per-process');
protocol.registerSchemesAsPrivileged(['desk-host', 'desk-plugin'].map((scheme) =>
  ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } })));
const profile = startupProfile(app.getPath('appData'), process.argv);
app.setPath('userData', profile.directory);
let language = 'zh-CN';
const t = (key, parameters) => translate(key, language, parameters);
let window;
let plugins;
let startupReady = false;
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
    if (!profile.testing && !(await ensureInstallation(app))) {
      return;
    }
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
    const storage = new Storage(app.getPath('userData'));
    const emit = (channel, value) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(channel, value);
      }
    };
    const builtins = [];
    const directory = join(root, 'desk/dist/plugins');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && await access(join(directory, entry.name, 'plugin.json')).then(() => true, () => false)) {
        builtins.push(join(directory, entry.name));
      }
    }
    plugins = new Plugins({ storage, builtins, emit });
    const warning = await loadLoginPath();
    await plugins.load();
    registerPluginProtocol(protocol, storage, plugins);
    registerDesktopProtocol(protocol, join(root, 'desk/dist/renderer'), storage, plugins);
    const handlers = createHandlers({ plugins, storage, openExternal: url => shell.openExternal(url), selectFile: async ({ title, extensions }) => {
      const result = await dialog.showOpenDialog(window, { title, properties: ['openFile'], filters: [{ name: title, extensions }] });
      return result.canceled ? null : result.filePaths[0];
    }, selectPackage: async () => {
      const result = await dialog.showOpenDialog(window, { title: t('选择可信 .plg 插件包（插件代码可访问本机）'),
        properties: ['openFile'], filters: [{ name: t('DeckPg 插件'), extensions: ['plg'] }] });
      return result.canceled ? null : result.filePaths[0];
    }, selectDirectory: async (title) => {
      const result = await dialog.showOpenDialog(window, { title: t(title), properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    } });
    const savePreferences = handlers['storage.savePreferences'];
    handlers['storage.savePreferences'] = async (value) => {
      await savePreferences(value);
      if (value.language && value.language !== language) {
        language = value.language;
        updateApplicationMenu();
        console.info('[host:language]', { language });
      }
    };
    handlers['host.info'] = () => ({ version: app.getVersion(), userData: app.getPath('userData'), warning, packaged: app.isPackaged });
    handlers['host.quit'] = () => { requestQuit(); };
    ipcMain.handle('work-desk:invoke', (event, method, args) => dispatch(event, window?.webContents, handlers, method, args));
    language = (await storage.readJson('preferences.json', {})).language || 'zh-CN';
    updateApplicationMenu();
    startupReady = true;
    console.info('[host:startup-ready]', { version: app.getVersion() });
    showWindow();
  }).catch((error) => {
    console.error('[host:startup]', { message: error.message });
    dialog.showErrorBox('DeckPg 启动失败', error.message);
    allowQuit = true;
    app.quit();
  });
}

// Rebuild only native menu labels; desktop windows and plugin processes remain mounted.
function updateApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'DeckPg', submenu: [{ role: 'about', label: t('关于 DeckPg') }, { type: 'separator' },
      { id: 'configuration', label: t('配置…'), accelerator: 'CmdOrCtrl+,', click: openConfiguration },
      { type: 'separator' }, { label: t('退出 DeckPg'), accelerator: 'CmdOrCtrl+Q', click: requestQuit },
      { id: 'force-quit', label: t('强制退出 DeckPg…'), click: requestForceQuit }] },
    { label: t('编辑'), submenu: [
      ...[['undo', '撤销'], ['redo', '重做'], ['cut', '剪切'], ['copy', '复制'], ['paste', '粘贴'], ['selectAll', '全选']]
        .map(([role, label]) => ({ role, label: t(label) }))
    ] }, { label: t('视图'), submenu: [{ role: 'reload', label: t('重新加载') }, { role: 'togglefullscreen', label: t('切换全屏') }] },
    { role: 'windowMenu', label: t('窗口'), submenu: [
      ...[['minimize', '最小化'], ['zoom', '缩放'], ['front', '前置所有窗口'], ['close', '关闭']]
        .map(([role, label]) => ({ role, label: t(label) }))
    ] }
  ]));
}

// macOS activation can arrive while protocols and IPC are still being initialized.
function showWindow() {
  if (!startupReady) {
    return;
  }
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 900, minHeight: 620, title: 'DeckPg',
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
  const result = await dialog.showMessageBox({ type: 'warning', title: t('强制退出 DeckPg'),
    message: t('强制结束 DeckPg 和全部插件进程？'), detail: t('保留已保存配置和历史，未保存内容可能丢失。'),
    buttons: ['取消', '强制退出'].map(key => t(key)), defaultId: 0, cancelId: 0 });
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
    // Stopped snapshots still need archiving, but only active work requires consent.
    if (pending.some(task => !task.exited)) {
      showWindow();
      const result = await dialog.showMessageBox(window, { type: 'warning', title: t('退出 DeckPg'),
        message: t('存在运行中的插件，是否确认关闭所有任务并退出'),
        buttons: ['取消', '关闭任务并退出'].map(key => t(key)), defaultId: 0, cancelId: 0 });
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
    await dialog.showMessageBox(window, { type: 'error', message: t('退出未完成，请重试'), detail: error.message });
  } finally {
    quitPending = false;
  }
}
