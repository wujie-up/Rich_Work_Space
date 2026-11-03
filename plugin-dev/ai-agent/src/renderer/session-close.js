import { api, el, iconButton, modal } from './ui.js';

const pending = new Set();

export async function closeSession(pluginId, session) {
  if (pending.has(session.id)) {
    return;
  }
  pending.add(session.id);
  try {
    await chooseCloseAction(pluginId, session);
  } finally {
    pending.delete(session.id);
  }
}

async function chooseCloseAction(pluginId, session) {
  const choice = await modal('如何关闭此会话？', ({ body, actions, finish }) => {
    body.append(el('p', { text: `“${session.name}”：归档保留上下文和回放；删除会清除引擎上下文、回放及关联抓包，无法恢复。` }));
    actions.append(iconButton('取消', 'close', () => finish(null)),
      iconButton('归档', 'history', () => finish('archive')),
      iconButton('删除', 'clear', () => finish('delete'), 'quiet-danger'));
  });
  if (!choice) {
    return;
  }
  if (choice === 'delete') {
    const confirmed = await modal('确认永久删除？', ({ body, actions, finish }) => {
      body.append(el('p', { text: `永久删除“${session.name}”及引擎创建的子会话，不能恢复。授权、配置、工作目录和其他独立会话不受影响。` }));
      actions.append(iconButton('取消', 'close', () => finish(false)),
        iconButton('确认删除', 'clear', () => finish(true), 'quiet-danger'));
    }, { placement: 'center' });
    if (!confirmed) {
      return;
    }
  }
  await api.sessions[choice](pluginId, session.id);
}
