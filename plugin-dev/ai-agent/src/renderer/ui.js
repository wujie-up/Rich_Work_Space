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
export const button = (text, action, className = '') => el('button', { text, class: className, onclick: () => run(action) });

export function iconButton(label, icon, action, className = '') {
  const paths = {
    rename: 'M16 3l5 5-12 12H4v-5L16 3z M13 6l5 5',
    collapse: 'M6 14l6-6 6 6',
    close: 'M6 6l12 12 M6 18L18 6',
    more: 'M5 6h14 M5 12h14 M5 18h14',
    configure: 'M4 7h4 M12 7h8 M8 4v6 M4 17h9 M17 17h3 M13 14v6',
    history: 'M4 10a8 8 0 1 1 1 7 M4 4v6h6 M12 7v5l3 2',
    create: 'M12 5v14 M5 12h14',
    clear: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 10v7 M14 10v7',
    newline: 'M19 5v8H5 M9 9l-4 4 4 4',
    fork: 'M7 4v16 M7 14l10-7 M17 4v6 M4 4h6 M4 20h6'
  };
  const node = button('', action, `icon ${className}`);
  node.setAttribute('aria-label', label);
  node.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[icon]);
  svg.append(path);
  node.append(svg);
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
export function modal(title, build, { wide = false } = {}) {
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
    dialog.showModal();
  });
}
export function field(label, input) {
  return el('label', { class: 'field' }, el('span', { text: label }), input);
}
export function ask(title, value = '') {
  return modal(title, ({ body, actions, finish }) => {
    const input = el('input', { value, required: true, maxlength: 60 });
    body.append(field('名称', input));
    actions.append(button('取消', () => finish(null)), button('保存', () => { if (input.reportValidity()) { finish(input.value); } }, 'primary'));
  });
}
export function confirm(title, message) {
  return modal(title, ({ body, actions, finish }) => {
    body.append(el('p', { text: message }));
    actions.append(button('取消', () => finish(false)), button('确认', () => finish(true), 'danger'));
  });
}
