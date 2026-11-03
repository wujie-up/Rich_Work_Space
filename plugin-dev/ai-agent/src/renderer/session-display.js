import { api, el, setButtonIcon } from './ui.js';
import { renderQuestionMarkdown } from './question-markdown.js';

// Keep the native composer and execution alive underneath a prose-only reading surface.
export function sessionDisplay(node, mount, session, button, initial, save) {
  const surface = el('div', { class: 'session-concise', hidden: true, tabindex: '0', 'aria-label': '简洁会话内容' });
  const screen = mount.querySelector('.terminal-screen');
  screen.append(surface);
  let concise = initial;
  let current = session;
  let composer = {};
  let pending = false;
  let disposed = false;
  let revision;
  const visible = () => concise && !node.hidden && !node.classList.contains('collapsed')
    && !composer.modelPicker && (!current.blocked || current.blocked === 'question');
  const layout = () => {
    surface.hidden = !visible();
    const reserve = !surface.hidden && composer.live;
    const top = Math.max(0, screen.clientHeight - Math.min(120, screen.clientHeight * .3));
    const offset = reserve ? top - composer.top : 0;
    // Move the native composer rather than duplicate its editing and submission state.
    screen.dataset.composerOffset = String(offset);
    screen.classList.toggle('terminal-concise', !surface.hidden);
    screen.querySelector('.xterm').style.transform = offset ? `translateY(${offset}px)` : '';
    surface.style.bottom = reserve ? `${screen.clientHeight - top}px` : '0';
    surface.style.height = 'auto';
    if (button.getAttribute('aria-pressed') !== String(concise)) {
      setButtonIcon(button, concise ? '切换为完整视图' : '切换为简洁视图', concise ? 'concise' : 'full');
      button.setAttribute('aria-pressed', String(concise));
    }
  };
  const refresh = async () => {
    layout();
    if (!visible() || pending || disposed) { return; }
    pending = true;
    try {
      const result = await api.sessions.transcript(session.pluginId, session.id);
      if (disposed) { return; }
      const next = JSON.stringify(result);
      if (revision === next) { return; }
      const follow = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 40;
      revision = next;
      surface.replaceChildren();
      if (!result.messages.length) {
        surface.append(el('p', { text: result.available ? '等待 Agent 返回内容…' : '暂无结构化消息，可切换完整视图查看历史。' }));
      }
      if (result.truncated) { surface.append(el('p', { class: 'muted', text: '显示近期内容，完整历史请切换完整视图。' })); }
      result.messages.forEach(({ role, text }) => {
        const label = role === 'user' ? '用户' : 'AI';
        const message = el('article', { class: 'session-concise-message', 'data-role': role, 'aria-label': `${label}消息` });
        const body = el('div', { class: 'session-concise-body' });
        message.append(el('div', { class: 'session-concise-role', text: label }), body);
        renderQuestionMarkdown(body, text);
        surface.append(message);
      });
      if (follow) { surface.scrollTop = surface.scrollHeight; }
    } catch (error) {
      console.error('[session:concise]', { sessionId: session.id }, error);
      if (!disposed) {
        surface.textContent = '内容暂不可用，请切换完整视图。';
        revision = undefined;
      }
    } finally { pending = false; }
  };
  button.onclick = () => {
    concise = !concise;
    save(concise);
    void refresh();
  };
  const timer = setInterval(refresh, 1500);
  layout();
  return {
    composer(value) {
      composer = value;
      layout();
    },
    update(value) {
      current = value;
      void refresh();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      screen.querySelector('.xterm').style.transform = '';
      delete screen.dataset.composerOffset;
      screen.classList.remove('terminal-concise');
      surface.remove();
    }
  };
}
