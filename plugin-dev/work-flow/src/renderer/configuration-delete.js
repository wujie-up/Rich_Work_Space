import { showPopup } from '../../../../desk/src/resource/popup.js';

// Cancellation must settle the promise as well as close the shared popup.
export function confirmConfigurationDelete(title, message, anchor = document.activeElement) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog';
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h2');
    heading.textContent = title;
    const description = document.createElement('p');
    description.textContent = message;
    const actions = document.createElement('footer');
    const button = (label, path, value) => {
      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'icon-button';
      control.title = label;
      control.setAttribute('aria-label', label);
      control.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
      if (value === 'delete') { control.dataset.delete = ''; }
      control.onclick = () => dialog.close(value);
      return control;
    };
    const cancel = button('取消', 'M6 6l12 12 M6 18L18 6', 'cancel');
    cancel.autofocus = true;
    actions.append(cancel, button('确认删除', 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7', 'delete'));
    dialog.append(heading, description, actions);
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'delete';
      // Allow popup.js to restore the trigger focus before removing the dialog.
      queueMicrotask(() => { dialog.remove(); resolve(confirmed); });
    }, { once: true });
    document.body.append(dialog);
    showPopup(dialog, anchor);
  });
}
