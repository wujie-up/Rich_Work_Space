import { el, iconButton, icons } from './ui.js';
import { mountPluginView } from './plugin-view.js';

// The shell owns presentation only; content and compact summary come from the sandboxed provider.
export function mountOverlays(surface, { closePlugin, openWindow, openView }) {
  const layer = el('div', { class: 'desktop-overlays', 'aria-label': '桌面悬浮视图' });
  surface.append(layer);
  const mounted = new Map();
  const failed = new Set();
  let records = [];

  function remove(id) {
    for (const [key, item] of mounted) {
      if (item.plugin.id === id) {
        item.dispose();
        item.root.remove();
        mounted.delete(key);
      }
    }
  }

  function mount(plugin, view) {
    const key = `${plugin.id}:${view.id}`;
    const storageKey = `plugin-overlay:${key}`;
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey));
    } catch {
      saved = null;
    }
    const size = view.presentation;
    const state = { x: Number.isFinite(saved?.x) ? saved.x : layer.clientWidth - size.width,
      y: Number.isFinite(saved?.y) ? saved.y : 0, collapsed: saved?.collapsed === true };
    let touched = typeof saved?.collapsed === 'boolean';
    const root = el('section', { class: 'plugin-overlay', 'data-plugin': plugin.id, 'aria-label': view.title });
    const title = el('span', { class: 'overlay-name', text: view.title });
    const summary = el('span', { class: 'overlay-summary', text: '正在加载…' });
    const header = el('div', { class: 'overlay-title', tabindex: 0, 'aria-label': '移动悬浮面板',
      title: '拖动或使用方向键移动' }, title, summary);
    const body = el('div', { class: 'overlay-body' });
    const save = () => localStorage.setItem(storageKey, JSON.stringify(state));
    let dispose;

    function layout() {
      const width = Math.min(state.collapsed ? size.collapsedWidth : size.width, layer.clientWidth);
      const height = Math.min(state.collapsed ? size.collapsedHeight : size.height, layer.clientHeight);
      state.x = Math.max(0, Math.min(state.x, layer.clientWidth - width));
      state.y = Math.max(0, Math.min(state.y, layer.clientHeight - height));
      Object.assign(root.style, { left: `${state.x}px`, top: `${state.y}px`, width: `${width}px`, height: `${height}px` });
      root.dataset.collapsed = String(state.collapsed);
      body.hidden = state.collapsed;
      minimize.hidden = state.collapsed;
      expand.hidden = !state.collapsed;
      dispose?.send({ type: 'desk:presentation', collapsed: state.collapsed });
    }
    function collapse(value) {
      state.collapsed = value;
      touched = true;
      layout();
      save();
      (value ? expand : minimize).focus();
    }
    const minimize = iconButton(icons.minimize, '收起悬浮面板', () => collapse(true));
    const expand = iconButton('m5 15 7-7 7 7', '展开悬浮面板', () => collapse(false));
    header.append(el('div', { class: 'overlay-actions' },
      ...(!plugin.singleInstance ? [iconButton(icons.open, '在窗口中打开', () => openWindow(plugin, view))] : []), minimize, expand,
      iconButton(icons.close, '关闭悬浮插件', () => closePlugin(plugin.id))));
    let drag;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) {
        return;
      }
      drag = { x: event.clientX, y: event.clientY, left: state.x, top: state.y };
      header.setPointerCapture(event.pointerId);
      header.focus();
    });
    header.addEventListener('pointermove', event => {
      if (drag && header.hasPointerCapture(event.pointerId)) {
        state.x = drag.left + event.clientX - drag.x;
        state.y = drag.top + event.clientY - drag.y;
        layout();
      }
    });
    header.addEventListener('lostpointercapture', () => { drag = null; save(); });
    header.addEventListener('keydown', event => {
      const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
      if (event.target === header && delta) {
        event.preventDefault();
        state.x += delta[0];
        state.y += delta[1];
        layout();
        save();
      }
    });
    root.append(header, body);
    layer.append(root);
    layout();
    dispose = mountPluginView(body, plugin, view, { openView,
      summary: text => { summary.textContent = text; summary.title = text; },
      initialState: collapsed => {
        if (!touched) {
          state.collapsed = collapsed;
          touched = true;
          layout();
          save();
        }
      }, presentation: () => ({ collapsed: state.collapsed })
    });
    mounted.set(key, { plugin, root, dispose, layout, restore: () => collapse(false) });
  }

  function refresh(next) {
    records = next;
    const available = records.filter(plugin => plugin.state === 'enabled' && plugin.running);
    for (const id of failed) {
      if (!available.some(plugin => plugin.id === id)) {
        failed.delete(id);
      }
    }
    for (const item of mounted.values()) {
      if (!available.some(plugin => plugin.id === item.plugin.id)) {
        remove(item.plugin.id);
      }
    }
    for (const plugin of available.filter(plugin => !failed.has(plugin.id))) {
      for (const view of plugin.views.filter(view => view.presentation?.type === 'overlay')) {
        if (!mounted.has(`${plugin.id}:${view.id}`)) {
          mount(plugin, view);
        }
      }
    }
  }
  const observer = new ResizeObserver(() => { mounted.forEach(item => item.layout()); });
  observer.observe(layer);
  return { refresh, close: remove,
    fail(id) { failed.add(id); remove(id); },
    restore(id) {
      failed.delete(id);
      refresh(records);
      const items = [...mounted.values()].filter(item => item.plugin.id === id);
      items.forEach(item => item.restore());
      return items.length > 0;
    },
    destroy() { observer.disconnect(); [...mounted.values()].forEach(item => remove(item.plugin.id)); layer.remove(); } };
}
