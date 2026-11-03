import { api, el, iconButton, modal, confirm, field, setButtonIcon } from './ui.js';
import { restoreSessionBatch, restoreWhenReady } from './session-recovery.js';
import { showRestoreProgress } from './restore-progress.js';
import { mountTerminal } from './terminal.js';
import { assignSessionGroup } from './session-groups.js';

const closeReasons = { 'group-archived': '会话组归档', interrupted: '异常中断 · 自动恢复', quit: '工作台退出 · 自动恢复', closed: '手动归档',
  close: '手动关闭插件', disable: '手动禁用插件', remove: '手动卸载插件', deleted: '手动删除未完成', exited: '正常退出', retried: '已重试' };

export async function showHistory(pluginId, adapters, focus, windowId) {
  const { archives, groups = [] } = await api.sessions.list(pluginId);
  await modal('会话历史', ({ body, actions, finish, dialog }) => {
    body.classList.add('history-list');
    dialog.classList.add('history-dialog');
    const pending = new Map();
    const sections = new Map();
    const historyGroupId = groupId => groups.some(group => group.id === groupId) ? groupId : '';
    const status = el('p', { role: 'status', hidden: true });
    dialog.setAttribute('aria-busy', 'false');
    dialog.addEventListener('cancel', event => {
      if (dialog.getAttribute('aria-busy') === 'true') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    const empty = el('div', { class: 'empty', text: '还没有归档会话。关闭的会话会保存在这里。' });
    const update = () => {
      restoreAll.disabled = !pending.size;
      empty.hidden = Boolean(body.querySelector('.history-row'));
      for (const [groupId, section] of sections) {
        const count = section.list.children.length;
        section.node.hidden = !count;
        section.count.textContent = String(count);
        section.restore.disabled = ![...pending.values()].some(entry => historyGroupId(entry.session.groupId) === groupId);
      }
    };
    // Start engines sequentially so a failed session cannot block the rest or cause a startup burst.
    const restoreBatch = async entries => {
      if (dialog.getAttribute('aria-busy') === 'true') {
        return;
      }
      const buttons = [...dialog.querySelectorAll('button')];
      const disabled = buttons.map(button => button.disabled);
      buttons.forEach(button => { button.disabled = true; });
      dialog.setAttribute('aria-busy', 'true');
      dialog.tabIndex = -1;
      dialog.focus();
      const progress = showRestoreProgress();
      status.hidden = true;
      try {
        const result = await restoreSessionBatch(api.sessions, { pluginId, windowId },
          entries.map(entry => entry.session), state => {
            progress.update(state);
            if (state.restored) {
              const entry = pending.get(state.current.id);
              pending.delete(state.current.id);
              entry.row.remove();
            }
          });
        for (const failure of result.errors) {
          const entry = pending.get(failure.sessionId);
          entry.error.textContent = `恢复失败：${failure.message}`;
          entry.error.hidden = false;
        }
        await progress.finish();
        status.hidden = false;
        status.textContent = result.errors.length ? '部分会话恢复失败，可重试。' : '历史会话已恢复。';
      } finally {
        progress.close();
        dialog.setAttribute('aria-busy', 'false');
        buttons.forEach((button, index) => { button.disabled = disabled[index]; });
        update();
        (restoreAll.disabled ? heading.lastElementChild : restoreAll).focus();
      }
    };
    const restoreAll = iconButton('恢复全部历史会话', 'restore', () => restoreBatch([...pending.values()]));
    // Groups retain their identity in history, including when only some members are archived.
    const sectionFor = groupId => {
      const id = historyGroupId(groupId);
      if (sections.has(id)) { return sections.get(id); }
      const name = groups.find(group => group.id === id)?.name || '未分组';
      const list = el('div', { class: 'history-group-members' });
      const toggle = iconButton(`收起${name}归档会话`, 'chevronDown', () => {
        list.hidden = !list.hidden;
        toggle.setAttribute('aria-expanded', String(!list.hidden));
        setButtonIcon(toggle, `${list.hidden ? '展开' : '收起'}${name}归档会话`, list.hidden ? 'chevronRight' : 'chevronDown');
      });
      toggle.setAttribute('aria-expanded', 'true');
      const count = el('small');
      const restore = iconButton(`恢复${name}全部会话`, 'restore', () => restoreBatch(
        [...pending.values()].filter(entry => historyGroupId(entry.session.groupId) === id)));
      const node = el('section', { class: 'history-group' },
        el('div', { class: 'history-group-heading' }, toggle, el('strong', { text: name }), count, restore), list);
      const section = { node, list, count, restore };
      sections.set(id, section);
      body.append(node);
      return section;
    };
    const heading = dialog.querySelector('.dialog-heading');
    heading.insertBefore(restoreAll, heading.lastElementChild);
    body.append(status, empty);
    for (const session of [...archives]) {
      const row = el('article', { class: 'history-row' });
      const adapter = adapters.find((a) => a.id === session.adapterId);
      const membership = el('span', { text: groups.find(group => group.id === session.groupId)?.name || '未分组' });
      const error = el('p', { class: 'history-error', hidden: true, role: 'alert' });
      const directory = el('span', { text: session.cwd });
      row.append(el('div', {}, el('strong', { text: session.name }),
        el('small', {}, directory, ` · ${new Date(session.closedAt).toLocaleString()} · ${closeReasons[session.reason] || '已归档'} · `,
          membership), error));
      row.append(iconButton('回放', 'play', () => showReplay(pluginId, session.id)));
      if (adapter && (!session.nativeDeleted || session.reason === 'context-reset')) {
        pending.set(session.id, { session, row, error });
        const grouping = iconButton('调整会话分组', 'group', async () => {
          const assigned = await assignSessionGroup(pluginId, session, groups);
          if (assigned) {
            session.groupId = assigned.groupId;
            membership.textContent = groups.find(group => group.id === assigned.groupId)?.name || '未分组';
            sectionFor(assigned.groupId).list.append(row);
            update();
          }
        });
        grouping.disabled = Boolean(session.coordinator);
        grouping.title = session.coordinator ? '固定协调者不可移出会话组' : '调整会话分组';
        row.append(grouping);
        row.append(iconButton('修改工作目录', 'folder', async () => {
          const updated = await editArchiveDirectory(pluginId, session);
          if (updated) {
            session.cwd = updated.cwd;
            directory.textContent = updated.cwd;
            error.textContent = '';
            error.hidden = true;
          }
        }));
        row.append(iconButton(session.nativeDeleted ? '启动空白会话' : session.contextId && adapter.capabilities.restore ? '恢复上下文' : '恢复窗口', 'restore', async () => {
          try {
            const restored = await restoreWhenReady(api.sessions, pluginId, session.id, windowId);
            finish(null);
            await focus(restored.id);
          } catch (cause) {
            error.textContent = `恢复失败：${cause.message}`;
            error.hidden = false;
            console.error('[history:restore]', { pluginId, sessionId: session.id }, cause);
          }
        }));
      }
      const remove = iconButton('删除', 'clear', async () => {
        if (await confirm('删除归档', session.nativeDeleted ? '引擎上下文已删除，重试清理剩余本地数据？' : `删除“${session.name}”的终端回放？`)) {
          await api.sessions[session.nativeDeleted ? 'delete' : 'deleteArchive'](pluginId, session.id);
          row.remove();
          pending.delete(session.id);
          update();
        }
      }, 'quiet-danger');
      remove.disabled = Boolean(session.coordinator);
      remove.title = session.coordinator ? '固定协调者不可单独删除' : '删除';
      row.append(remove);
      sectionFor(session.groupId).list.append(row);
    }
    update();
    actions.append(iconButton('关闭', 'close', () => finish(null)));
  }, { wide: true, placement: 'center' });
}

// Keep editing separate from restore so cancellation never launches or changes a session.
async function editArchiveDirectory(pluginId, session) {
  return modal('修改工作目录', ({ body, actions, finish }) => {
    const directory = el('input', { value: session.cwd, 'aria-label': '工作目录', required: true });
    const error = el('p', { class: 'history-error', role: 'alert', hidden: true });
    body.append(field('工作目录', el('div', { class: 'input-row' }, directory,
      iconButton('选择工作目录', 'folder', async () => {
        const path = await api.host.chooseDirectory({ defaultPath: directory.value.trim() });
        if (path) {
          directory.value = path;
        }
      }))), error);
    const save = iconButton('保存工作目录', 'check', async () => {
      if (!directory.reportValidity()) {
        return;
      }
      save.disabled = true;
      try {
        const updated = await api.sessions.updateArchiveDirectory(pluginId, session.id, directory.value);
        finish(updated);
      } catch (cause) {
        error.textContent = cause.message;
        error.hidden = false;
        console.error('[history:directory]', { pluginId, sessionId: session.id }, cause);
      } finally {
        save.disabled = false;
      }
    });
    actions.append(iconButton('取消', 'close', () => finish(null)), save);
  }, { placement: 'center' });
}

async function showReplay(pluginId, id) {
  const replay = await api.sessions.readArchive(pluginId, id);
  let terminal;
  await modal(`${replay.name} · 只读回放`, ({ body, actions, finish }) => {
    if (replay.truncated) {
      body.append(el('p', { class: 'muted', text: '回放保留最后 2 MiB 输出。' }));
    }
    const mount = el('div', { class: 'replay-terminal' });
    body.append(mount);
    terminal = mountTerminal(mount, { session: replay, replay });
    actions.append(iconButton('关闭', 'close', () => finish(null)));
  }, { wide: true });
  terminal.dispose();
}
