const paths = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  query: '<path d="m9 5 10 7-10 7Z"/>',
  cancel: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  open: '<path d="M14 4h6v6m0-6L10 14M10 4H4v16h16v-6"/>',
  logout: '<path d="M10 4H4v16h6m5-12 4 4-4 4m-7-4h11"/>',
  save: '<path d="M4 4h14l2 2v14H4Zm3 0v6h10V4M8 20v-6h8v6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 3m0 3h.01"/>'
};

export const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;

export function button(name, label) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'icon-button';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.innerHTML = icon(name);
  return node;
}

export function help(label, text) {
  const wrapper = document.createElement('span');
  wrapper.className = 'help';
  const trigger = button('help', label);
  const tooltip = document.createElement('span');
  tooltip.id = `help-${crypto.randomUUID()}`;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = text;
  trigger.setAttribute('aria-describedby', tooltip.id);
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      trigger.blur();
    }
  });
  wrapper.append(trigger, tooltip);
  return wrapper;
}

export function options(select, rows, placeholder, value = '') {
  select.replaceChildren(new Option(placeholder, ''));
  for (const row of rows) {
    select.add(new Option(row.label, row.id));
  }
  select.value = value;
}

export const textCell = value => {
  const cell = document.createElement('td');
  cell.textContent = value;
  return cell;
};
