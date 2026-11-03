import { api, el, field, iconButton, modal } from './ui.js';
import './settings-roles.css';
import { groupManagerRole, roleCatalog } from '../shared/agent-roles.js';

// Role templates are independent of engine credentials and saved sessions retain their own snapshots.
export function mountRoles(root, pluginId) {
  async function save(change) {
    try {
      const catalog = roleCatalog(await api.storage.getRoles(pluginId));
      await api.storage.saveRoles(pluginId, { items: change(catalog.items) });
      await refresh();
    } catch (error) {
      console.error('[agent:roles-save]', { pluginId }, error);
      throw error;
    }
  }

  function edit(role) {
    return modal(role ? '编辑角色' : '新增角色', ({ body, actions, finish }) => {
      const name = el('input', { name: 'roleName', value: role?.name || '', maxlength: 60, required: true });
      const instructions = el('textarea', { name: 'roleInstructions', rows: 6, maxlength: 8000, required: true,
        text: role?.instructions || '' });
      body.append(field('角色名称', name), field('职责说明', instructions));
      actions.append(iconButton('取消', 'close', () => finish(null)), iconButton('保存角色', 'save', async () => {
        if (!name.reportValidity() || !instructions.reportValidity()) { return; }
        const item = { id: role?.id || crypto.randomUUID(), name: name.value.trim(), instructions: instructions.value.trim() };
        await save(items => role ? items.map(value => value.id === role.id ? item : value) : [...items, item]);
        finish(true);
      }, 'primary'));
    }, { placement: 'center' });
  }

  function remove(role) {
    return modal('删除角色', ({ body, actions, finish }) => {
      body.append(el('p', { text: `删除角色“${role.name}”？已创建会话的角色职责仍会保留。` }));
      actions.append(iconButton('取消', 'close', () => finish(null)), iconButton('删除角色', 'clear', async () => {
        await save(items => items.filter(item => item.id !== role.id));
        finish(true);
      }, 'danger'));
    }, { placement: 'center' });
  }

  async function refresh() {
    try {
      const { items } = roleCatalog(await api.storage.getRoles(pluginId));
      root.replaceChildren(el('div', { class: 'actions' }, iconButton('新增角色', 'create', () => edit())));
      if (!items.length) { root.append(el('p', { class: 'muted', text: '暂无角色' })); }
      for (const role of items) {
        root.append(el('article', {}, el('div', { class: 'role-summary' }, el('strong', { text: role.name }),
          el('p', { class: 'muted', text: role.instructions })), el('div', { class: 'role-actions' },
          iconButton('编辑角色', 'rename', () => edit(role)), ...(role.id === groupManagerRole.id ? [] : [iconButton('删除角色', 'clear', () => remove(role), 'danger')]))));
      }
    } catch (error) {
      root.replaceChildren(el('p', { role: 'alert', text: error.message }));
      console.error('[agent:roles-load]', { pluginId }, error);
      throw error;
    }
  }
  return { refresh };
}

// Role maintenance is a workspace action, separate from engine connection settings.
export function showRoles(pluginId) {
  return modal('角色维护', ({ body, actions, finish, dialog }) => {
    dialog.classList.add('roles-dialog');
    const manager = el('div', { id: 'role-manager' });
    body.append(manager);
    const controls = mountRoles(manager, pluginId);
    void controls.refresh().catch(() => { /* The role list displays and logs the load failure. */ });
    actions.append(iconButton('完成', 'check', () => finish(true), 'primary'));
  }, { placement: 'center' });
}
