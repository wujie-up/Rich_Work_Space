import { prepareContextMenu } from '../../../../desk/src/resource/context-menu.js';
import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
import { invoke, escape } from './bridge.js';
import { fileLabel } from './file-label.js';

const $ = selector => document.querySelector(selector);
const reference = button => ({ root: button.dataset.root, path: button.dataset.path });
const identity = file => `${file.root}/${file.path}`.replace(/\/+/g, '/');
// An explicit status keeps missing files recognizable even when the file name is short.
const missingNotice = '<span class="file-missing" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 2 21h20zM12 9v5m0 3v1"/></svg>文件不存在</span>';

// Keep grouping UI separate from document/draft state; every mutation uses the latest queued backend state.
export function setupFileGroups({ action, openFile, highlight }) {
  let groups = [];
  let active = 'ungrouped';
  let dragging;
  const files = $('#group-files');
  const historyPanel = $('#history-panel');
  const historyToggle = $('#history-toggle');
  const sidebar = $('#files');
  const createMenu = $('#group-create-menu');

  // This plugin-only action follows the host language without adding a host catalog dependency.
  function translateCreateMenu() {
    const label = document.documentElement.lang === 'en' ? 'New group' : '新建分组';
    Object.assign($('#add-group').dataset, { menuLabel: label, menuTitle: label });
    prepareContextMenu(createMenu);
  }
  translateCreateMenu();
  new MutationObserver(translateCreateMenu).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  function render() {
    if (active !== 'drafts' && !groups.some(group => group.id === active)) {
      active = 'ungrouped';
    }
    // Preserve folds when an operation refreshes the list, without duplicating persisted group state.
    const folded = new Set([...files.querySelectorAll('details:not([open])')].map(node => node.dataset.group));
    files.innerHTML = groups.map(group => `<details class="file-group" data-group="${escape(group.id)}" ${folded.has(group.id) ? '' : 'open'}>
      <summary title="${escape(group.name)}${group.id === 'ungrouped' ? '' : ' · 右键或 Shift+F10 重命名、删除分组'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg><span>${escape(group.name)}</span></summary>
      <div class="group-contents">${group.files.map(file => `<button draggable="true" data-root="${escape(file.root)}" data-path="${escape(file.path)}" data-missing="${Boolean(file.missing)}" aria-label="${escape(file.name)}" aria-description="${file.missing ? '文件不存在' : ''}" title="${escape(identity(file))}">${fileLabel(file.name)}${file.missing ? missingNotice : ''}</button>`).join('') || '<p>此分组暂无文件</p>'}</div>
    </details>`).join('');
    $('#group-empty').hidden = true;
    setActive(active);
    highlight();
  }

  function setActive(groupId) {
    active = groupId;
    document.querySelectorAll('#files details').forEach(node => {
      node.dataset.active = String(node.dataset.group === active);
    });
    $('#group-settings').disabled = ['ungrouped', 'drafts'].includes(active);
  }

  function expandActive() {
    const group = [...files.querySelectorAll('details')].find(node => node.dataset.group === active);
    if (group) {
      group.open = true;
    }
  }

  function select(file) {
    const group = groups.find(entry => entry.files.some(item => identity(item) === identity(file)));
    if (group) {
      active = group.id;
      render();
      expandActive();
    }
  }

  async function refresh() {
    try {
      ({ groups } = await invoke('editor.groups'));
      $('#group-empty').textContent = '此分组暂无文件';
      render();
      if (historyPanel.matches(':popover-open')) {
        await refreshHistory();
      }
    } catch (error) {
      // Retain the last usable list while the normal document editor remains available.
      console.error('[text-editor:groups] refresh failed', { pluginId: 'text-editor', groupId: active }, error);
      $('#group-empty').hidden = false;
      $('#group-empty').textContent = `分组加载失败：${error.message}`;
    }
  }

  async function change(update) {
    ({ groups } = await invoke('editor.organize', update));
    if (update.action === 'create') {
      active = groups.at(-1).id;
    } else if (update.action === 'move') {
      active = update.groupId;
    }
    $('#group-empty').textContent = '此分组暂无文件';
    render();
    if (['create', 'move'].includes(update.action)) {
      expandActive();
    }
  }

  async function refreshHistory() {
    const history = await invoke('editor.history');
    $('#history').innerHTML = history.map(file => `<button data-root="${escape(file.root)}" data-path="${escape(file.path)}" data-missing="${Boolean(file.missing)}" aria-label="${escape(file.name)}" aria-description="${file.missing ? '文件不存在' : ''}" title="${escape(identity(file))}">${fileLabel(file.name)}${file.missing ? missingNotice : ''}</button>`).join('');
    $('#history-empty').hidden = history.length > 0;
    highlight();
  }

  historyToggle.onclick = () => action(async () => {
    if (historyPanel.matches(':popover-open')) {
      closePopup(historyPanel);
      return;
    }
    await refreshHistory();
    showPopup(historyPanel, historyToggle);
    historyPanel.querySelector('button')?.focus();
  });
  historyPanel.addEventListener('toggle', event => {
    historyToggle.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  $('#history-close').onclick = () => closePopup(historyPanel);
  $('#history').onclick = event => action(async () => {
    const button = event.target.closest('button[data-path]');
    if (!button) {
      return;
    }
    await openFile(button.dataset.path, button.dataset.root);
    closePopup(historyPanel);
  });
  files.onclick = event => action(async () => {
    const button = event.target.closest('button[data-path]');
    if (button) {
      await openFile(button.dataset.path, button.dataset.root);
    }
  });
  files.addEventListener('click', event => {
    const heading = event.target.closest('summary');
    if (heading) {
      setActive(heading.parentElement.dataset.group);
    }
  });
  files.addEventListener('contextmenu', event => {
    const heading = event.target.closest('summary');
    if (heading) {
      event.preventDefault();
      openGroupMenu(heading, heading.parentElement.dataset.group, { x: event.clientX, y: event.clientY });
    }
  });
  sidebar.addEventListener('contextmenu', event => {
    if (event.defaultPrevented || event.target.closest('button,summary')) {
      return;
    }
    event.preventDefault();
    sidebar.focus({ preventScroll: true });
    openGroupMenu(sidebar, undefined, { x: event.clientX, y: event.clientY });
  });
  sidebar.addEventListener('keydown', event => {
    if (event.target === sidebar && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault();
      openGroupMenu(sidebar);
    }
  });
  files.addEventListener('keydown', event => {
    const heading = event.target.closest('summary');
    if (!heading || event.altKey) {
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      openGroupMenu(heading, heading.parentElement.dataset.group);
      return;
    }
    const headings = [...files.querySelectorAll('summary')];
    const index = headings.indexOf(heading);
    const next = ({ ArrowDown: Math.min(index + 1, headings.length - 1), ArrowUp: Math.max(index - 1, 0),
      Home: 0, End: headings.length - 1 })[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setActive(headings[next].parentElement.dataset.group);
      headings[next].focus();
    } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      setActive(heading.parentElement.dataset.group);
      heading.parentElement.open = event.key === 'ArrowRight';
    }
  });

  function openGroupMenu(anchor, groupId, point) {
    // Context actions follow the targeted heading, even when another group was previously active.
    if (groupId) {
      setActive(groupId);
      if (['ungrouped', 'drafts'].includes(active)) {
        return;
      }
    }
    const menu = groupId ? $('#group-menu') : createMenu;
    document.body.append(menu);
    prepareContextMenu(menu);
    showPopup(menu, anchor, { point });
    menu.querySelector('button').focus();
  }

  function editGroup(method) {
    const group = groups.find(entry => entry.id === active);
    const dialog = $('#group-dialog');
    const input = dialog.querySelector('input');
    $('#group-dialog-title').textContent = ({ create: '新建分组', rename: '重命名分组', delete: '删除分组' })[method];
    dialog.querySelector('label').hidden = method === 'delete';
    dialog.querySelector('p').hidden = method !== 'delete';
    dialog.querySelector('p').textContent = `删除“${group?.name}”分组？文件将移回未分组，磁盘文件保留。`;
    input.value = method === 'rename' ? group.name : '';
    input.required = method !== 'delete';
    dialog.returnValue = '';
    const update = { action: method, groupId: active };
    const confirm = dialog.querySelector('[data-confirm]');
    confirm.onclick = () => action(async () => {
      if (method !== 'delete' && (!input.reportValidity() || !input.value.trim())) {
        return;
      }
      // Block repeated submissions while IPC is pending and close both dialog and popover states together.
      confirm.disabled = true;
      try {
        await change({ ...update, name: input.value });
        dialog.returnValue = 'confirm';
        closePopup(dialog);
        document.querySelectorAll('#group-menu,#group-create-menu').forEach(closePopup);
      } finally {
        confirm.disabled = false;
      }
    });
    input.onkeydown = event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        dialog.querySelector('[data-confirm]').click();
      }
    };
    dialog.querySelector('[data-cancel]').onclick = () => closePopup(dialog);
    // Shared popups can retain a closed parent; reattach before choosing the next anchor.
    document.body.append(dialog);
    showPopup(dialog);
    if (method !== 'delete') {
      input.select();
    }
  }
  $('#group-settings').onclick = () => openGroupMenu($('#group-settings'), active);
  document.querySelectorAll('#group-menu,#group-create-menu').forEach(menu => {
    menu.onclick = event => {
      const button = event.target.closest('button[data-action]');
      if (button) {
        // Keep the parent menu in the popup stack so Escape only cancels the group form.
        editGroup(button.dataset.action);
      }
    };
  });

  files.ondragstart = event => {
    const button = event.target.closest('button[data-path]');
    if (!button) {
      return;
    }
    dragging = reference(button);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', identity(dragging));
    button.classList.add('dragging');
  };
  const clearDrag = () => {
    document.querySelectorAll('.drop-target,.dragging').forEach(node => node.classList.remove('drop-target', 'dragging'));
  };
  $('#files').ondragover = event => {
    if (!dragging || !event.target.closest('.file-group:not([data-group=drafts])')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDrag();
    event.target.closest('button,summary')?.classList.add('drop-target');
  };
  $('#files').ondrop = event => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    const group = event.target.closest('.file-group');
    const target = event.target.closest('#group-files button');
    const file = dragging;
    dragging = null;
    clearDrag();
    if (!group || group.dataset.group === 'drafts') {
      return;
    }
    const buttons = [...group.querySelectorAll('button')];
    const after = target && event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
    const before = target && (after ? buttons[buttons.indexOf(target) + 1] : target);
    action(() => change({ action: 'move', groupId: group.dataset.group, file, before: before ? reference(before) : undefined }));
  };
  files.ondragend = () => {
    dragging = null;
    clearDrag();
  };
  files.onkeydown = event => {
    const button = event.target.closest('button[data-path]');
    if (!button || !event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    action(async () => {
      const file = reference(button);
      const group = button.closest('.file-group');
      const buttons = [...group.querySelectorAll('button')];
      const index = buttons.indexOf(button);
      const groupIndex = groups.findIndex(entry => entry.id === group.dataset.group);
      const horizontal = ['ArrowLeft', 'ArrowRight'].includes(event.key);
      const groupId = horizontal ? groups[groupIndex + (event.key === 'ArrowLeft' ? -1 : 1)]?.id : group.dataset.group;
      if (!groupId || (event.key === 'ArrowUp' && index === 0) || (event.key === 'ArrowDown' && index === buttons.length - 1)) {
        return;
      }
      const before = horizontal ? null : buttons[index + (event.key === 'ArrowUp' ? -1 : 2)];
      await change({ action: 'move', groupId, file, before: before ? reference(before) : undefined });
      [...files.querySelectorAll('button')].find(node => identity(reference(node)) === identity(file))?.focus();
    });
  };
  const draftHeading = $('#draft-group summary');
  draftHeading.onclick = () => setActive('drafts');
  draftHeading.oncontextmenu = event => {
    event.preventDefault();
    setActive('drafts');
  };
  draftHeading.onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      $('#draft-group').open = event.key === 'ArrowRight';
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      setActive('drafts');
    }
  };
  return { refresh, refreshHistory, select, selectDraft: () => setActive('drafts'),
    active: () => active === 'drafts' ? 'ungrouped' : active };
}
