import { pluginIcon } from './plugin-icon.js';
import { mountPluginView } from './plugin-view.js';
import { api, el, iconButton, modal, toast } from './ui.js';

// Host metadata stays outside the plugin frame so custom content cannot replace it.
export async function openPluginSettings(id) {
  let disposed = false;
  let unmount;
  let offChanged;
  let offClosed;
  let mountedEntry;
  try {
    await modal('插件配置', ({ body, dialog, finish }) => {
      dialog.classList.add('plugin-settings');
      const metadata = el('div', { class: 'plugin-settings-metadata' });
      const content = el('div', { class: 'plugin-settings-content' });
      body.append(metadata, content);
      const refresh = async () => {
        const plugin = (await api.plugins.list()).find(record => record.id === id && record.state !== 'uninstalled');
        if (disposed) {
          return;
        }
        if (!plugin) {
          finish(null);
          return;
        }
        const author = typeof plugin.author === 'string' ? plugin.author : plugin.author?.name;
        metadata.replaceChildren(el('div', { class: 'plugin-settings-icon' }, pluginIcon(plugin),
          iconButton('m15 5 4 4M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15Z', '修改图标', () => api.plugins.setIcon(id))),
        el('div', {}, el('h2', { text: plugin.name }), el('p', { class: 'muted', text: `${plugin.id} · v${plugin.version}` }),
          el('p', {}, '作者：', author || '未提供')));
        const entry = plugin.state === 'enabled' && !plugin.operation ? plugin.settings?.entry : undefined;
        if (entry && entry === mountedEntry) {
          return;
        }
        unmount?.();
        unmount = undefined;
        mountedEntry = entry;
        content.classList.remove('plugin-container');
        content.replaceChildren();
        if (entry) {
          unmount = mountPluginView(content, plugin, { entry, title: `${plugin.name} 配置` });
        } else if (plugin.settings) {
          content.append(el('p', { class: 'muted', text: '启用插件后可设置。' }));
        }
      };
      offChanged = api.events.pluginsChanged(() => refresh().catch(error => toast(error.message)));
      offClosed = api.events.pluginClosed(event => {
        if (event.pluginId === id) {
          finish(null);
        }
      });
      refresh().catch(error => { toast(error.message); finish(null); });
    });
  } finally {
    disposed = true;
    offChanged?.();
    offClosed?.();
    unmount?.();
  }
}
