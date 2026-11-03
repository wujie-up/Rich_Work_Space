import { prepareContextMenu } from '../../../../desk/src/resource/context-menu.js';
import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
import { escape } from './api.js';

const ICONS = { cancel: 'm6 6 12 12M6 18 18 6', confirm: 'm5 12 4 4L19 6',
  rename: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z', remove: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  add: 'M12 5v14 M5 12h14' };
const button = (action, title, icon) => `<button type="button" class="icon-button" data-${action}
  title="${title}" aria-label="${title}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[icon]}"/></svg></button>`;

// The directory is independent of definitions; membership changes never save pending canvas edits.
export function createWorkflowGroups({ invoke, setStatus, render: refresh, getWorkflows, current, onSelect, onCreate,
  getActivity, getSchedule, onReorder }) {
  let groups = [];
  const load = async () => { groups = await invoke('workflows.groups', { includeUngrouped: true }); };
  const members = group => getWorkflows().filter(workflow => (workflow.groupId || '') === group.id);
  let draggedId;
  let draggedGroupId;
  let reordering = false;
  const item = workflow => {
    const info = getActivity?.(workflow.id);
    const activity = info?.state;
    const label = info?.label;
    const schedule = getSchedule?.(workflow.id);
    const scheduled = schedule?.enabled && ['once', 'daily', 'interval'].includes(schedule.mode);
    const scheduleLabel = scheduled ? schedule.mode === 'once' && schedule.nextAt == null ? '单次定时已结束' : '定时已启用' : '';
    return `<button type="button" class="list-item ${workflow.id === current()?.id ? 'selected' : ''}"
      data-workflow="${escape(workflow.id)}" title="${escape(workflow.name)}${label ? ` · ${label}` : ''}${scheduleLabel ? ` · ${scheduleLabel}` : ''}">
      ${activity ? `<svg class="workflow-activity" data-activity="${activity}" viewBox="0 0 24 24" role="img" aria-label="${label}">
      <path d="M3 3h6v6H3Z M15 15h6v6h-6Z M6 9v9h9 M9 6h9v9"/><circle cx="18" cy="6" r="4"/></svg>` : ''}
      ${scheduled ? `<svg class="workflow-schedule" viewBox="0 0 24 24" role="img" aria-label="${scheduleLabel}">
      <circle cx="12" cy="13" r="8"/><path d="M12 8v5l3 2 M9 2h6 M12 2v3 M18 5l2 2"/></svg>` : ''}
      <span>${escape(workflow.name)}</span></button>`;
  };
  const row = workflow => `<div class="workflow-row" data-workflow-row="${escape(workflow.id)}"
    draggable="${!reordering}">${item(workflow)}</div>`;

  // Reordering changes only saved directory slots, never definitions or pending edits.
  async function reorder(container, workflowId, targetId, position) {
    if (reordering || workflowId === targetId) { return; }
    reordering = true;
    try {
      const order = await invoke('workflows.reorder', { workflowId, targetId, position });
      onReorder(order);
    } catch (error) {
      console.error('[workflow:reorder-failed]', { workflowId, targetId }, error);
      setStatus(error.message, true);
    } finally {
      reordering = false;
      render(container);
      [...container.querySelectorAll('[data-workflow]')].find(control => control.dataset.workflow === workflowId)?.focus();
    }
  }

  // Group ordering has its own gesture and storage operation; member dragging stays within its group.
  async function reorderGroups(container, id, targetId, position) {
    if (reordering || id === targetId) { return; }
    reordering = true;
    try {
      const order = await invoke('workflows.reorderGroups', { id, targetId, position });
      groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    } catch (error) {
      console.error('[workflow:group-reorder-failed]', { groupId: id, targetId }, error);
      setStatus(error.message, true);
    } finally {
      reordering = false;
      render(container);
      focusGroup(id);
    }
  }

  function membership(workflow, group) {
    delete workflow.group;
    delete workflow.groupId;
    if (group?.id) { Object.assign(workflow, { groupId: group.id, group: group.name }); }
  }

  function focusGroup(id) {
    [...document.querySelectorAll('.workflow-group')].find(details => details.dataset.groupId === id)
      ?.querySelector('summary').focus();
  }

  // Close the menu before opening an editor so popup ownership and focus stay with the group heading.
  function openGroupMenu(group, anchor, point) {
    document.querySelectorAll('.workflow-group-menu').forEach(closePopup);
    const menu = document.createElement('div');
    menu.className = 'context-menu workflow-group-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '工作流分组操作');
    const actions = group.id ? [
      ['rename', '重命名分组', rename], ['add', '新建工作流', onCreate], ['remove', '删除分组', remove]
    ] : [['add', '新建工作流', onCreate]];
    menu.innerHTML = actions.map(([action, title]) => button(action, title, action)).join('');
    for (const [action, title, perform] of actions) {
      const control = menu.querySelector(`[data-${action}]`);
      control.setAttribute('role', 'menuitem');
      const label = document.createElement('span');
      label.textContent = title;
      control.append(label);
      control.onclick = async () => {
        const closed = new Promise(resolve => menu.addEventListener('toggle', event => {
          if (event.newState === 'closed') { resolve(); }
        }));
        closePopup(menu);
        await closed;
        try {
          await perform(group.id ? group : undefined, anchor);
        } catch (error) {
          console.error('[workflow:group-action-failed]', { groupId: group.id, action }, error);
          setStatus(error.message, true);
        }
      };
    }
    menu.addEventListener('toggle', event => {
      if (event.newState === 'closed') { menu.remove(); }
    });
    menu.onkeydown = event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
      event.preventDefault();
      const items = [...menu.querySelectorAll('[role=menuitem]')];
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    document.body.append(menu);
    prepareContextMenu(menu);
    showPopup(menu, anchor, { point });
    menu.querySelector('[role=menuitem]').focus();
  }

  function render(container) {
    // The default group shares directory interactions without changing legacy membership data.
    const ungrouped = groups.find(group => !group.id);
    if (ungrouped) { ungrouped.collapsed = container.querySelector('.workflow-ungrouped')?.open === false; }
    const directory = groups;
    container.innerHTML = directory.map(group => {
      const workflows = members(group);
      return `<details class="workflow-group${group.id ? '' : ' workflow-ungrouped'}"
        data-group-id="${escape(group.id)}" ${group.collapsed ? '' : 'open'}>
        <summary title="${escape(group.name)}" aria-haspopup="menu" draggable="${!reordering}"><svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 5 7 7-7 7"/></svg><span>${escape(group.name)}</span><small>${workflows.length}</small></summary>
        <div>${workflows.map(row).join('')}${workflows.length ? '' : '<p class="empty-group">暂无工作流</p>'}</div></details>`;
    }).join('');
    for (const details of container.querySelectorAll('.workflow-group')) {
      const group = directory.find(group => group.id === details.dataset.groupId);
      const heading = details.querySelector('summary');
      heading.ondragstart = event => {
        if (reordering) { event.preventDefault(); return; }
        draggedGroupId = group.id;
        draggedId = null;
        event.dataTransfer.setData('text/plain', group.id || 'ungrouped');
        event.dataTransfer.effectAllowed = 'move';
      };
      heading.ondragover = event => {
        if (reordering || draggedGroupId === undefined || draggedGroupId === group.id) { return; }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const box = heading.getBoundingClientRect();
        heading.dataset.dropPosition = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
      };
      heading.ondragleave = () => { delete heading.dataset.dropPosition; };
      heading.ondrop = event => {
        if (draggedGroupId === undefined) { return; }
        event.preventDefault();
        const box = heading.getBoundingClientRect();
        reorderGroups(container, draggedGroupId, group.id, event.clientY < box.top + box.height / 2 ? 'before' : 'after');
        draggedGroupId = undefined;
      };
      heading.ondragend = () => {
        draggedGroupId = undefined;
        container.querySelectorAll('[data-drop-position]').forEach(node => { delete node.dataset.dropPosition; });
      };
      heading.oncontextmenu = event => {
        event.preventDefault();
        openGroupMenu(group, heading, { x: event.clientX, y: event.clientY });
      };
      heading.onkeydown = event => {
        if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const index = directory.indexOf(group) + (event.key === 'ArrowUp' ? -1 : 1);
          if (directory[index]) {
            reorderGroups(container, group.id, directory[index].id, event.key === 'ArrowUp' ? 'before' : 'after');
          }
          return;
        }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          openGroupMenu(group, heading);
        }
      };
      const workflows = members(group);
      for (const row of details.querySelectorAll('[data-workflow-row]')) {
        row.ondragstart = event => {
          if (reordering) { event.preventDefault(); return; }
          draggedId = row.dataset.workflowRow;
          draggedGroupId = undefined;
          event.dataTransfer.setData('text/plain', draggedId);
          event.dataTransfer.effectAllowed = 'move';
        };
        row.ondragover = event => {
          if (!reordering && workflows.some(workflow => workflow.id === draggedId) && draggedId !== row.dataset.workflowRow) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        };
        row.ondrop = event => {
          event.preventDefault();
          if (!workflows.some(workflow => workflow.id === draggedId)) { return; }
          const box = row.getBoundingClientRect();
          const position = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
          reorder(container, draggedId, row.dataset.workflowRow, position);
          draggedId = null;
        };
        row.ondragend = () => { draggedId = null; };
      }
      details.ontoggle = async () => {
        const collapsed = !details.open;
        // Initial toggle events also fire when rendering an already-open details element.
        if (!details.isConnected || group.collapsed === collapsed) { return; }
        group.collapsed = collapsed;
        if (!group.id) { return; }
        try {
          await invoke('workflows.setGroupCollapsed', { id: group.id, collapsed });
        } catch (cause) {
          if (group.collapsed === collapsed) { group.collapsed = !collapsed; refresh(); }
          setStatus(cause.message, true);
        }
      };
    }
    for (const control of container.querySelectorAll('[data-workflow]')) {
      control.onclick = () => onSelect(control.dataset.workflow);
    }
  }

  // All group popovers share cancellation, write protection and inline errors.
  function popup(title, content, confirmTitle, anchor, save) {
    const dialog = document.createElement('dialog');
    dialog.className = 'workflow-group-dialog';
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `${content}<p class="error" role="alert"></p><footer>
      ${button('cancel', '取消', 'cancel')}${button('confirm', confirmTitle, 'confirm')}</footer>`;
    const controls = [...dialog.querySelectorAll('button, input, select')];
    const confirm = dialog.querySelector('[data-confirm]');
    const error = dialog.querySelector('[role="alert"]');
    dialog.addEventListener('cancel', event => {
      if (confirm.disabled) { event.preventDefault(); }
    });
    dialog.oninput = () => { error.textContent = ''; };
    confirm.onclick = async () => {
      controls.forEach(control => { control.disabled = true; });
      try {
        await save(dialog);
        dialog.close();
      } catch (cause) {
        error.textContent = cause.message;
      } finally {
        controls.forEach(control => { control.disabled = false; });
      }
    };
    dialog.onkeydown = event => {
      if (event.key === 'Enter' && event.target.matches('input, select')) { event.preventDefault(); confirm.click(); }
    };
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    showPopup(dialog, anchor, { placement: 'center' });
    return dialog;
  }

  function editName(group, anchor) {
    const dialog = popup(group ? '重命名分组' : '新建分组', '<label>分组名称<input name="name" autocomplete="off"></label>',
      group ? '保存分组名称' : '创建分组', anchor, async panel => {
        const name = panel.querySelector('input').value.trim();
        if (!name) { throw Error('请输入分组名称'); }
        if (groups.some(item => item.name === name && item.id !== group?.id)) {
          throw Error('该分组名称已存在，请使用其他名称');
        }
        if (name === group?.name) { return; }
        if (group) {
          await invoke('workflows.renameGroup', { id: group.id, name });
          group.name = name;
          members(group).forEach(workflow => membership(workflow, group));
        } else {
          await invoke('workflows.createGroup', { name });
          await load();
        }
        refresh();
        if (group) { focusGroup(group.id); }
        setStatus(group ? `分组已重命名：${name}` : `分组已创建：${name}`);
      });
    const input = dialog.querySelector('input');
    input.value = group?.name || '';
    input.focus();
    input.select();
  }

  function rename(group, anchor) { editName(group, anchor); }
  function create(anchor) { editName(null, anchor); }

  function remove(group, anchor) {
    const count = members(group).length;
    const dialog = popup('删除分组', `<p>删除分组“${escape(group.name)}”？</p><p>其中 ${count} 个工作流将移至“未分组”，
      工作流内容、运行进度和历史记录均保留。</p>`, '确认删除分组', anchor, async () => {
      await invoke('workflows.removeGroup', { id: group.id });
      members(group).forEach(workflow => membership(workflow));
      groups = groups.filter(item => item.id !== group.id);
      refresh();
      document.querySelector('#new-group').focus();
      setStatus('分组已删除，工作流已移至未分组。');
    });
    dialog.querySelector('[data-cancel]').focus();
  }

  function open(anchor) {
    const workflow = current();
    if (!workflow) { return; }
    const dialog = popup('工作流分组', `<label>所属分组<select name="group"><option value="">未分组</option>${groups.filter(group => group.id).map(group =>
      `<option value="${escape(group.id)}">${escape(group.name)}</option>`).join('')}</select></label>
      <small>可通过左侧文件夹加号新建分组。</small>`, '确认分组', anchor, async panel => {
        const groupId = panel.querySelector('select').value;
        const group = groups.find(item => item.id === groupId);
        await invoke('workflows.moveGroup', { workflowId: workflow.id, groupId });
        membership(workflow, group);
        refresh();
        setStatus('分组已保存。');
      });
    dialog.querySelector('select').value = workflow.groupId || '';
    dialog.querySelector('select').focus();
  }

  return { load, render, open, create };
}
