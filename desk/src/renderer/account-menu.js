import { el, run, toast } from './ui.js';
import { dismissMenu } from './launcher.js';

const symbols = {
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  plugins: ['M9 3h6v5h5v6h-5v7H9v-7H4V8h5Z'],
  settings: ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  language: ['M3 5h12M9 3v2M5 5c0 6 4 9 9 11M13 5c0 6-4 9-10 12', 'm13 21 4-11 4 11M15 17h4'],
  chevron: ['m9 5 7 7-7 7'],
  check: ['m5 12 4 4L19 6'],
  update: ['M20 7v5h-5M4 17v-5h5', 'M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1']
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(key, value);
  }
  for (const d of symbols[name]) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// A native top-layer popover escapes the shelf's clipping and every retained plugin frame.
export function mountAccountMenu(surface, configure, changeLanguage) {
  const menu = el('div', { id: 'account-menu', class: 'account-menu', popover: 'auto', role: 'menu', 'aria-label-message': '用户菜单' });
  const trigger = el('button', { class: 'account-trigger', 'aria-label-message': '用户菜单', 'title-message': '用户菜单',
    'aria-haspopup': 'menu', 'aria-controls': menu.id, 'aria-expanded': 'false', onclick: () => {
      dismissMenu();
      clearTimeout(hideTimer);
      menu.togglePopover();
      if (menu.matches(':popover-open')) {
        position();
        menu.firstChild.focus();
      }
    } }, icon('user'));
  const footer = el('div', { class: 'shelf-footer' }, trigger);
  let hideTimer;
  const close = () => {
    clearTimeout(hideTimer);
    menu.hidePopover();
  };
  const position = () => {
    const rect = footer.getBoundingClientRect();
    menu.style.left = `${rect.right + 8}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom - menu.offsetHeight, innerHeight - menu.offsetHeight - 8))}px`;
  };
  const languages = el('div', { id: 'language-menu', class: 'account-menu language-menu', popover: 'auto',
    role: 'menu', 'aria-label-message': '语言' });
  const languageItem = el('button', { role: 'menuitem', 'title-message': '语言', 'aria-haspopup': 'menu',
    'aria-controls': languages.id, 'aria-expanded': 'false' }, icon('language'), el('span', { message: '语言' }), icon('chevron'));
  const openLanguages = () => {
    languages.querySelectorAll('button').forEach(node => {
      node.setAttribute('aria-checked', String(node.dataset.language === document.documentElement.lang));
    });
    languages.showPopover();
    const rect = languageItem.getBoundingClientRect();
    const right = menu.offsetLeft + menu.offsetWidth;
    // Layout coordinates keep the submenu anchored while its parent animates into place.
    languages.style.left = `${right + languages.offsetWidth + 6 <= innerWidth
      ? right + 4 : Math.max(4, menu.offsetLeft - languages.offsetWidth - 4)}px`;
    languages.style.top = `${Math.max(4, Math.min(rect.top - 6, innerHeight - languages.offsetHeight - 4))}px`;
  };
  languageItem.addEventListener('click', openLanguages);
  languageItem.addEventListener('mouseenter', openLanguages);
  languageItem.addEventListener('focus', openLanguages);
  languageItem.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      openLanguages();
      languages.querySelector('[aria-checked=true]').focus();
    }
  });
  for (const [value, label] of [['zh-CN', '简体中文'], ['en', 'English']]) {
    languages.append(el('button', { role: 'menuitemradio', 'data-language': value, 'aria-checked': 'false',
      onclick: () => run(async () => {
        await changeLanguage(value);
        close();
        trigger.focus();
      }) }, el('span', { message: label }), icon('check')));
  }
  languages.addEventListener('toggle', () => {
    languageItem.setAttribute('aria-expanded', String(languages.matches(':popover-open')));
  });
  languages.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      event.preventDefault();
      languageItem.focus();
      languages.hidePopover();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...languages.children];
      items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  for (const [symbol, label, action] of [
    ['user', '游客', () => toast('当前为游客，登录功能后续开放')],
    ['plugins', '插件', configure],
    ['settings', '设置', configure],
    ['language', '语言', null],
    ['update', '检查更新', () => toast('暂未接入更新服务')]
  ]) {
    if (symbol === 'language') {
      menu.append(languageItem);
    } else {
      const item = el('button', { role: 'menuitem', 'title-message': label, onclick: () => {
        close();
        run(action);
      } }, icon(symbol), el('span', { message: label }));
      item.addEventListener('mouseenter', () => languages.hidePopover());
      item.addEventListener('focus', () => languages.hidePopover());
      menu.append(item);
    }
  }
  menu.append(languages);
  menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...menu.querySelectorAll(':scope > button')];
      items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  // Allow crossing the small gaps between the trigger and both popovers.
  for (const region of [trigger, menu, languages]) {
    region.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    region.addEventListener('mouseleave', () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (![trigger, menu, languages].some(node => node.matches(':hover'))) {
          close();
        }
      }, 300);
    });
  }
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  surface.append(footer);
  document.body.append(menu);
  return close;
}
