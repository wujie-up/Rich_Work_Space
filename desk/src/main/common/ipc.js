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

export function createHandlers({ plugins, storage, selectDirectory, selectPackage }) {
  const handlers = {
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
      const current = await storage.readJson('preferences.json', {});
      return storage.writeJson('preferences.json', { ...current, theme: value.theme, themePreferenceVersion: 1,
        ...(value.gridSize === undefined ? {} : { gridSize: value.gridSize }),
        ...(value.shelfIconSize === undefined ? {} : { shelfIconSize: value.shelfIconSize }) });
    }
  };
  for (const method of ['enable', 'preview', 'disable', 'forceDisable', 'remove', 'retryCleanup']) {
    handlers[`plugins.${method}`] = (...args) => plugins[method](...args);
  }
  handlers['plugins.invoke'] = (id, method, args) => plugins.invoke(id, method, args);
  return handlers;
}
