import { showPopup } from '../../../../desk/src/resource/popup.js';
import { escape } from './api.js';
import { KIND_TAGS } from '../shared/node-categories.js';

// Capability choices stay in the dialog; opening or cancelling never changes the canvas.
export function createNodePicker({ getTypes, onAdd }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'node-picker user-input-dialog';
  dialog.setAttribute('aria-label', '添加节点');
  dialog.innerHTML = `<h2>添加节点</h2><label>功能分类<select id="node-category"></select></label>
    <label>基础能力<select id="node-capability"></select></label><p class="hint" data-description></p>
    <footer><span class="spacer"></span><button type="button" data-cancel class="icon-button" title="取消" aria-label="取消"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
    <button type="button" data-add class="icon-button" title="添加" aria-label="添加"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></footer>`;
  document.body.append(dialog);
  const category = dialog.querySelector('#node-category');
  const capability = dialog.querySelector('#node-capability');
  category.innerHTML = Object.entries(KIND_TAGS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  function describe() {
    dialog.querySelector('[data-description]').textContent = getTypes().find(type => type.type === capability.value)?.summary || '';
  }
  function refresh() {
    const types = getTypes().filter(type => type.kind === category.value && (!type.manual || type.type === 'flow.user-input'));
    capability.innerHTML = types.map(type => `<option value="${escape(type.type)}">${escape(type.label)}</option>`).join('');
    dialog.querySelector('[data-add]').disabled = !types.length;
    describe();
  }
  category.onchange = refresh;
  capability.onchange = describe;
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  dialog.querySelector('[data-add]').onclick = () => {
    onAdd(capability.value);
    dialog.close();
  };
  return { open() { refresh(); showPopup(dialog); category.focus(); } };
}
