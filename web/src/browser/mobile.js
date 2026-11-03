import { closePopup, showPopup } from '../../../desk/src/resource/popup.js';
import { el, iconButton, toast } from '../../../desk/src/renderer/ui.js';

// Reparent only shell controls: retained plugin frames and the host's window model never move.
export function mountMobile() {
  const viewport = matchMedia('(max-width: 900px)');
  const home = document.querySelector('#desktop');
  const footer = document.querySelector('.shelf-footer');
  const shelf = document.querySelector('.plugin-shelf');
  const desktop = document.querySelector('.desktop-surface');
  const tabs = document.querySelector('.window-tabs');
  const account = document.querySelector('#account-menu');
  const languages = document.querySelector('#language-menu');
  const accountTrigger = footer.querySelector('button');
  const moved = [home, footer, shelf].map(node => {
    const marker = document.createComment('web-mobile-shell');
    node.before(marker);
    return { node, marker };
  });
  const windows = iconButton('M3 4h14v12H3ZM7 20h14V8M3 8h14', '切换窗口', () => toggle(tabs, windows, 'center'));
  windows.setAttribute('aria-haspopup', 'true');
  windows.setAttribute('aria-expanded', 'false');
  windows.setAttribute('aria-controls', 'web-mobile-windows');
  const bar = el('nav', { class: 'web-mobile-bar', 'aria-label': '工作台导航', hidden: true });
  const heading = el('h1', { class: 'web-mobile-heading', text: '工作台' });
  const pluginsHeading = el('h2', { class: 'web-mobile-heading', text: '插件' });
  const filesHeading = el('h2', { class: 'web-mobile-heading web-mobile-files-heading', text: '工作台文件' });
  tabs.id = 'web-mobile-windows';
  document.body.append(bar);
  const controller = new AbortController();
  const options = { signal: controller.signal };

  function fail(error) {
    console.error('[web:mobile-shell]', { stack: error.stack });
    restore();
    toast('手机布局加载失败，已恢复标准布局');
  }

  function toggle(panel, anchor, placement = 'auto') {
    try {
      panel.matches(':popover-open') ? closePopup(panel) : showPopup(panel, anchor, { placement });
    } catch (error) {
      fail(error);
    }
  }

  function restore() {
    [tabs, account, languages].forEach(closePopup);
    tabs.removeAttribute('popover');
    tabs.classList.remove('account-menu', 'desk-popup');
    tabs.style.removeProperty('left');
    tabs.style.removeProperty('top');
    account.popover = 'auto';
    languages.popover = 'auto';
    moved.forEach(({ node, marker }) => marker.after(node));
    [heading, pluginsHeading, filesHeading].forEach(node => node.remove());
    bar.hidden = true;
    delete document.documentElement.dataset.mobile;
  }

  function resize() {
    try {
      if (!viewport.matches) {
        restore();
        return;
      }
      document.documentElement.dataset.mobile = 'true';
      bar.hidden = false;
      bar.append(home, windows, footer);
      desktop.prepend(heading, pluginsHeading, shelf, filesHeading);
      tabs.classList.add('account-menu');
      tabs.popover = 'manual';
      console.info('[web:mobile-shell]', { width: innerWidth, windows: tabs.children.length });
    } catch (error) {
      fail(error);
    }
  }

  // Disable desktop drag initiation while keeping native taps, focus and scrolling intact.
  document.addEventListener('pointerdown', event => {
    const anchor = event.target.closest('.account-trigger, .web-mobile-bar > button, #account-menu > button[aria-controls=language-menu]');
    const toggling = anchor === accountTrigger && account.matches(':popover-open')
      || anchor === windows && tabs.matches(':popover-open')
      || anchor?.getAttribute('aria-controls') === 'language-menu' && languages.matches(':popover-open');
    if (document.documentElement.dataset.mobile && (toggling || event.target.closest('.shelf-app, .desktop-file, .window-tab'))) {
      event.stopPropagation();
    }
  }, { ...options, capture: true });
  document.addEventListener('click', event => {
    if (!document.documentElement.dataset.mobile) {
      return;
    }
    const trigger = event.target.closest('.account-trigger, #language-menu, #account-menu > button[aria-controls=language-menu]');
    if (trigger === accountTrigger || trigger?.getAttribute('aria-controls') === 'language-menu') {
      event.stopImmediatePropagation();
      toggle(trigger === accountTrigger ? account : languages, trigger);
    }
    const file = event.target.closest('.desktop-file');
    if (file && event.detail <= 1) {
      file.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
  }, { ...options, capture: true });
  // Touch menus use explicit dismissal rather than desktop hover timers and focus-open behavior.
  for (const type of ['mouseenter', 'mouseleave', 'focus']) {
    document.addEventListener(type, event => {
      if (document.documentElement.dataset.mobile && event.target.closest('.account-trigger, #account-menu')
        && (type !== 'focus' || event.target.getAttribute('aria-controls') === 'language-menu')) {
        event.stopImmediatePropagation();
      }
    }, { ...options, capture: true });
  }
  tabs.addEventListener('click', event => {
    if (viewport.matches && event.target.closest('.window-tab') && !event.target.closest('button')) {
      closePopup(tabs);
    }
  }, options);
  tabs.addEventListener('keydown', event => {
    if (viewport.matches && ['Enter', ' '].includes(event.key) && event.target.matches('.window-tab')) {
      closePopup(tabs);
    }
  }, options);
  tabs.addEventListener('toggle', () => windows.setAttribute('aria-expanded', String(tabs.matches(':popover-open'))), options);
  account.addEventListener('toggle', event => {
    // The desktop's language action closes its parent directly; manual child popovers need the same cleanup.
    if (event.newState === 'closed') {
      closePopup(languages);
    }
  }, options);
  const update = () => { windows.disabled = !tabs.children.length; };
  const observer = new MutationObserver(update);
  observer.observe(tabs, { childList: true });
  viewport.addEventListener('change', resize, options);
  update();
  resize();
  // Start mobile login on home while retaining auto-opened plugin frames in the window switcher.
  if (viewport.matches) {
    try {
      home.click();
    } catch (error) {
      fail(error);
    }
  }
  return () => {
    controller.abort();
    observer.disconnect();
    restore();
    moved.forEach(({ marker }) => marker.remove());
    bar.remove();
  };
}
