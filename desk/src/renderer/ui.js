import { message, t } from './i18n.js';
export const api = window.workDesk;
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) {
      node.addEventListener(key.slice(2), value);
    } else if (key === 'class') {
      node.className = value;
    } else if (key === 'message' || key.endsWith('-message')) {
      message(node, value, key === 'message' ? 'textContent' : key.slice(0, -8));
    } else if (key === 'text') {
      node.textContent = value;
    } else if (value !== false && value != null) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  node.append(...children.filter((child) => child != null));
  return node;
}
export const button = (text, action, className = '') => el('button', { message: text, class: className, onclick: () => run(action) });

export const icons = {
  close: 'm6 6 12 12M18 6 6 18',
  minimize: 'M5 12h14',
  flat: 'M8 4h12v12M20 4 4 20',
  normal: 'M4 5h16v14H4ZM4 9h16',
  check: 'm5 12 4 4L19 6',
  cancel: 'm9 6-5 5 5 5M4 11h10a5 5 0 0 1 0 10h-2',
  power: 'M12 3v9M7 5a9 9 0 1 0 10 0',
  remove: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  open: 'M3 5h18v14H3ZM3 9h18M6 7h.01M9 7h.01',
  enable: 'm9 5 10 7-10 7Z',
  retry: 'M20 4v6h-6M20 10a8 8 0 1 0 0 5',
  import: 'M14 3h6v18H4v-5M3 10h12m-4-4 4 4-4 4'
};

// Shared operation controls keep translated tooltips and accessible names when visible text is omitted.
export function iconButton(path, label, action, className = '') {
  const control = el('button', { type: 'button', class: `icon-button ${className}`, 'aria-label-message': label,
    'title-message': label, onclick: () => run(action) });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(key, value);
  }
  const lines = document.createElementNS(svg.namespaceURI, 'path');
  lines.setAttribute('d', path);
  svg.append(lines);
  control.append(svg);
  return control;
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
  node.textContent = t(message);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 6500);
}

// All confirmations use DOM text nodes; CLI output and plugin names are never HTML.
export function modal(title, build, { wide = false, compact = false } = {}) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: compact ? 'compact' : wide ? 'wide' : '', 'aria-label-message': title });
    const form = el('form', { method: 'dialog' });
    const body = el('div', { class: 'dialog-body' });
    const actions = el('div', { class: 'dialog-actions' });
    const finish = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    if (!compact) {
      form.append(el('div', { class: 'dialog-heading' }, el('h2', { message: title }), iconButton(icons.close, '关闭', () => finish(null))));
    }
    form.append(body, actions);
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    form.addEventListener('submit', (event) => event.preventDefault());
    build({ body, actions, finish, dialog });
    dialog.showModal();
  });
}
export function field(label, input) {
  return el('label', { class: 'field' }, el('span', { message: label }), input);
}
export function ask(title, value = '') {
  return modal(title, ({ body, actions, finish }) => {
    const input = el('input', { value, required: true, maxlength: 60 });
    body.append(field('名称', input));
    actions.append(iconButton(icons.cancel, '取消', () => finish(null)), iconButton(icons.check, '保存', () => {
      if (input.reportValidity()) {
        finish(input.value);
      }
    }));
  });
}
export function confirm(title, message) {
  return modal(title, ({ body, actions, finish }) => {
    body.append(el('p', { message }));
    actions.append(iconButton(icons.cancel, '取消', () => finish(false)), iconButton(icons.check, '确认', () => finish(true)));
  });
}
