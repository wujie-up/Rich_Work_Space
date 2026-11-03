import { showPopup } from '../../../../desk/src/resource/popup.js';

export function confirmDelete(name, impact, anchor = document.activeElement) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'configuration-confirmation';
    dialog.setAttribute('aria-label', '删除配置');
    const heading = document.createElement('h2');
    heading.textContent = '删除配置';
    const description = document.createElement('p');
    description.textContent = `确认删除“${name}”？${impact}`;
    const actions = document.createElement('div');
    actions.className = 'confirmation-actions';
    const button = (label, path, confirmed) => {
      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'icon-button';
      control.title = label;
      control.setAttribute('aria-label', label);
      control.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
      control.onclick = () => dialog.close(confirmed ? 'delete' : 'cancel');
      return control;
    };
    const cancel = button('取消', 'M6 6l12 12M6 18 18 6', false);
    cancel.autofocus = true;
    actions.append(cancel, button('确认删除', 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', true));
    dialog.append(heading, description, actions);
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'delete';
      queueMicrotask(() => { dialog.remove(); resolve(confirmed); });
    }, { once: true });
    document.body.append(dialog);
    showPopup(dialog, anchor);
  });
}
