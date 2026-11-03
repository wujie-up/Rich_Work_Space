import { api, el, iconButton, toast } from './ui.js';

// A local draft keeps the card usable when the native CLI cannot bootstrap without a model connection.
export function sessionConnection(content, mount, pluginId, sessionId, terminal) {
  let current;
  let offline = false;
  let sending = false;
  const message = el('p', { role: 'status', text: '连接不可用。会话历史已保留，可先编辑草稿，恢复网络后重新连接。' });
  const draft = el('textarea', { 'aria-label': '会话草稿', placeholder: '先写下要继续的内容…', maxlength: 12000, rows: 4 });
  const submit = iconButton('放入会话输入框', 'send', async () => {
    if (submit.disabled) { return; }
    sending = true;
    update(current, offline);
    try {
      // Paste only after the CLI is ready; the user submits with Enter in its native composer.
      await api.sessions.write(pluginId, sessionId, `\x1b[200~${draft.value}\x1b[201~`);
      draft.value = '';
      terminal.focus();
      console.info('[session:draft-pasted]', { pluginId, sessionId });
    } catch (error) {
      console.error('[session:draft-paste-failed]', { pluginId, sessionId, stack: error.stack });
      toast(error.message);
    } finally {
      sending = false;
      update(current, offline);
    }
  });
  submit.title = '将草稿放入会话输入框，按 Enter 后发送';
  const help = el('p', { class: 'muted', text: '草稿仅保留在当前窗口；连接就绪后可放入会话输入框，由你确认发送。' });
  const editor = el('div', { class: 'connection-draft' }, draft, submit);
  const panel = el('div', { class: 'session-connection', hidden: true }, message, editor, help);
  content.append(panel);
  draft.addEventListener('input', () => update(current, offline));
  function update(session, disconnected) {
    current = session;
    offline = disconnected;
    const stopped = session.exited && session.error?.code === 'SESSION_OFFLINE';
    panel.hidden = !stopped && !draft.value;
    mount.hidden = stopped;
    message.hidden = !stopped;
    help.hidden = !draft.value && !stopped;
    draft.disabled = sending;
    submit.disabled = sending || disconnected || session.exited || !!session.blocked
      || !['idle', 'done'].includes(session.activity) || !draft.value.trim();
  }
  return {
    update,
    get draft() { return draft.value; },
    set draft(value) { draft.value = value; update(current, offline); },
    focus() { if (!panel.hidden) { draft.focus(); } else { terminal.focus(); } }
  };
}
