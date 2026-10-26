import { el, button, iconButton, run } from './ui.js';
import { mountPlugins } from './plugins.js';

// Keep native selection and keyboard behavior while animating only the decorative arrow.
function selectControl(control) {
  return el('span', { class: 'settings-select' }, control, el('span', { class: 'select-arrow', 'aria-hidden': 'true' }));
}

export function mountSettings(openPlugin, toggleTheme, desktop) {
  const previous = document.activeElement;
  const panel = el('section', { id: 'settings-panel', role: 'dialog', 'aria-label-message': '配置' });
  const body = el('div', { class: 'settings-body' });
  const layouts = el('div', { class: 'layout-options', 'aria-label-message': '插件展示方式' });
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
    if (id === 'plugin-center') {
      const cleanup = await mountPlugins(view, (pluginId) => { close(); openPlugin(pluginId); }, layouts);
      if (current !== generation) {
        cleanup();
        return;
      }
      dispose = cleanup;
    } else if (id === 'desktop-settings') {
      const names = el('input', { type: 'checkbox', 'aria-label-message': '显示插件名称' });
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
        const control = el('select', { 'aria-label-message': label });
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
        return el('label', { class: 'field' }, el('span', { message: label }), selectControl(control));
      };
      view.append(sizeControl('网格大小', 'gridSize', [16, 24, 32, 40, 48]),
        sizeControl('插件图标大小', 'shelfIconSize', [24, 36, 48]),
        el('label', { class: 'shelf-names-setting' }, names, el('span', { message: '显示插件名称' })));
    } else {
      const theme = el('select', { id: 'theme-mode', 'aria-label-message': '外观' },
        ...[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([value, text]) => el('option', { value, message: text })));
      theme.value = desktop.theme;
      theme.addEventListener('change', () => run(async () => {
        await toggleTheme(theme.value);
        desktop.theme = theme.value;
      }));
      view.append(el('label', { class: 'field' }, el('span', { message: '外观' }), selectControl(theme)));
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
  for (const [layout, path, label] of [
    ['list', 'M4 6h16M4 12h16M4 18h16', '列表展示'],
    ['grid', 'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z', '图框展示']
  ]) {
    const control = iconButton(path, label, () => selectLayout(layout));
    control.dataset.layout = layout;
    layouts.append(control);
  }
  selectLayout(localStorage.getItem('plugin-layout') === 'list' ? 'list' : 'grid');
  const plugins = button('插件', () => tab('plugin-center'));
  plugins.id = 'plugin-center';
  const theme = button('主题', () => tab('theme-settings'));
  theme.id = 'theme-settings';
  const desk = button('桌面', () => tab('desktop-settings'));
  desk.id = 'desktop-settings';
  const exit = iconButton('m6 6 12 12M18 6 6 18', '关闭配置', close);
  exit.classList.add('settings-close');
  panel.append(el('div', { class: 'settings-tabs' }, plugins, desk, theme, exit), body);
  document.body.append(panel);
  document.addEventListener('keydown', escape);
  exit.focus();
  run(() => tab('plugin-center'));
  return close;
}
