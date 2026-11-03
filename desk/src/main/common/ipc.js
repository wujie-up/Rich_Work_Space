import { basename } from 'node:path';
import { DesktopFiles } from './desktop-files.js';
import { PluginIcons } from './plugin-icons.js';
import { PluginUpdates } from './plugin-updates.js';
import { fail } from '../../shared/contracts.js';

const nativeHandler = Symbol('nativeHandler');

// One handler owns sender validation; the preload exposes named methods only.
export async function dispatch(event, webContents, handlers, method, args) {
  try {
    if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame || !Object.hasOwn(handlers, method)) {
      throw fail('IPC_FORBIDDEN', '拒绝未授权的 IPC 调用');
    }
    if (!Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) {
      throw fail('INVALID_ARGUMENT', '请求参数无效或过大');
    }
    return { ok: true, value: await (handlers[method][nativeHandler] || handlers[method])(...args) };
  } catch (error) {
    return { ok: false, error: { code: error.code || 'HOST_ERROR', message: error.message, details: error.details } };
  }
}

export function createHandlers({ plugins, storage, selectDirectory, selectPackage, selectFile, openExternal, openPath, trashItem, fileClipboard, updates = new PluginUpdates({ storage, plugins }) }) {
  const icons = new PluginIcons(storage, plugins);
  const desktop = new DesktopFiles(storage);
  const handlers = {
    'desktop.list': () => desktop.list(),
    'desktop.read': name => desktop.read(name),
    'desktop.properties': name => desktop.properties(name),
    'desktop.copy': async name => {
      await fileClipboard.write([await desktop.resolve(name)]);
      console.info('[desktop:file-copied]', { name });
    },
    'desktop.paste': async () => {
      const paths = await fileClipboard.read();
      return paths.length ? desktop.import(paths) : [];
    },
    'desktop.rename': (name, nextName) => desktop.rename(name, nextName),
    'desktop.trash': async name => {
      await trashItem(await desktop.resolve(name));
      console.info('[desktop:file-trashed]', { name });
    },
    'desktop.create': name => desktop.create(name),
    'desktop.import': paths => desktop.import(paths),
    'desktop.resolve': name => desktop.resolve(name),
    'desktop.openExternal': async name => {
      const error = await openPath(await desktop.resolve(name));
      if (error) {
        throw fail('FILE_OPEN_FAILED', error);
      }
    },
    'host.openExternal': async value => {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw fail('INVALID_ARGUMENT', '只支持在浏览器打开无内嵌凭据的网页地址');
      }
      await openExternal(url.href);
    },
    // Reading references must not import or copy the original files into desktop storage.
    'host.readClipboardFiles': async () => {
      try {
        return await fileClipboard.read();
      } catch (error) {
        console.error('[host:clipboard-files]', { method: 'host.readClipboardFiles', stack: error.stack });
        throw fail('CLIPBOARD_READ_FAILED', '无法读取剪贴板中的文件');
      }
    },
    'messages.list': () => plugins.capabilities.messages.list(),
    'messages.respond': (id, answer) => plugins.capabilities.messages.respond(id, answer),
    'messages.defer': id => plugins.capabilities.messages.defer(id),
    'capabilities.approve': (id, allowed) => {
      if (typeof allowed !== 'boolean') { throw fail('INVALID_ARGUMENT', '确认参数无效'); }
      return plugins.capabilities.approve(id, allowed);
    },
    'plugins.setIcon': async id => {
      const path = await selectFile({ title: '选择插件图标', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] });
      if (path) { await icons.set(id, path); }
    },
    'plugins.resetIcon': id => icons.reset(id),
    'host.chooseFile': (options = {}) => {
      if (!Array.isArray(options.extensions) || options.extensions.length > 8
        || options.extensions.some(value => !/^[a-z0-9]{1,8}$/.test(value)) || typeof options.title !== 'string' || options.title.length > 100
        || (options.showHiddenFiles !== undefined && typeof options.showHiddenFiles !== 'boolean')) {
        throw fail('INVALID_ARGUMENT', '文件选择参数无效');
      }
      return selectFile(options);
    },
    'plugins.upgrade': (id, source, token) => plugins.upgrade(id, source, token),
    'plugins.checkUpdates': () => updates.snapshot(),
    'plugins.scanUpdates': () => updates.scan(),
    'plugins.configureUpdates': directory => updates.configure(directory),
    'plugins.upgradeLatest': (id, version, token) => updates.upgrade(id, version, token),
    'plugins.setAutoStart': (id, enabled) => plugins.setAutoStart(id, enabled),
    'plugins.setMultipleWindows': (id, allowed) => plugins.setMultipleWindows(id, allowed),
    'plugins.list': () => plugins.list(),
    'plugins.install': async () => {
      const paths = await selectPackage();
      const failures = [];
      // Each archive keeps its existing validation and isolation; one failure must not skip the remaining selection.
      for (const path of paths) {
        try {
          await plugins.install(path);
        } catch (error) {
          console.error('[plugin:import]', { package: basename(path), message: error.message });
          failures.push(`${basename(path)}: ${error.message}`);
        }
      }
      if (failures.length) {
        throw fail('PLUGIN_IMPORT_FAILED', failures.join('；'));
      }
    },
    'host.chooseDirectory': (options = {}) => {
      if ((options.defaultPath !== undefined && typeof options.defaultPath !== 'string') ||
        (options.showHiddenFiles !== undefined && typeof options.showHiddenFiles !== 'boolean')) {
        throw fail('INVALID_ARGUMENT', '目录选择参数无效');
      }
      return selectDirectory('选择工作目录', options.defaultPath || undefined, options.showHiddenFiles === true);
    },
    'storage.getPreferences': async () => {
      const preferences = await storage.readJson('preferences.json', {});
      // Earlier releases persisted a fixed default; upgrades adopt system appearance until the user chooses again.
      return { ...preferences, theme: preferences.themePreferenceVersion === 1 ? preferences.theme : 'system' };
    },
    'storage.savePreferences': async (value) => {
      if (!['system', 'light', 'dark'].includes(value.theme)) {
        throw fail('INVALID_ARGUMENT', '主题无效');
      }
      if (value.gridSize !== undefined && ![16, 24, 32, 40, 48].includes(value.gridSize)) {
        throw fail('INVALID_ARGUMENT', '网格大小无效');
      }
      if (value.shelfIconSize !== undefined && ![24, 36, 48].includes(value.shelfIconSize)) {
        throw fail('INVALID_ARGUMENT', '插件图标大小无效');
      }
      if (value.language !== undefined && !['zh-CN', 'en'].includes(value.language)) {
        throw fail('INVALID_ARGUMENT', '语言无效');
      }
      const current = await storage.readJson('preferences.json', {});
      return storage.writeJson('preferences.json', { ...current, theme: value.theme, themePreferenceVersion: 1,
        ...(value.language === undefined ? {} : { language: value.language }),
        ...(value.gridSize === undefined ? {} : { gridSize: value.gridSize }),
        ...(value.shelfIconSize === undefined ? {} : { shelfIconSize: value.shelfIconSize }) });
    }
  };
  for (const method of ['start', 'enable', 'preview', 'disable', 'forceDisable', 'close', 'forceClose', 'remove', 'retryCleanup']) {
    handlers[`plugins.${method}`] = (...args) => plugins[method](...args);
  }
  handlers['plugins.invoke'] = (id, method, args) => plugins.invoke(id, method, args);
  // This function is reachable only after dispatch validates the native top-level sender.
  handlers['plugins.invoke'][nativeHandler] = (id, method, args) =>
    plugins.invoke(id, method, args, { origin: 'native', chain: [id], deadline: Date.now() + 30_000 });
  return handlers;
}
