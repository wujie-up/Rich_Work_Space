import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
import { api, el, iconButton, toast } from './ui.js';
import { renderQuestionMarkdown } from './question-markdown.js';

// Keep prose questions separate from native tool approvals and the live terminal's scrollback.
export function sessionQuestion(anchor, pluginId, sessionId) {
  let question = '';
  let sending = false;
  let disposed = false;
  let visible = true;
  const text = el('div', { class: 'question-text desk-intervention-content', id: `question-${sessionId}` });
  const answer = el('textarea', { 'aria-label': '回答', placeholder: '输入回答…', rows: 3, maxlength: 12000 });
  const submit = iconButton('发送回答', 'sendReply', send, 'desk-intervention-send');
  submit.disabled = true;
  const close = iconButton('关闭回答弹窗', 'close', () => closePopup(panel));
  const help = iconButton('回答快捷键：Enter 发送，Shift+Enter 换行', 'help', () => answer.focus());
  const panel = el('dialog', { class: 'question-popup desk-intervention', 'aria-label': '回答问题', 'aria-describedby': text.id },
    el('div', { class: 'desk-intervention-heading' }, el('span', { text: '需要你确认' }), close),
    text, el('div', { class: 'desk-intervention-composer' }, answer,
      el('div', { class: 'desk-intervention-actions' }, help, submit)));
  document.body.append(panel);
  answer.addEventListener('input', () => {
    submit.disabled = sending || !answer.value.trim();
    resizeAnswer();
  });
  answer.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void send();
    }
  });
  text.addEventListener('click', async event => {
    const link = event.target.closest('a[href]');
    if (!link) { return; }
    event.preventDefault();
    try { await api.host.openExternal(link.href); }
    catch (error) { report(error); toast(error.message); }
  });
  function resizeAnswer() {
    answer.style.height = 'auto';
    answer.style.height = `${Math.min(180, Math.max(76, answer.scrollHeight))}px`;
  }
  panel.addEventListener('toggle', event => {
    anchor.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  const report = error => console.error('[session:question-popup]', { pluginId, sessionId, stack: error.stack });
  function open() {
    if (!question || disposed || !visible) { return; }
    showPopup(panel, anchor, { placement: 'center' });
    resizeAnswer();
    anchor.setAttribute('aria-expanded', 'true');
    answer.focus();
  }
  const click = () => {
    try {
      open();
    } catch (error) {
      report(error);
      toast(error.message);
    }
  };
  const keydown = event => {
    if (question && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      click();
    }
  };
  // A clickable status indicator must not also start dragging its session header.
  const pointerdown = event => { if (question) { event.stopPropagation(); } };
  anchor.addEventListener('click', click);
  anchor.addEventListener('keydown', keydown);
  anchor.addEventListener('pointerdown', pointerdown);

  async function send() {
    if (sending || !question || !answer.value.trim()) { return; }
    const current = question;
    sending = true;
    answer.disabled = true;
    submit.disabled = true;
    try {
      // Bracketed paste preserves multiline answers; a separate Enter submits the existing native CLI.
      await api.sessions.write(pluginId, sessionId, `\x1b[200~${answer.value}\x1b[201~`);
      if (disposed || question !== current) { return; }
      await api.sessions.write(pluginId, sessionId, '\r');
      if (!disposed && question === current) {
        answer.value = '';
        closePopup(panel);
      }
      console.info('[session:question-answered]', { pluginId, sessionId });
    } catch (error) {
      report(error);
      if (!disposed) { toast(error.message); }
    } finally {
      sending = false;
      answer.disabled = false;
      submit.disabled = !question || !answer.value.trim();
    }
  }

  return {
    update(session, { visible: nextVisible = true } = {}) {
      const revealed = !visible && nextVisible;
      visible = nextVisible;
      const next = !session.exited && session.blocked === 'question' && typeof session.question === 'string'
        ? session.question.trim() : '';
      anchor.setAttribute('role', next ? 'button' : 'img');
      anchor.tabIndex = next ? 0 : -1;
      anchor.classList.toggle('has-question', !!next);
      if (next) {
        anchor.setAttribute('aria-haspopup', 'dialog');
      } else {
        anchor.removeAttribute('aria-haspopup');
        anchor.removeAttribute('aria-expanded');
      }
      if (next === question) {
        if (!visible) { closePopup(panel); }
        else if (revealed) { open(); }
        return !!next;
      }
      question = next;
      answer.value = '';
      submit.disabled = true;
      try {
        renderQuestionMarkdown(text, question);
      } catch (error) {
        report(error);
        text.textContent = question;
      }
      try {
        closePopup(panel);
        if (question) { open(); }
        return !!question;
      } catch (error) {
        // Keep native CLI confirmation visible when the supplementary popup cannot open.
        report(error);
        question = '';
        return false;
      }
    },
    dispose() {
      disposed = true;
      closePopup(panel);
      panel.remove();
      anchor.removeEventListener('click', click);
      anchor.removeEventListener('keydown', keydown);
      anchor.removeEventListener('pointerdown', pointerdown);
    }
  };
}
