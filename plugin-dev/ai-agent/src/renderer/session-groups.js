import { prepareContextMenu } from '../../../../desk/src/resource/context-menu.js';
import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
import { roleCatalog } from '../shared/agent-roles.js';
import { sessionStatus } from './session-status.js';
import { api, el, field, iconButton, modal, run, setButtonIcon, toast } from './ui.js';

const activity = session => session.exited ? '已退出' : session.blocked ? '等待确认'
  : session.activity === 'working' ? '运行中' : ['idle', 'done'].includes(session.activity) ? '空闲' : '连接中';

// A static node diagram distinguishes collaboration without adding another text label or row height.
function collaborationMarker() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ class: 'group-collaboration-mark', viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(name, value);
  }
  svg.innerHTML = '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/>'
    + '<circle cx="19" cy="18" r="2.5"/><path d="m10.8 7.2-4.6 8.5m7-8.5 4.6 8.5M7.5 18h9"/>';
  return svg;
}

// Sidebar navigation and context actions retain hidden terminal instances and background work.
export function groupNavigation({ select, focus, move, add, rename, remove, archive, presentation, save }) {
  const list = el('div', { class: 'group-list' });
  let previous;
  const node = el('nav', { class: 'session-groups', 'aria-label': '会话组' },
    el('div', { class: 'group-heading' }, el('strong', { text: '会话组' })), list);
  return { node, update(groups, sessions, selected) {
    const signature = JSON.stringify([groups, selected, presentation.expandedGroups, sessions.map(session =>
      [session.id, session.groupId, session.name, session.activity, session.blocked, session.exited, session.coordinator, session.coordinating, session.closing])]);
    if (signature === previous) { return; }
    previous = signature;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.navigation : null;
    list.replaceChildren(...[{ id: '', name: '未分组' }, ...groups.filter(group => !group.archivedAt || sessions.some(session => session.groupId === group.id))].map(group => {
      const members = sessions.filter(session => (session.groupId || '') === group.id)
        .sort((a, b) => Number(Boolean(b.coordinator)) - Number(Boolean(a.coordinator)));
      const button = el('button', { type: 'button', class: 'group-choice', 'aria-current': group.id === selected ? 'page' : null,
        title: group.collaboration ? `${group.name} · 协作模式` : group.name,
        'aria-label': group.collaboration ? `${group.name} · 协作模式` : null,
        'data-navigation': `group:${group.id}`, onclick: () => run(() => {
          if (!presentation.expandedGroups.includes(group.id)) { presentation.expandedGroups.push(group.id); }
          return select(group.id);
        }) },
      group.collaboration ? collaborationMarker() : null,
      el('span', { text: group.name }), el('small', { text: String(members.length) }));
      if (group.id) {
        bindContextMenu(button, point => showNavigationMenu(button, '会话组操作', [
          { label: '修改组名', icon: 'rename', perform: () => rename(group.id) },
          { label: '添加组成员', icon: 'group', perform: () => add(group.id) },
          { label: '归档会话组', icon: 'archive', perform: () => archive(group.id) },
          { label: '删除会话组', icon: 'clear', perform: () => remove(group.id) }
        ], '', point));
      }
      const expanded = presentation.expandedGroups.includes(group.id);
      const disclosure = iconButton(`${expanded ? '收起' : '展开'}${group.name}成员列表`, expanded ? 'chevronDown' : 'chevronRight', () => {
        presentation.expandedGroups = expanded ? presentation.expandedGroups.filter(id => id !== group.id)
          : [...presentation.expandedGroups, group.id];
        this.update(groups, sessions, selected);
        return save();
      });
      disclosure.dataset.navigation = `disclosure:${group.id}`;
      disclosure.setAttribute('aria-expanded', String(expanded));
      const memberList = el('div', { class: 'group-members', id: `group-members-${group.id || 'ungrouped'}`, hidden: !expanded }, ...members.map(session => {
        // Reuse the window's kettle artwork; list styling keeps every state still.
        const status = el('span', { class: 'session-status', 'aria-hidden': 'true' });
        sessionStatus(status, session.blocked ? 'blocked' : session.activity, activity(session));
        const member = el('button', { type: 'button', class: 'group-member', title: `${session.coordinator ? '组管理员' : session.name}${session.coordinator ? ' · 固定成员' : ''} · ${activity(session)}`,
          'data-navigation': `member:${session.id}`, onclick: () => run(() => focus(session.id)) },
          status, el('span', { text: session.coordinator ? '组管理员' : session.name }));
        bindContextMenu(member, point => showNavigationMenu(member, '会话操作', [{
          label: '换组', icon: 'moveGroup', perform: () => move(session.id),
          disabled: Boolean(session.coordinator || session.blocked || session.closing) || !['idle', 'done', 'error'].includes(session.activity),
          title: session.coordinator ? '组管理员为固定成员，不能换组' : '会话空闲后可换组'
        }], '', point));
        return member;
      }));
      disclosure.setAttribute('aria-controls', memberList.id);
      return el('div', { class: 'group-item' }, el('div', { class: 'group-choice-row' }, disclosure, button), memberList);
    }));
    if (focused) { [...list.querySelectorAll('[data-navigation]')].find(button => button.dataset.navigation === focused)?.focus(); }
  } };
}

// Right-click and the keyboard context key expose the same actions without activating navigation.
function bindContextMenu(button, open) {
  button.setAttribute('aria-haspopup', 'menu');
  button.addEventListener('contextmenu', event => { event.preventDefault(); open({ x: event.clientX, y: event.clientY }); });
  button.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      open();
    }
  });
}

// Close the context menu before opening a centered editor, so focus and popup ownership stay separate.
export function showNavigationMenu(anchor, label, actions, className = '', point) {
  document.querySelectorAll('.group-context-menu').forEach(closePopup);
  const menu = el('div', { class: `context-menu group-context-menu ${className}`,
    role: 'menu', 'aria-label': label, tabindex: -1 });
  const action = ({ label, icon, perform, disabled = false, title = label }) => {
    const button = iconButton(label, icon, async () => {
      const closed = new Promise(resolve => menu.addEventListener('toggle', event => {
        if (event.newState === 'closed') { resolve(); }
      }));
      closePopup(menu);
      await closed;
      return perform();
    });
    button.setAttribute('role', 'menuitem');
    button.disabled = disabled;
    button.title = disabled ? title : label;
    button.append(el('span', { text: label }));
    return button;
  };
  menu.append(...actions.map(action));
  menu.addEventListener('toggle', event => {
    if (event.newState === 'closed') { menu.remove(); }
  });
  menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
    event.preventDefault();
    const items = [...menu.querySelectorAll('[role=menuitem]:not(:disabled)')];
    if (!items.length) { return; }
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  document.body.append(menu);
  prepareContextMenu(menu);
  showPopup(menu, anchor, { point });
  (menu.querySelector('[role=menuitem]:not(:disabled)') || menu).focus();
  return menu;
}

export async function renameSessionGroup(pluginId, group) {
  return modal('修改组名', ({ body, actions, finish }) => {
    const name = el('input', { value: group.name, maxlength: 60, required: true });
    body.append(field('组名', name));
    const save = iconButton('保存组名', 'save', async () => {
      if (!name.reportValidity()) { return; }
      save.disabled = true;
      try {
        finish(await api.groups.rename(pluginId, group.id, name.value));
      } finally {
        save.disabled = false;
      }
    }, 'primary');
    actions.append(iconButton('取消', 'close', () => finish(null)), save);
  }, { placement: 'center' });
}

// Confirmation covers stopping tasks while preserving membership and recoverable engine history.
export async function archiveSessionGroup(pluginId, group) {
  return modal('归档会话组', ({ body, actions, finish }) => {
    body.append(el('p', { text: `归档“${group.name}”及所有成员窗口？组内任务将强制停止，会话、上下文和布局会保留，可在历史中恢复。` }));
    const archive = iconButton('确认归档会话组', 'archive', async () => {
      archive.disabled = true;
      try {
        await api.groups.archive(pluginId, group.id);
        finish(true);
      } finally {
        archive.disabled = false;
      }
    }, 'primary');
    actions.append(iconButton('取消', 'close', () => finish(null)), archive);
  }, { placement: 'center' });
}

export async function deleteSessionGroup(pluginId, group) {
  return modal('删除会话组', ({ body, actions, finish }) => {
    body.append(el('p', { text: `删除“${group.name}”？成员会话和历史将保留，并移到“未分组”。` }));
    const remove = iconButton('确认删除会话组', 'clear', async () => {
      remove.disabled = true;
      try {
        await api.groups.delete(pluginId, group.id);
        finish(true);
      } finally {
        remove.disabled = false;
      }
    }, 'danger');
    actions.append(iconButton('取消', 'close', () => finish(null)), remove);
  }, { placement: 'center' });
}

export async function addSessionToGroup(pluginId, group, windowId, focus) {
  const { sessions, archives } = await api.sessions.list(pluginId);
  const available = sessions.filter(session => session.groupId !== group.id && !session.coordinator && !session.blocked && !session.closing
    && ['idle', 'done', 'error'].includes(session.activity));
  const historical = archives.filter(session => !session.coordinator && (!session.nativeDeleted || session.reason === 'context-reset'));
  const hasOptions = available.length + historical.length > 0;
  await modal('添加已有会话', ({ body, actions, finish }) => {
    const options = records => records.map(session => el('option', { value: session.id, text: `${session.name} · ${session.cwd}` }));
    const select = el('select', { 'aria-label': '会话', disabled: !hasOptions },
      available.length ? el('optgroup', { label: '当前会话' }, ...options(available)) : null,
      historical.length ? el('optgroup', { label: '历史会话' }, ...options(historical)) : null);
    body.append(el('p', { text: group.name }), hasOptions ? field('会话', select) : el('p', { text: '没有可添加的会话' }));
    const save = iconButton('移入会话组', 'check', async () => {
      save.disabled = true;
      cancel.disabled = true;
      select.disabled = true;
      try {
        await api.groups.assign(pluginId, select.value, group.id);
        if (historical.some(session => session.id === select.value)) {
          const restored = await api.sessions.restore(pluginId, select.value, windowId);
          await focus(restored.id);
        }
        finish(true);
      } catch (error) {
        console.error('[session:group-add-failed]', { pluginId, sessionId: select.value, groupId: group.id, error: error.stack });
        throw error;
      } finally {
        save.disabled = !hasOptions;
        cancel.disabled = false;
        select.disabled = !hasOptions;
      }
    }, 'primary');
    const cancel = iconButton('取消', 'close', () => finish(null));
    const updateAction = () => setButtonIcon(save,
      historical.some(session => session.id === select.value) ? '移入并恢复会话' : '移入会话组', 'check');
    select.addEventListener('change', updateAction);
    updateAction();
    save.disabled = !hasOptions;
    actions.append(cancel, save);
  }, { placement: 'center' });
}

export async function createSessionGroup(pluginId, adapters, windowId, onCreated) {
  const config = await api.storage.getAdapterConfig(pluginId);
  const roles = roleCatalog(await api.storage.getRoles(pluginId)).items;
  const engines = adapters.filter(adapter => ['codex', 'claude'].includes(adapter.id));
  await modal('创建会话组', ({ body, actions, finish }) => {
    const name = el('input', { name: 'groupName', placeholder: '例如：短剧开发', maxlength: 60, required: true });
    const count = el('input', { name: 'memberCount', type: 'number', min: 1, max: 12, value: 3, required: true });
    const cwd = el('input', { name: 'cwd', value: config.lastCwd || '', required: true, placeholder: '/Users/你的名字/项目' });
    const members = el('div', { class: 'group-member-fields' });
    const rows = [];
    const memberRow = (label, memberName) => {
      const engine = el('select', { 'aria-label': `${label} 引擎` }, ...engines.map(adapter =>
        el('option', { value: adapter.id, text: adapter.name || adapter.id })));
      const permission = el('select', { 'aria-label': `${label} 权限模式` });
      const updatePermission = () => permission.replaceChildren(...(engines.find(adapter => adapter.id === engine.value)?.permissionModes || [])
        .map(mode => el('option', { value: mode.id || mode, text: mode.label || mode, selected: (mode.id || mode) === 'unrestricted' })));
      engine.addEventListener('change', updatePermission);
      updatePermission();
      const directory = el('input', { 'aria-label': `${label} 工作目录`, placeholder: '留空使用默认工作目录' });
      const directoryField = field('工作目录', el('div', { class: 'input-row' }, directory,
        iconButton(`选择${label}工作目录`, 'folder', async () => {
          const path = await api.host.chooseDirectory({ defaultPath: directory.value.trim() || cwd.value.trim() });
          if (path) { directory.value = path; }
        })));
      directoryField.classList.add('group-member-directory');
      return { memberName, engine, permission, directory, row: el('div', { class: 'group-member-field' },
        field(label, memberName), field('引擎', engine), field('权限', permission), directoryField) };
    };
    const collaboration = el('input', { type: 'checkbox', role: 'switch', name: 'collaboration', 'aria-label': '协作模式' });
    const coordinator = memberRow('组管理员会话', el('input', { value: '组管理员', readOnly: true, 'aria-label': '组管理员会话' }));
    const updateMode = () => { coordinator.row.hidden = !collaboration.checked; };
    collaboration.addEventListener('change', updateMode);
    updateMode();
    const resize = () => {
      if (!count.checkValidity()) { return; }
      while (rows.length < Number(count.value)) {
        const index = rows.length;
        const memberName = el('input', { name: `memberName${index}`, value: ['后端', '前端', '测试'][index] || `成员 ${index + 1}`,
          maxlength: 60, required: true, 'aria-label': `成员 ${index + 1} 名称` });
        const row = memberRow(`成员 ${index + 1}`, memberName);
        row.role = el('select', { 'aria-label': `成员 ${index + 1} 角色` },
          el('option', { value: '', text: '不指定角色' }),
          ...roles.map(role => el('option', { value: role.id, text: role.name })));
        row.row.classList.add('with-role');
        row.row.insertBefore(field('角色', row.role), row.row.children[1]);
        rows.push(row);
        members.append(row.row);
      }
      while (rows.length > Number(count.value)) { rows.pop().row.remove(); }
    };
    count.addEventListener('input', resize);
    resize();
    body.append(el('div', { class: 'group-basics' }, field('组名', name), field('成员数量', count)),
      field('默认工作目录', el('div', { class: 'input-row' }, cwd, iconButton('选择工作目录', 'folder', async () => {
        const path = await api.host.chooseDirectory({ defaultPath: cwd.value.trim() });
        if (path) { cwd.value = path; }
      }))), el('label', { class: 'group-collaboration' }, el('span', { text: '协作模式' }), collaboration), coordinator.row, members);
    const start = iconButton('创建会话组', 'check', async () => {
      if (![name, count, cwd, ...rows.map(row => row.memberName)].every(input => input.reportValidity())) { return; }
      const names = rows.map(row => row.memberName.value.trim());
      if (new Set(names).size !== names.length) { throw Error('同组成员名称不能重复'); }
      start.disabled = true;
      cancel.disabled = true;
      try {
        const result = await api.groups.create(pluginId, { name: name.value, cwd: cwd.value, windowId,
          collaboration: collaboration.checked,
          ...(collaboration.checked ? { coordinator: { cwd: coordinator.directory.value.trim(), adapterId: coordinator.engine.value, permission: coordinator.permission.value || 'default' } } : {}),
          members: rows.map(({ memberName, engine, permission, role, directory }) => ({ cwd: directory.value.trim(), name: memberName.value, adapterId: engine.value,
            permission: permission.value || 'default', agentRole: roles.find(item => item.id === role.value) })) });
        finish(result);
        await onCreated(result);
        if (result.errors.length) { toast(result.errors.map(error => `${error.name}：${error.message}`).join('；')); }
      } finally {
        start.disabled = false;
        cancel.disabled = false;
      }
    }, 'primary');
    const cancel = iconButton('取消', 'close', () => finish(null));
    actions.append(cancel, start);
  }, { wide: true, placement: 'center' });
}

export async function assignSessionGroup(pluginId, session, groups) {
  return modal('调整会话分组', ({ body, actions, finish }) => {
    const select = el('select', { 'aria-label': '会话组' }, el('option', { value: '', text: '未分组' }),
      ...groups.filter(group => !group.archivedAt).map(group => el('option', { value: group.id, text: group.name })));
    select.value = session.groupId || '';
    body.append(el('p', { text: session.name }), field('会话组', select));
    actions.append(iconButton('取消', 'close', () => finish(null)), iconButton('保存分组', 'save', async () => {
      finish(await api.groups.assign(pluginId, session.id, select.value));
    }, 'primary'));
  }, { placement: 'center' });
}
