import { invoke } from './api.js';
import { confirmAction } from './dialog.js';

export function setupEditor(getFile, status) {
  const $ = selector => document.querySelector(selector);
  let snapshot;
  let timer;
  let saving;
  const dirty = () => snapshot && $('#editor').value !== snapshot.text;
  const update = () => {
    $('#file-tabs [aria-selected="true"]')?.classList.toggle('unsaved', !!dirty());
  };
  const reset = () => {
    clearTimeout(timer);
    snapshot = null;
    $('#editor').value = '';
    $('#editor').hidden = true;
    $('#source').hidden = false;
    update();
  };
  // Serialize writes so edits made during a save use the latest disk revision.
  const save = async () => {
    clearTimeout(timer);
    if (saving) {
      return saving;
    }
    saving = (async () => {
      try {
        while (dirty()) {
          const text = $('#editor').value;
          status('自动保存中…');
          snapshot = await invoke('save', { path: snapshot.path, text, revision: snapshot.revision });
          document.dispatchEvent(new CustomEvent('coding:saved', { detail: snapshot.path }));
          update();
        }
        status('已自动保存');
        return true;
      } catch (error) {
        console.error('[coding:autosave]', { path: snapshot?.path, error });
        status(`自动保存失败：${error.message} · 草稿已保留`, true);
        return false;
      }
    })();
    try {
      return await saving;
    } finally {
      saving = null;
    }
  };
  const canLeave = async () => {
    if (!dirty() && !saving) {
      return true;
    }
    await save();
    return !dirty() || await confirmAction('自动保存失败，当前修改尚未写入文件。继续将丢弃草稿。', '丢弃草稿并继续');
  };
  const changed = () => {
    update();
    clearTimeout(timer);
    timer = setTimeout(save, 600);
  };
  // Historical and oversized files keep the existing read-only view.
  const open = async () => {
    const file = getFile();
    if (file.revision) {
      return;
    }
    try {
      snapshot = await invoke('edit', { path: file.path });
      const input = $('#editor');
      input.value = snapshot.text;
      $('#source').hidden = true;
      input.hidden = false;
      const offset = snapshot.text.split('\n').slice(0, file.startLine - 1).reduce((size, line) => size + line.length + 1, 0);
      input.focus();
      input.setSelectionRange(offset, offset);
      input.scrollTop = (file.startLine - 1) * parseFloat(getComputedStyle(input).lineHeight);
      update();
      status('编辑中 · 修改后自动保存 · 单文件最多 128 KiB');
    } catch (error) {
      reset();
      console.error('[coding:editor]', { path: file.path, error });
      status(`${error.message} · 当前只读`, true);
    }
  };
  $('#editor').oninput = changed;
  $('#editor').onkeydown = event => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const input = event.target;
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
      changed();
    }
  };
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  });
  return { dirty, canLeave, reset, update, open };
}
