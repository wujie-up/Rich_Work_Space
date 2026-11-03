import { showPopup } from '../../../../desk/src/resource/popup.js';
import { escape } from './api.js';

const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const cancel = icon('m6 6 12 12M6 18 18 6');
const confirm = icon('m5 12 4 4L19 6');

// Import previews never touch the draft; only an explicit successful import replaces the selected definition.
export function createWorkflowTransfer({ invoke, chooseFile, chooseDirectory, current, onImported, setStatus }) {
  let busy = false;

  async function openImport() {
    if (busy) { return; }
    busy = true;
    try {
      const path = await chooseFile({ title: '导入工作流 JSON', extensions: ['json'] });
      if (!path) { return; }
      const [preview, workflows] = await Promise.all([invoke('workflows.inspect', path), invoke('workflows.list')]);
      const dialog = document.createElement('dialog');
      dialog.className = 'user-input-dialog workflow-transfer-dialog';
      dialog.setAttribute('aria-label', '导入工作流');
      dialog.innerHTML = `<h2>导入工作流</h2><p data-summary></p>
        <label>导入方式<select data-target><option value="">新建工作流</option>${workflows.map(workflow =>
          `<option value="${escape(workflow.id)}">更新：${escape(workflow.name)}</option>`).join('')}</select></label>
        <p>导入后仅手动运行。已有运行记录与暂停快照保留，继续暂停流程时仍使用原定义。</p>
        <p data-warnings></p><p data-overwrite hidden></p><p class="error" role="alert" data-error></p>
        <footer><span class="spacer"></span><button type="button" class="icon-button" data-cancel title="取消" aria-label="取消">${cancel}</button>
        <button type="button" class="icon-button primary" data-import title="导入" aria-label="导入">${icon('M8 8V3h8l5 5v13H8v-3 M16 3v5h5 M3 13h11 m-4-4 4 4-4 4')}</button></footer>`;
      dialog.querySelector('[data-summary]').textContent = `${preview.document.workflow.name} · ${preview.document.workflow.nodes.length} 个节点`;
      dialog.querySelector('[data-warnings]').textContent = preview.warnings.join('；');
      const target = dialog.querySelector('[data-target]');
      target.onchange = () => {
        const warning = dialog.querySelector('[data-overwrite]');
        warning.hidden = !target.value;
        warning.textContent = '将替换所选工作流的名称、节点、参数和连线，包括尚未保存的编辑；其他流程不变。';
      };
      const cancelButton = dialog.querySelector('[data-cancel]');
      cancelButton.onclick = () => dialog.close();
      const button = dialog.querySelector('[data-import]');
      // Once persistence starts, closing cannot truthfully mean canceling the import.
      dialog.addEventListener('cancel', event => {
        if (button.disabled) { event.preventDefault(); }
      });
      button.onclick = async () => {
        if (target.value && !await confirmUpdate(workflows.find(workflow => workflow.id === target.value).name)) { return; }
        button.disabled = true;
        target.disabled = true;
        cancelButton.disabled = true;
        try {
          const result = await invoke('workflows.import', { document: preview.document, targetId: target.value || undefined,
            confirmed: Boolean(target.value) });
          dialog.close();
          await onImported(result.workflow);
          setStatus(`已导入：${result.workflow.name}${result.warnings.length ? `；${result.warnings.join('；')}` : ''}`);
        } catch (error) {
          dialog.querySelector('[data-error]').textContent = error.message;
        } finally {
          button.disabled = false;
          target.disabled = false;
          cancelButton.disabled = false;
        }
      };
      document.body.append(dialog);
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        showPopup(dialog);
      });
      dialog.remove();
    } finally {
      busy = false;
    }
  }

  return {
    openImport,
    async exportCurrent() {
      const workflow = current();
      if (!workflow) { return; }
      // Capture the edited definition before a native picker can move focus to another window.
      const draft = structuredClone(workflow);
      const directory = await chooseDirectory();
      if (!directory) { return; }
      const result = await invoke('workflows.export', { workflow: draft, directory });
      setStatus(`已导出：${result.path}`);
    }
  };
}

async function confirmUpdate(name) {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog';
  dialog.setAttribute('aria-label', '确认更新工作流');
  dialog.innerHTML = `<h2>更新已有工作流</h2><p></p><footer><span class="spacer"></span>
    <button type="button" class="icon-button" data-cancel title="取消" aria-label="取消">${cancel}</button>
    <button type="button" class="icon-button" data-confirm title="确认更新" aria-label="确认更新">${confirm}</button></footer>`;
  dialog.querySelector('p').textContent = `确认用导入的定义替换“${name}”？此工作流尚未保存的编辑也会被替换。运行历史和暂停快照保留。`;
  document.body.append(dialog);
  const confirmed = await new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
    dialog.querySelector('[data-confirm]').onclick = () => dialog.close('confirm');
    showPopup(dialog);
  });
  dialog.remove();
  return confirmed;
}
