import { showSideDialog, closeSideDialog } from './side-dialog.js';
const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${path}"/></svg>`;

// Native dialogs work in the sandbox without enabling browser modal permissions.
export function confirmAction(message, title = '确认操作') {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    const body = document.createElement('div');
    body.className = 'dialog-body';
    const text = document.createElement('p');
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const finish = value => { closeSideDialog(dialog); dialog.remove(); resolve(value); };
    for (const [label, path, value] of [['取消操作', 'm6 6 12 12M6 18 18 6', false], [title, 'm5 12 4 4L19 6', true]]) {
      const button = document.createElement('button');
      button.className = 'icon-button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = svg(path);
      button.onclick = () => finish(value);
      actions.append(button);
    }
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    body.append(text, actions);
    dialog.append(body);
    document.body.append(dialog);
    showSideDialog(dialog);
  });
}
