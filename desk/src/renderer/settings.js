import { el, button, run } from './ui.js';
import { mountPlugins } from './plugins.js';

export function mountSettings(openPlugin, toggleTheme, version, desktop) {
  const previous = document.activeElement;
  const panel = el('section', { id: 'settings-panel', role: 'dialog', 'aria-label': '配置' });
  const body = el('div', { class: 'settings-body' });
  const layouts = el('div', { class: 'layout-options', 'aria-label': '插件展示方式' });
  let dispose;
  let generation = 0;
  const close = () => {
    generation++;
    dispose?.();
    panel.remove();
    document.removeEventListener('keydown', escape);
    if (previous.isConnected) {
      previous.focus();
    }
  };
  const escape = (event) => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      close();
    }
  };
  const tab = async (id) => {
    const current = ++generation;
    dispose?.();
    dispose = null;
    // Each asynchronous tab owns its root, preventing late plugin responses from replacing the theme tab.
    const view = el('div');
    body.replaceChildren(view);
    panel.querySelectorAll('.settings-tabs button').forEach((node) => node.classList.toggle('selected', node.id === id));
    layouts.hidden = id !== 'plugin-center';
    if (id === 'plugin-center') {
      const cleanup = await mountPlugins(view, (pluginId) => { close(); openPlugin(pluginId); });
      if (current !== generation) {
        cleanup();
        return;
      }
      dispose = cleanup;
    } else if (id === 'desktop-settings') {
      const names = el('input', { type: 'checkbox', 'aria-label': '显示插件名称' });
      names.checked = desktop.shelfNames;
      names.addEventListener('change', () => run(async () => {
        names.disabled = true;
        try {
          await desktop.save({ shelfNames: names.checked });
          desktop.shelfNames = names.checked;
        } finally {
          names.checked = desktop.shelfNames;
          names.disabled = false;
        }
      }));
      const sizeControl = (label, key, sizes) => {
        const control = el('select', { 'aria-label': label });
        sizes.forEach(size => control.append(el('option', { value: size, text: `${size} px` })));
        control.value = desktop[key];
        control.addEventListener('change', () => run(async () => {
          control.disabled = true;
          try {
            await desktop.save({ [key]: Number(control.value) });
            desktop[key] = Number(control.value);
          } finally {
            control.value = desktop[key];
            control.disabled = false;
          }
        }));
        return el('label', { class: 'field' }, el('span', { text: label }), control);
      };
      view.append(el('h1', { text: '桌面' }),
        el('p', { class: 'muted', text: '窗口移动与缩放按隐形网格对齐，操作时显示辅助线。' }),
        sizeControl('网格大小', 'gridSize', [16, 24, 32, 40, 48]),
        sizeControl('插件图标大小', 'shelfIconSize', [24, 36, 48]),
        el('label', { class: 'shelf-names-setting' }, names, el('span', { text: '显示插件名称' })),
        el('p', { class: 'muted', text: '左侧插件按网格排列，拉宽插件栏可自动换行。' }));
    } else {
      const theme = el('select', { id: 'theme-mode', 'aria-label': '外观' },
        ...[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, text]) => el('option', { value, text })));
      theme.value = desktop.theme;
      theme.addEventListener('change', () => run(async () => {
        await toggleTheme(theme.value);
        desktop.theme = theme.value;
      }));
      view.append(el('h1', { text: '主题' }), el('p', { class: 'muted', text: '跟随当前系统外观，或手动选择黑白主题。' }),
        el('label', { class: 'field' }, el('span', { text: '外观' }), theme),
        button('切换黑白主题', () => toggleTheme().then(() => {
          desktop.theme = document.documentElement.dataset.theme;
          theme.value = desktop.theme;
        })));
      view.querySelector('button').id = 'theme';
    }
  };
  const selectLayout = (layout) => {
    localStorage.setItem('plugin-layout', layout);
    const list = body.querySelector('.plugin-grid');
    if (list) {
      list.dataset.layout = layout;
    }
    layouts.querySelectorAll('button').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.layout === layout)));
  };
  for (const [layout, symbol, label] of [['list', '☰', '列表展示'], ['grid', '▦', '图框展示']]) {
    const control = button(symbol, () => selectLayout(layout), 'layout-icon');
    control.dataset.layout = layout;
    control.setAttribute('aria-label', label);
    control.title = label;
    layouts.append(control);
  }
  selectLayout(localStorage.getItem('plugin-layout') === 'list' ? 'list' : 'grid');
  const plugins = button('插件', () => tab('plugin-center'));
  plugins.id = 'plugin-center';
  const theme = button('主题', () => tab('theme-settings'));
  theme.id = 'theme-settings';
  const desk = button('桌面', () => tab('desktop-settings'));
  desk.id = 'desktop-settings';
  const exit = button('×', close, 'icon');
  exit.setAttribute('aria-label', '关闭配置');
  panel.append(el('div', { class: 'dialog-heading' }, el('h2', { text: '配置' }), exit),
    el('div', { class: 'settings-tabs' }, plugins, desk, theme, layouts), body,
    el('div', { class: 'settings-footer', text: `${version} · 拖动已启用的插件到桌面打开` }));
  document.body.append(panel);
  document.addEventListener('keydown', escape);
  exit.focus();
  run(() => tab('plugin-center'));
  return close;
}
