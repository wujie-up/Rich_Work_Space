import { api, el, button, modal, confirm } from './ui.js';
import { mountTerminal } from './terminal.js';

export async function showHistory(pluginId, adapters, focus) {
  const { archives } = await api.sessions.list(pluginId);
  await modal('会话历史', ({ body, actions, finish }) => {
    body.classList.add('history-list');
    if (!archives.length) {
      body.append(el('div', { class: 'empty', text: '还没有归档会话。关闭的会话会保存在这里。' }));
    }
    for (const session of archives) {
      const row = el('article', { class: 'history-row' });
      const adapter = adapters.find((a) => a.id === session.adapterId);
      row.append(el('div', {}, el('strong', { text: session.name }), el('small', { text: `${session.cwd} · ${new Date(session.closedAt).toLocaleString()}` })));
      row.append(button('回放', () => showReplay(pluginId, session.id)));
      if (adapter?.capabilities.restore) {
        const restore = button(session.contextId ? '恢复上下文' : '缺少会话 ID', async () => {
          const restored = await api.sessions.restore(pluginId, session.id);
          finish(null);
          await focus(restored.id);
        });
        restore.disabled = !session.contextId;
        row.append(restore);
      } else if (adapter) {
        row.append(button('按原配置新建', async () => {
          const created = await api.sessions.create(pluginId, { adapterId: session.adapterId, cwd: session.cwd, name: session.name,
            permission: session.permission });
          finish(null);
          await focus(created.id);
        }));
      }
      row.append(button('删除', async () => {
        if (await confirm('删除归档', `删除“${session.name}”的终端回放？`)) {
          await api.sessions.deleteArchive(pluginId, session.id);
          row.remove();
        }
      }, 'quiet-danger'));
      body.append(row);
    }
    actions.append(button('关闭', () => finish(null)));
  }, { wide: true });
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
    actions.append(button('关闭', () => finish(null)));
  }, { wide: true });
  terminal.dispose();
}
