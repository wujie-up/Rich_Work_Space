import { PluginIcons } from './plugin-icons.js';
import { fail } from '../../shared/contracts.js';

// One handler owns sender validation; the preload exposes named methods only.
export async function dispatch(event, webContents, handlers, method, args) {
  try {
    if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame || !Object.hasOwn(handlers, method)) {
      throw fail('IPC_FORBIDDEN', '拒绝未授权的 IPC 调用');
    }
    if (!Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) {
      throw fail('INVALID_ARGUMENT', '请求参数无效或过大');
    }
    return { ok: true, value: await handlers[method](...args) };
  } catch (error) {
    return { ok: false, error: { code: error.code || 'HOST_ERROR', message: error.message, details: error.details } };
  }
}

export function createHandlers({ plugins, storage, selectDirectory, selectPackage, selectFile, openExternal }) {
  const icons = new PluginIcons(storage, plugins);
  const handlers = {
    'host.openExternal': async value => {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw fail('INVALID_ARGUMENT', '只支持在浏览器打开无内嵌凭据的网页地址');
      }
      await openExternal(url.href);
    },
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
        || options.extensions.some(value => !/^[a-z0-9]{1,8}$/.test(value)) || typeof options.title !== 'string' || options.title.length > 100) {
        throw fail('INVALID_ARGUMENT', '文件选择参数无效');
      }
      return selectFile(options);
    },
    'plugins.list': () => plugins.list(),
    'plugins.install': async () => {
      const path = await selectPackage();
      return path ? plugins.install(path) : null;
    },
    'host.chooseDirectory': () => selectDirectory('选择工作目录'),
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
  return handlers;
}
