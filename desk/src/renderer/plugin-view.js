import { api, el, toast } from './ui.js';

// The source frame determines ownership; a plugin cannot supply another plugin's ID.
export function mountPluginView(root, plugin, view, { focused } = {}) {
  const origin = `desk-plugin://${plugin.id}`;
  const frame = el('iframe', { src: `${origin}/${view.entry}`, title: view.title,
    sandbox: 'allow-scripts allow-same-origin', class: 'plugin-view' });
  const send = (value) => frame.contentWindow?.postMessage(value, origin);
  const receive = async (event) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) {
      return;
    }
    if (event.data?.type === 'desk:focus') {
      focused?.();
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
      } else if (method === 'host.chooseDirectory') {
        value = await api.host.chooseDirectory();
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
  window.addEventListener('message', receive);
  const off = api.events.pluginEvent((event) => {
    if (event.pluginId === plugin.id) {
      send({ type: 'desk:event', ...event });
    }
  });
  const theme = () => send({ type: 'desk:theme', theme: document.documentElement.dataset.theme });
  window.addEventListener('desk-theme', theme);
  frame.addEventListener('error', () => toast(`${view.title} 视图加载失败，可重新打开`));
  root.classList.add('plugin-container');
  root.replaceChildren(frame);
  return () => {
    off();
    window.removeEventListener('message', receive);
    window.removeEventListener('desk-theme', theme);
    frame.remove();
  };
}
