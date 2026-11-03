import { el, button, run } from './ui.js';
import { prepareContextMenu } from '../resource/context-menu.js';
import { dismissMenuOnLeave, positionPopup } from '../resource/popup.js';

export const pluginDragType = 'application/x-work-desk-plugin';
export const canOpen = (plugin) => plugin.state === 'enabled' && !plugin.operation && plugin.views.length > 0;
let closeMenu;

// Keep one menu and release its document listeners when it closes or its view disappears.
export function contextMenu(event, actions) {
  event.preventDefault();
  event.stopPropagation();
  closeMenu?.();
  const previous = document.activeElement;
  const menu = el('div', { class: 'context-menu', role: 'menu', popover: 'manual' });
  const close = () => {
    releaseMenu();
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('blur', close);
    if (previous?.isConnected) {
      previous.focus();
    }
    closeMenu = null;
  };
  const releaseMenu = dismissMenuOnLeave(menu, close);
  const outside = (e) => { if (!menu.contains(e.target)) { close(); } };
  const keyboard = (e) => {
    const items = [...menu.children];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  };
  for (const [label, action] of actions) {
    const item = button(label, () => { close(); return action(); });
    item.removeAttribute('data-i18n-textcontent');
    item.setAttribute('aria-label', label);
    item.setAttribute('role', 'menuitem');
    menu.append(item);
  }
  prepareContextMenu(menu);
  document.body.append(menu);
  // The top layer keeps menus above the shelf and isolated plugin frames regardless of their z-index.
  menu.showPopover();
  positionPopup(menu, event.currentTarget, { point: { x: event.clientX, y: event.clientY } });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keyboard, true);
  window.addEventListener('blur', close);
  menu.firstChild.focus();
  closeMenu = close;
}

export function bindLauncher(node, plugin, open) {
  node.draggable = true;
  node.addEventListener('contextmenu', (event) => contextMenu(event, [['打开', () => open(plugin.id)]]));
  node.addEventListener('dblclick', (event) => {
    if (!event.target.closest('button') || event.target.closest('button') === node) {
      run(() => open(plugin.id));
    }
  });
  node.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData(pluginDragType, plugin.id);
    event.dataTransfer.effectAllowed = 'copy';
  });
}

export function dismissMenu() {
  closeMenu?.();
}
