import { t } from './i18n.js';
import { el, ask, iconButton, icons, toast } from './ui.js';
import { mountPluginView } from './plugin-view.js';
import { contextMenu } from './launcher.js';

// The desktop owns tab layout; plugin state stays inside its retained sandbox frame.
export function mountWindows(stage, { openPlugin, closePlugin, openView, changed = () => {}, localClose = false }) {
  const windows = new Map();
  const tabs = el('div', { class: 'window-tabs', role: 'tablist', 'aria-label-message': '插件窗口' });
  stage.append(tabs);
  let sequence = 0;
  let layer = 0;
  const notify = () => changed([...windows.values()].find(view => view.root.dataset.phase === 'open'));

  // Runtime identities cannot be confused with persisted plugin history after a desktop restart.
  const windowContext = view => ({ id: view.instanceId, pluginId: view.plugin.id, viewId: view.entryViewId,
    name: view.root.getAttribute('aria-label') });
  const listWindows = () => [...windows.values()].map(windowContext);

  // Switching only hides retained frames; plugin documents and shared tasks stay alive.
  function focus(view) {
    const restoring = view.tab.hidden;
    view.tab.hidden = false;
    // Launchers reuse this ordering to restore the most recently used page.
    view.layer = ++layer;
    windows.forEach(item => {
      item.animation?.cancel();
      item.dispose?.setVisible(item === view);
      item.root.style.visibility = item === view ? 'visible' : 'hidden';
      item.root.setAttribute('aria-hidden', String(item !== view));
      item.root.inert = item !== view;
      item.root.dataset.phase = item === view ? 'open' : item.tab.hidden ? 'minimized' : 'inactive';
      item.root.classList.toggle('focused', item === view);
      item.tab.setAttribute('aria-selected', String(item === view));
      item.tab.tabIndex = item === view ? 0 : -1;
    });
    if (restoring) {
      animate(view, true);
    }
    view.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    notify();
  }

  // Restore every sibling tab, focusing only the most recent frame to avoid waking hidden pages.
  function restoreAll(pluginId) {
    const siblings = [...windows.values()].filter(view => view.plugin.id === pluginId).sort((a, b) => b.layer - a.layer);
    const latest = siblings[0];
    const restoring = latest?.tab.hidden;
    siblings.forEach(view => { view.tab.hidden = false; });
    if (latest) {
      focus(latest);
      if (restoring) {
        animate(latest, true);
      }
    }
  }

  function home() {
    windows.forEach(view => {
      view.animation?.cancel();
      view.dispose?.setVisible(false);
      view.root.style.visibility = 'hidden';
      view.root.setAttribute('aria-hidden', 'true');
      view.root.inert = true;
      view.root.dataset.phase = view.tab.hidden ? 'minimized' : 'inactive';
      view.root.classList.remove('focused');
      view.tab.setAttribute('aria-selected', 'false');
    });
    notify();
  }

  // Animate the retained shell itself; no frame cloning or document reload is involved.
  function animate(view, restoring = false) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return null;
    }
    const launcher = [...document.querySelectorAll('.shelf-app')].find(node => node.dataset.plugin === view.plugin.id);
    const source = view.root.getBoundingClientRect();
    const target = launcher?.getBoundingClientRect();
    const x = target?.width ? target.x + target.width / 2 : 0;
    const y = target?.height ? target.y + target.height / 2 : source.y + source.height / 2;
    const frames = [{ transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${x - source.x - source.width / 2}px, ${y - source.y - source.height / 2}px) scale(0.08)`, opacity: 0 }];
    view.animation = view.root.animate(restoring ? frames.reverse() : frames,
      { duration: 240, easing: 'cubic-bezier(.22,.68,0,1)' });
    return view.animation;
  }

  function minimize(view) {
    const selected = view.root.dataset.phase === 'open';
    view.tab.hidden = true;
    view.tab.tabIndex = -1;
    view.tab.setAttribute('aria-selected', 'false');
    view.root.dataset.phase = 'minimized';
    view.root.inert = true;
    view.root.setAttribute('aria-hidden', 'true');
    view.dispose.setVisible(false);
    const finish = () => {
      const next = [...windows.values()].filter(item => !item.tab.hidden).sort((a, b) => b.layer - a.layer)[0];
      if (next) {
        focus(next);
        next.tab.focus();
      } else {
        home();
        document.querySelector('.shelf-app[data-open="true"]')?.focus();
      }
    };
    if (!selected) {
      view.root.style.visibility = 'hidden';
      notify();
      return;
    }
    const animation = animate(view);
    if (animation) {
      animation.finished.then(finish, () => {});
    } else {
      finish();
    }
    console.info('[desktop:minimize]', { pluginId: view.plugin.id, windowId: view.id });
    notify();
  }

  function selectTab(view, event) {
    const items = [...tabs.children].filter(tab => !tab.hidden).map(tab => windows.get(tab.dataset.window));
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

  // Move tab shells only: the sandbox frames and active plugin stay untouched.
  function dragTab(view, event) {
    if (event.button !== 0 || event.target.closest('button')) {
      return;
    }
    const startX = event.clientX;
    const controller = new AbortController();
    const move = pointer => {
      if (pointer.pointerId !== event.pointerId || (!view.tab.classList.contains('dragging') && Math.abs(pointer.clientX - startX) < 6)) {
        return;
      }
      view.tab.classList.add('dragging');
      view.suppressTabClick = true;
      const others = [...tabs.children].filter(tab => tab !== view.tab && !tab.hidden);
      const next = others.find(tab => {
        return pointer.clientX < tabs.getBoundingClientRect().left + tab.offsetLeft - tabs.scrollLeft + tab.offsetWidth / 2;
      });
      if (view.tab.nextElementSibling !== (next || null)) {
        const positions = new Map(others.map(tab => [tab, tab.offsetLeft]));
        tabs.insertBefore(view.tab, next || null);
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          others.forEach(tab => {
            const offset = positions.get(tab) - tab.offsetLeft;
            if (offset) {
              tab.getAnimations().forEach(animation => animation.cancel());
              tab.animate([{ transform: `translateX(${offset}px)` }, { transform: 'translateX(0)' }],
                { duration: 140, easing: 'ease-out' });
            }
          });
        }
      }
      const bounds = tabs.getBoundingClientRect();
      if (pointer.clientX < bounds.left + 24 || pointer.clientX > bounds.right - 24) {
        tabs.scrollLeft += pointer.clientX < bounds.left + 24 ? -16 : 16;
      }
    };
    const finish = pointer => {
      if (pointer.pointerId !== event.pointerId) {
        return;
      }
      controller.abort();
      if (view.suppressTabClick) {
        view.tab.classList.remove('dragging');
        console.info('[desktop:reorder-tabs]', { windowId: view.id, order: [...tabs.children].map(tab => tab.dataset.window) });
        // The pointer-up click belongs to the drag, not to tab activation.
        setTimeout(() => { view.suppressTabClick = false; }, 0);
      }
    };
    document.addEventListener('pointermove', move, { signal: controller.signal });
    document.addEventListener('pointerup', finish, { signal: controller.signal });
    document.addEventListener('pointercancel', finish, { signal: controller.signal });
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
    const next = [...windows.values()].filter(item => item !== view && !item.tab.hidden).sort((a, b) => b.layer - a.layer)[0];
    const selected = view.root.dataset.phase === 'open';
    view.animation?.cancel();
    view.dispose();
    view.root.remove();
    view.tab.remove();
    windows.delete(id);
    renumber();
    if (selected && next) {
      focus(next);
      next.tab.focus();
    } else if (next && ![...windows.values()].some(item => !item.tab.hidden && item.tab.tabIndex === 0)) {
      next.tab.tabIndex = 0;
    }
    console.info('[desktop:close]', { pluginId: view.plugin.id, windowId: id });
    notify();
  }

  function requestClose(view) {
    // Sibling frames share the plugin backend; only the last shell can stop its tasks.
    if (localClose || [...windows.values()].some(other => other !== view && other.plugin.id === view.plugin.id)) {
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
      if (entryView.launchContext !== undefined) {
        try {
          existing.dispose.setLaunchContext(entryView.launchContext);
          console.info('[desktop:launch-context]', { pluginId: plugin.id, windowId: existing.id, viewId: entryView.id });
        } catch (error) {
          console.error('[desktop:launch-context]', { pluginId: plugin.id, windowId: existing.id, viewId: entryView.id }, error);
          toast('打开请求传递失败，请重试');
        }
      }
      return existing;
    }
    const id = String(++sequence);
    const label = t('窗口{count}', { count: [...windows.values()].filter(view => view.plugin.id === plugin.id).length + 1 });
    const root = el('section', { class: 'application-window', 'data-window': id, tabindex: 0, 'data-phase': 'open',
      id: `plugin-window-${id}`, role: 'tabpanel', 'aria-label': label, 'aria-labelledby': `plugin-tab-${id}` });
    const body = el('div', { class: 'window-body' });
    const view = { id, instanceId: crypto.randomUUID(), plugin, root, body, entryViewId: entryView.id };
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
    el('span', { class: 'tab-label', text: plugin.name }), iconButton(icons.minimize, '最小化窗口', () => minimize(view), 'tab-minimize'),
    iconButton(icons.close, '关闭窗口', () => requestClose(view), 'tab-close'));
    view.tab.addEventListener('pointerdown', event => dragTab(view, event));
    view.tab.addEventListener('click', event => {
      if (!view.suppressTabClick && !event.target.closest('button')) {
        focus(view);
      }
    });
    view.tab.addEventListener('dblclick', event => {
      if (!view.suppressTabClick && !plugin.singleInstance && !event.target.closest('button')) {
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
      ['修改名称', rename], ['最小化窗口', () => minimize(view)], ['关闭窗口', () => requestClose(view)]]));
    tabs.append(view.tab);
    windows.set(id, view);
    renumber();
    view.dispose = mountPluginView(body, plugin, entryView, { openView, windowContext: () => windowContext(view), listWindows, focused: () => {
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
  return { windows, open, close, restore: focus, restoreAll, minimize, home, setGridSize };
}
