import { api, el, toast } from './ui.js';
import { PluginEvents } from './plugin-events.js';
import { chooseDesktopFile } from './desktop-files.js';

const events = new PluginEvents(window, listener => api.events.pluginEvent(listener));

// The source frame determines ownership; a plugin cannot supply another plugin's ID.
export function mountPluginView(root, plugin, view, { focused, summary, initialState, presentation, openView, windowContext, listWindows } = {}) {
  const origin = api.host.pluginOrigin?.(plugin) || `desk-plugin://${plugin.id}`;
  const frame = el('iframe', { src: `${origin}/${view.entry}${api.host.browser ? `${view.entry.includes('?') ? '&' : '?'}deskPlugin=${encodeURIComponent(plugin.id)}` : ''}`, title: view.title,
    sandbox: 'allow-scripts allow-same-origin', allow: 'fullscreen', class: 'plugin-view' });
  const send = (value) => frame.contentWindow?.postMessage(value, origin);
  let launchContext = view.launchContext || null;
  let launchContextRead = false;
  const receive = async (event) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) {
      return;
    }
    if (event.data?.type === 'desk:visibility-ready') {
      visibility();
      return;
    }
    if (event.data?.type === 'desk:focus') {
      focused?.();
      return;
    }
    if (event.data?.type === 'desk:overlay-summary' && typeof event.data.text === 'string' && event.data.text.length <= 240) {
      summary?.(event.data.text);
      return;
    }
    if (event.data?.type === 'desk:overlay-state' && typeof event.data.defaultCollapsed === 'boolean') {
      initialState?.(event.data.defaultCollapsed);
      return;
    }
    if (event.data?.type !== 'desk:invoke') {
      return;
    }
    const { id, method, args } = event.data;
    try {
      if (!Array.isArray(args)) {
        throw Error('插件请求参数无效');
      }
      let value;
      if (method === 'plugin.invoke') {
        value = await api.plugins.invoke(plugin.id, ...args);
      } else if (method === 'host.getLaunchContext') {
        launchContextRead = true;
        value = launchContext;
      } else if (method === 'host.getWindowContext') {
        value = windowContext?.() || null;
      } else if (method === 'host.listWindows') {
        value = listWindows?.() || [];
      } else if (method === 'host.openView' && openView) {
        value = await openView(...args);
      } else if (method === 'host.chooseDirectory') {
        value = await api.host.chooseDirectory(args[0]);
      } else if (method === 'host.chooseFile') {
        value = await api.host.chooseFile(args[0]);
      } else if (method === 'host.readClipboardFiles') {
        if (!api.host.readClipboardFiles) {
          throw Error('当前工作台不支持读取本地剪贴板文件');
        }
        value = await api.host.readClipboardFiles();
      } else if (method === 'host.chooseDesktopFile') {
        value = await chooseDesktopFile();
      } else if (method === 'host.openExternal') {
        value = await api.host.openExternal(args[0]);
      } else if (method === 'storage.getPreferences') {
        // Plugins receive the resolved color so the existing light/dark contract remains unchanged.
        value = { ...await api.storage.getPreferences(), theme: document.documentElement.dataset.theme };
      } else {
        throw Error('插件视图无权调用此宿主方法');
      }
      send({ type: 'desk:result', id, value });
    } catch (error) {
      send({ type: 'desk:result', id, error: { code: error.code, message: error.message } });
    }
  };
  let visible = true;
  const visibility = () => send({ type: 'desk:visibility', visible: visible && !document.hidden });
  document.addEventListener('visibilitychange', visibility);
  const theme = () => send({ type: 'desk:theme', theme: document.documentElement.dataset.theme, language: document.documentElement.lang });
  window.addEventListener('desk-theme', theme);
  frame.addEventListener('load', () => {
    theme();
    visibility();
    if (presentation) {
      send({ type: 'desk:presentation', ...presentation() });
    }
  });
  frame.addEventListener('error', () => toast(`${view.title} 视图加载失败，可重新打开`));
  root.classList.add('plugin-container');
  root.replaceChildren(frame);
  const off = events.add(frame.contentWindow, plugin.id, receive, send, origin);
  const dispose = () => {
    off();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('desk-theme', theme);
    frame.remove();
  };
  dispose.send = send;
  // Before initialization reads the context, retain the latest request instead of sending an event it could miss.
  dispose.setLaunchContext = value => {
    launchContext = value;
    if (launchContextRead) {
      send({ type: 'desk:launch', context: launchContext });
    }
  };
  dispose.setVisible = value => {
    if (visible !== value) {
      visible = value;
      visibility();
    }
  };
  return dispose;
}
