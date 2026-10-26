import { t } from './i18n.js';
import { el, ask, iconButton, icons } from './ui.js';
import { mountPluginView } from './plugin-view.js';
import { contextMenu } from './launcher.js';

// The desktop owns tab layout; plugin state stays inside its retained sandbox frame.
export function mountWindows(stage, { openPlugin, closePlugin, openView, changed = () => {} }) {
  const windows = new Map();
  const tabs = el('div', { class: 'window-tabs', role: 'tablist', 'aria-label-message': '插件窗口' });
  stage.append(tabs);
  let sequence = 0;
  let layer = 0;
  const notify = () => changed([...windows.values()].find(view => view.root.dataset.phase === 'open'));

  // Switching only hides retained frames; plugin documents and shared tasks stay alive.
  function focus(view) {
    // Launchers reuse this ordering to restore the most recently used page.
    view.layer = ++layer;
    windows.forEach(item => {
      item.root.style.visibility = item === view ? 'visible' : 'hidden';
      item.root.setAttribute('aria-hidden', String(item !== view));
      item.root.inert = item !== view;
      item.root.dataset.phase = item === view ? 'open' : 'inactive';
      item.root.classList.toggle('focused', item === view);
      item.tab.setAttribute('aria-selected', String(item === view));
      item.tab.tabIndex = item === view ? 0 : -1;
    });
    view.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    notify();
  }

  function home() {
    windows.forEach(view => {
      view.root.style.visibility = 'hidden';
      view.root.setAttribute('aria-hidden', 'true');
      view.root.inert = true;
      view.root.dataset.phase = 'inactive';
      view.root.classList.remove('focused');
      view.tab.setAttribute('aria-selected', 'false');
    });
    notify();
  }

  function selectTab(view, event) {
    const items = [...windows.values()];
    const index = items.indexOf(view);
    const next = { ArrowLeft: items[(index + items.length - 1) % items.length], ArrowRight: items[(index + 1) % items.length],
      Home: items[0], End: items.at(-1) }[event.key];
    if (event.target !== view.tab || !next) {
      return;
    }
    event.preventDefault();
    focus(next);
    next.tab.focus();
  }

  // Ordinals count surviving instances of each plugin, while frame IDs remain stable.
  function renumber() {
    const counts = new Map();
    windows.forEach(view => {
      const count = (counts.get(view.plugin.id) || 0) + 1;
      counts.set(view.plugin.id, count);
      const label = view.label || t('窗口{count}', { count });
      view.root.setAttribute('aria-label', label);
      view.tab.querySelector('.tab-label').textContent = view.plugin.name;
      view.tab.setAttribute('aria-label', view.plugin.name);
      view.tab.title = view.label || view.plugin.name;
    });
  }

  function close(id) {
    const view = windows.get(id);
    const items = [...windows.values()];
    const index = items.indexOf(view);
    const next = items[index + 1] || items[index - 1];
    const selected = view.root.dataset.phase === 'open';
    view.dispose();
    view.root.remove();
    view.tab.remove();
    windows.delete(id);
    renumber();
    if (selected && next) {
      focus(next);
      next.tab.focus();
    } else if (windows.size && ![...windows.values()].some(item => item.tab.tabIndex === 0)) {
      next.tab.tabIndex = 0;
    }
    console.info('[desktop:close]', { pluginId: view.plugin.id, windowId: id });
    notify();
  }

  function requestClose(view) {
    // Sibling frames share the plugin backend; only the last shell can stop its tasks.
    if ([...windows.values()].some(other => other !== view && other.plugin.id === view.plugin.id)) {
      close(view.id);
      return;
    }
    return closePlugin(view.plugin.id);
  }

  function open(plugin, entryView = plugin.views[0]) {
    // Reuse the retained frame even when another host entry requests a single-instance view.
    const existing = plugin.singleInstance && [...windows.values()].find(view => view.plugin.id === plugin.id);
    if (existing) {
      focus(existing);
      return existing;
    }
    const id = String(++sequence);
    const label = t('窗口{count}', { count: [...windows.values()].filter(view => view.plugin.id === plugin.id).length + 1 });
    const root = el('section', { class: 'application-window', 'data-window': id, tabindex: 0, 'data-phase': 'open',
      id: `plugin-window-${id}`, role: 'tabpanel', 'aria-label': label, 'aria-labelledby': `plugin-tab-${id}` });
    const body = el('div', { class: 'window-body' });
    const view = { id, plugin, root, body, entryViewId: entryView.id };
    // Renaming only changes shell chrome; the sandbox frame and live tasks stay mounted.
    const rename = async () => {
      const name = await ask('修改窗口名称', root.getAttribute('aria-label'));
      if (name?.trim()) {
        view.label = name.trim();
        renumber();
        console.info('[desktop:rename]', { pluginId: plugin.id, windowId: id, name: view.label });
      }
    };
    root.addEventListener('pointerdown', () => focus(view));
    // Pointer events inside a sandbox frame do not bubble into its desktop wrapper.
    root.addEventListener('focusin', () => focus(view));
    root.append(body);
    stage.append(root);
    view.tab = el('div', { class: 'window-tab', role: 'tab', id: `plugin-tab-${id}`, 'data-window': id,
      'aria-controls': root.id, tabindex: 0, 'aria-selected': 'false', 'aria-label': plugin.name, title: plugin.name },
    el('span', { class: 'tab-label', text: plugin.name }), iconButton(icons.close, '关闭窗口', () => requestClose(view), 'tab-close'));
    view.tab.addEventListener('click', event => {
      if (!event.target.closest('button')) {
        focus(view);
      }
    });
    view.tab.addEventListener('dblclick', event => {
      if (!plugin.singleInstance && !event.target.closest('button')) {
        openPlugin(plugin.id);
      }
    });
    view.tab.addEventListener('keydown', event => {
      if (event.target === view.tab && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        focus(view);
      }
      selectTab(view, event);
    });
    view.tab.addEventListener('contextmenu', event => contextMenu(event, [...(!plugin.singleInstance ? [['新建窗口', () => openPlugin(plugin.id)]] : []),
      ['修改名称', rename], ['关闭窗口', () => requestClose(view)]]));
    tabs.append(view.tab);
    windows.set(id, view);
    renumber();
    view.dispose = mountPluginView(body, plugin, entryView, { openView, focused: () => {
      if (view.root.dataset.phase === 'open') {
        focus(view);
      }
    } });
    focus(view);
    console.info('[desktop:open]', { pluginId: plugin.id, windowId: id });
    return view;
  }

  function setGridSize(value) {
    stage.style.setProperty('--grid-size', `${value}px`);
  }
  return { windows, open, close, restore: focus, home, setGridSize };
}
