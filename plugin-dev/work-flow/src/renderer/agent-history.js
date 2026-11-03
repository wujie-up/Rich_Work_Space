import { showPopup } from '../../../../desk/src/resource/popup.js';
import { escape } from './api.js';
import { AgentTranscript } from './agent-transcript.js';

// Page each Agent independently; transcript updates never rebuild the workflow canvas.
export function createAgentHistory({ invoke }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'agent-history-dialog user-input-dialog';
  dialog.setAttribute('aria-label', 'Agent 会话记录');
  dialog.innerHTML = `<header><h2>Agent 会话记录</h2><span class="spacer"></span>
    <button type="button" class="icon-button" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
    <div class="agent-history-layout"><nav aria-label="Agent 列表"></nav><section aria-live="polite">
    <h3></h3><div class="agent-transcript"></div><p class="hint" data-error></p>
    <footer><button type="button" data-more class="icon-button" title="加载更多" aria-label="加载更多"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button><span class="spacer"></span><button type="button" data-refresh class="icon-button" title="刷新" aria-label="刷新"><svg viewBox="0 0 24 24"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg></button></footer>
    </section></div>`;
  document.body.append(dialog);
  let generation = 0;
  let timer;
  let runId;
  let workflowId;
  let sessions = [];
  let selected = null;
  let pages = new Map();
  let loading = false;
  const transcript = dialog.querySelector('.agent-transcript');
  const more = dialog.querySelector('[data-more]');
  const error = dialog.querySelector('[data-error]');
  more.hidden = true;
  dialog.querySelector('[aria-label="关闭"]').onclick = () => dialog.close();
  dialog.onclose = () => { generation += 1; clearTimeout(timer); };

  function appendEvent(group, event) {
    const entry = group.model.add(event);
    if (!entry) { return; }
    let content = group.entries.get(entry.id);
    if (!content) {
      const article = document.createElement('article');
      article.className = 'agent-history-event';
      const label = document.createElement('small');
      const at = entry.at ? new Date(entry.at).toLocaleTimeString('zh-CN') : '';
      label.textContent = `${entry.role === 'user' ? '用户 / 工作流' : entry.role === 'agent' ? 'Agent' : entry.method} · ${at}`;
      content = document.createElement('pre');
      if (entry.role === 'user') {
        const round = document.createElement('h5');
        round.className = 'agent-history-round';
        round.textContent = `第 ${entry.round} 轮`;
        group.element.append(round);
      }
      if (entry.role === 'event') {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.append(label);
        details.append(summary, content);
        article.append(details);
      } else {
        article.append(label, content);
      }
      group.element.append(article);
      group.entries.set(entry.id, content);
    }
    content.textContent = entry.text;
  }

  function renderNavigation() {
    const nav = dialog.querySelector('nav');
    nav.innerHTML = sessions.length ? `<button type="button" data-session="all"><strong>全部 Agent</strong></button>` +
      sessions.map((session, index) => `<button type="button" data-session="${index}">
      <strong>${escape(session.name || session.nodeId)}</strong><small>${session.archivedAt ? '已归档' : '处理中 / 待续'} · ${session.iteration} 轮</small></button>`).join('') : '';
    for (const button of nav.querySelectorAll('button')) {
      const session = button.dataset.session === 'all' ? null : sessions[Number(button.dataset.session)].sessionId;
      button.classList.toggle('selected', selected === session);
      button.onclick = () => {
        selected = session;
        generation += 1;
        clearTimeout(timer);
        pages = new Map();
        transcript.replaceChildren();
        renderNavigation();
        schedule(0);
      };
    }
    dialog.querySelector('h3').textContent = selected ? sessions.find(item => item.sessionId === selected)?.name || 'Agent' : '全部 Agent';
  }

  function schedule(delay = 1000) {
    clearTimeout(timer);
    if (dialog.open) { timer = setTimeout(load, delay); }
  }

  // Drain bounded pages without overlapping polls, then follow live sessions incrementally.
  async function load() {
    if (loading || !dialog.open) { schedule(); return; }
    const token = generation;
    loading = true;
    error.textContent = '';
    let live = true;
    try {
      const result = await invoke('runs.sessions', { runId, workflowId });
      if (token !== generation || !dialog.open) { return; }
      if (JSON.stringify(result) !== JSON.stringify(sessions)) {
        sessions = result;
        renderNavigation();
      }
      const visible = selected ? sessions.filter(item => item.sessionId === selected) : sessions;
      live = !sessions.length || sessions.some(item => !item.archivedAt);
      for (const session of visible) {
        let group = pages.get(session.sessionId);
        if (!group) {
          const element = document.createElement('div');
          element.className = 'agent-history-group';
          const heading = document.createElement('h4');
          element.append(heading);
          transcript.append(element);
          group = { cursor: 0, element, model: new AgentTranscript(), entries: new Map(), heading };
          pages.set(session.sessionId, group);
        }
        group.heading.textContent = `${session.name || session.nodeId} · ${session.archivedAt ? '已归档' : '处理中 / 待续'}`;
        let hasMore;
        do {
          const page = await invoke('runs.sessionHistory', { runId, workflowId, sessionId: session.sessionId,
            afterSequence: group.cursor, limit: 200 });
          if (token !== generation || !dialog.open) { return; }
          const follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
          page.events.forEach(event => appendEvent(group, event));
          hasMore = page.hasMore && page.nextSequence > group.cursor;
          group.cursor = page.nextSequence;
          if (follow) { transcript.scrollTop = transcript.scrollHeight; }
        } while (hasMore);
      }
      if (![...pages.values()].some(group => group.cursor)) { error.textContent = '会话已创建，等待 Agent 输出。'; }
    } catch (failure) {
      live = true;
      if (token === generation) {
        console.error('[workflow:session-history-failed]', { runId }, failure);
        error.textContent = failure.message;
      }
    } finally {
      loading = false;
      if (dialog.open && (token !== generation || live)) { schedule(); }
    }
  }
  dialog.querySelector('[data-refresh]').onclick = () => schedule(0);
  return { async open(id, ownerWorkflowId) {
    generation += 1;
    clearTimeout(timer);
    runId = id;
    workflowId = ownerWorkflowId;
    selected = null;
    sessions = [];
    pages = new Map();
    transcript.replaceChildren();
    renderNavigation();
    error.textContent = '正在加载…';
    if (!dialog.open) { showPopup(dialog, document.activeElement, { placement: 'center' }); }
    schedule(0);
  } };
}
