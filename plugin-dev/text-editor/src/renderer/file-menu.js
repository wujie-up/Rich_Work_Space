import { prepareContextMenu } from '../../../../desk/src/resource/context-menu.js';
import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
export function setupFileMenu(reference, perform) {
  const surfaces = [document.querySelector('#files'), document.querySelector('#history-panel')];
  const menu = document.querySelector('#file-menu');
  let selected;
  const close = () => {
    closePopup(menu);
    menu.hidden = true;
  };
  function open(event, button) {
    event.preventDefault();
    selected = reference(button);
    document.body.append(menu);
    menu.hidden = false;
    prepareContextMenu(menu);
    showPopup(menu, button, { point: event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : undefined });
    menu.querySelector('button').focus();
  }
  const contextmenu = event => {
    const button = event.target.closest('button[data-path]:not([data-directory="true"])');
    if (button) { open(event, button); }
  };
  const keydown = event => {
    const button = event.target.closest('button[data-path]:not([data-directory="true"])');
    if (button && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      open(event, button);
    }
    if (button && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
      && !event.isComposing && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      perform('copyFile', reference(button));
    }
  };
  surfaces.forEach(surface => {
    surface.addEventListener('contextmenu', contextmenu);
    surface.addEventListener('keydown', keydown);
    surface.addEventListener('scroll', close);
  });
  menu.onclick = async event => {
    const button = event.target.closest('button');
    if (!button) { return; }
    const file = selected;
    // Let the shared popup restore focus before the next form takes keyboard focus.
    const closed = new Promise(resolve => menu.addEventListener('toggle', resolve, { once: true }));
    close();
    await closed;
    perform(button.dataset.action, file);
  };
  menu.onkeydown = event => {
    const buttons = [...menu.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
    if (event.key === 'Escape') {
      close();
      selected.button.focus();
    }
  };
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
}

// A native copy event works inside the sandbox without granting clipboard API permissions to the frame.
export function copyFileReference(file) {
  const path = `${file.root}/${file.path}`.replace(/\/+/g, '/');
  let copied = false;
  const copy = event => {
    const uri = `file://${path.split('/').map(encodeURIComponent).join('/')}`;
    event.clipboardData.setData('text/plain', uri);
    event.clipboardData.setData('text/uri-list', uri);
    event.preventDefault();
    copied = true;
  };
  document.addEventListener('copy', copy, { once: true });
  try {
    if (!document.execCommand('copy') || !copied) {
      throw new Error('无法复制文件，请重新选择文件后重试');
    }
    console.info('[text-editor:file-copy]', { pluginId: 'text-editor', path });
  } catch (error) {
    copied = false;
    console.error('[text-editor:file-copy]', { pluginId: 'text-editor', path, stack: error.stack }, error);
    throw error;
  } finally {
    document.removeEventListener('copy', copy);
  }
}

// Keep the selected file explicit while confirming disk changes beside its entry.
export function confirmFileAction(method, file) {
  const dialog = document.querySelector('#file-action-dialog');
  const input = dialog.querySelector('input');
  const renaming = method === 'renameFile';
  dialog.querySelector('.dialog-heading').textContent = renaming ? '重命名文件' : '删除文件';
  dialog.querySelector('label').hidden = !renaming;
  dialog.querySelector('p').hidden = renaming;
  dialog.querySelector('p').textContent = `确定删除“${file.name}”？文件将从磁盘删除，未保存内容保留为草稿。`;
  input.value = file.name;
  input.required = renaming;
  dialog.returnValue = '';
  document.body.append(dialog);
  showPopup(dialog, file.button);
  if (renaming) { input.select(); }
  const confirm = dialog.querySelector('[data-confirm]');
  confirm.onclick = () => {
    if (renaming && (!input.reportValidity() || !input.value.trim())) { return; }
    dialog.close('confirm');
  };
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      confirm.click();
    }
  };
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  return new Promise(resolve => dialog.addEventListener('close', () => {
    resolve(dialog.returnValue === 'confirm' ? (renaming ? input.value.trim() : true) : null);
  }, { once: true }));
}
