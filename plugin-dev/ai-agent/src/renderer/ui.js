import { showPopup } from '../../../../desk/src/resource/popup.js';
import { api } from './api.js';
export { api };
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) {
      node.addEventListener(key.slice(2), value);
    } else if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (value !== false && value != null) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

export function iconButton(label, icon, action, className = '') {
  const node = el('button', { class: `icon icon-button ${className}`, onclick: () => run(action) });
  setButtonIcon(node, label, icon);
  return node;
}

// Dynamic actions keep their icon, accessible name and hover hint in sync.
export function setButtonIcon(node, label, icon) {
  const paths = {
    archive: 'M3 4h18v5H3z M5 9v12h14V9 M9 13h6',
    save: 'M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8',
    check: 'M4 12l5 5L20 6',
    folder: 'M3 7V4h7l2 3h9v13H3z',
    play: 'm8 4 12 8-12 8z',
    restore: 'M4 10a8 8 0 1 1 1 7 M4 4v6h6',
    git: 'M7 3v18 M7 14l10-7 M14 4h6v6',
    sendReply: 'M12 19V5 M6 11l6-6 6 6',
    help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4 M12 17h.01',
    send: 'm3 3 18 9-18 9 4-9z M7 12h14',
    debug: 'M8 8h8v10a4 4 0 0 1-8 0z M9 8V5h6v3 M3 12h5 M16 12h5 M3 18h5 M16 18h5',
    rename: 'M16 3l5 5-12 12H4v-5L16 3z M13 6l5 5',
    collapse: 'M6 14l6-6 6 6',
    maximize: 'M4 4h16v16H4z',
    normal: 'M8 8h12v12H8z M4 16V4h12',
    close: 'M6 6l12 12 M6 18L18 6',
    concise: 'M5 7h14 M5 12h10 M5 17h14',
    full: 'M8 5h13 M8 10h13 M8 15h13 M8 20h13 M3 5h.01 M3 10h.01 M3 15h.01 M3 20h.01',
    more: 'M5 6h14 M5 12h14 M5 18h14',
    configure: 'M4 7h4 M12 7h8 M8 4v6 M4 17h9 M17 17h3 M13 14v6',
    history: 'M4 10a8 8 0 1 1 1 7 M4 4v6h6 M12 7v5l3 2',
    create: 'M12 5v14 M5 12h14',
    roles: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3 M9 17h6',
    group: 'M3 7V4h7l2 3h9v13H3z M8 13h8 M12 9v8',
    moveGroup: 'M3 19V5h6l3 3h8v3 M3 19h5 M11 16h10 m-4-4 4 4-4 4',
    sidebar: 'M3 4h18v16H3z M9 4v16',
    chevronDown: 'm6 9 6 6 6-6',
    chevronRight: 'm9 6 6 6-6 6',
    previous: 'M20 12H4 M10 6l-6 6 6 6',
    next: 'M4 12h16 M14 6l6 6-6 6',
    interrupt: 'M6 6h12v12H6z',
    clear: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 10v7 M14 10v7',
    resetContext: 'm4 14 9-10 7 6-9 10H8z M9 9l7 6 M4 20h17',
    newline: 'M19 5v8H5 M9 9l-4 4 4 4',
    fork: 'M7 4v16 M7 14l10-7 M17 4v6 M4 4h6 M4 20h6'
  };
  node.classList.add('icon', 'icon-button');
  node.setAttribute('aria-label', label);
  node.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[icon]);
  svg.append(path);
  node.replaceChildren(svg);
  return node;
}
export async function run(action) {
  try {
    return await action();
  } catch (error) {
    toast(error.message);
  }
}
let toastTimer;
export function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 6500);
}

// All confirmations use DOM text nodes; CLI output and plugin names are never HTML.
export function modal(title, build, { wide = false, anchor, placement = 'anchor' } = {}) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: wide ? 'wide' : '' });
    const form = el('form', { method: 'dialog' });
    const body = el('div', { class: 'dialog-body' });
    const actions = el('div', { class: 'dialog-actions' });
    const finish = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    form.append(el('div', { class: 'dialog-heading' }, el('h2', { text: title }), iconButton('关闭', 'close', () => finish(null))), body, actions);
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    form.addEventListener('submit', (event) => event.preventDefault());
    build({ body, actions, finish, dialog });
    showPopup(dialog, anchor, { placement });
  });
}
export function field(label, input) {
  return el('label', { class: 'field' }, el('span', { text: label }), input);
}
export function ask(title, value = '') {
  return modal(title, ({ body, actions, finish }) => {
    const input = el('input', { value, required: true, maxlength: 60 });
    body.append(field('名称', input));
    actions.append(iconButton('取消', 'close', () => finish(null)), iconButton('保存', 'save', () => { if (input.reportValidity()) { finish(input.value); } }, 'primary'));
  });
}
export function confirm(title, message) {
  return modal(title, ({ body, actions, finish }) => {
    body.append(el('p', { text: message }));
    actions.append(iconButton('取消', 'close', () => finish(false)), iconButton('确认', 'check', () => finish(true), 'danger'));
  });
}
