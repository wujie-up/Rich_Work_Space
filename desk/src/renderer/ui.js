export const api = window.workDesk;
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
    form.append(el('div', { class: 'dialog-heading' }, el('h2', { text: title }), button('×', () => finish(null), 'icon')), body, actions);
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
