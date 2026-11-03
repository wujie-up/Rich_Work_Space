import '../../../../desk/src/resource/controls.css';
import { pageLifecycle } from '../../../../desk/src/resource/page-lifecycle.js';
import { api, conversationApi } from './api.js';
import './conversation.css';
import { setButtonIcon } from './ui.js';
import './session-status.css';
import { sessionStatus } from './session-status.js';
import { renderDocumentLinks } from './document-links.js';
import { showSettings } from './settings-dialog.js';
import { isApprovalRequest, isElicitationRequest, pendingRequests } from '../shared/contracts.js';
import { mountElicitation } from './mcp-elicitation.js';
import { mountAppearance } from './appearance.js';

const disposeAppearance = mountAppearance();
window.addEventListener('pagehide', disposeAppearance, { once: true });

const lifecycle = pageLifecycle();
const $ = id => document.getElementById(id);
const call = (method, ...args) => conversationApi.call(method, ...args);
let windowId = /^agent-window:[a-f0-9-]{36}$/.test(window.name) ? window.name.slice(13) : crypto.randomUUID();
window.name = `agent-window:${windowId}`;
const hostWindow = await api.host.getWindowContext();
await call('conversation.registerWindow', { id: windowId, hostWindowId: hostWindow?.id });
for (const group of await call('conversation.listWindows')) {
  $('window-group').add(new Option(`${group.name} · ${group.id.slice(0, 8)}`, group.id));
}
$('window-group').value = windowId;
let current;
let cwd;
let runtime;
let engines = [];
let records = [];
let renderedId;
let renderedCount = 0;
const composerClientId = crypto.randomUUID();
let composerVersion = 0;
let reportedConversation;
let composing = false;
// An external turn can start only while every attached view reports a fresh, empty composer.
async function reportComposer(detached = false) {
  try {
    if (reportedConversation && reportedConversation !== current?.id) {
      await call('conversation.composer', reportedConversation, { clientId: composerClientId, version: ++composerVersion, detached: true });
    }
    reportedConversation = current?.id;
    if (current) {
      await call('conversation.composer', current.id, { clientId: composerClientId, version: ++composerVersion,
        empty: !$('prompt').value, composing, detached });
    }
  } catch (error) {
    console.error('[conversation:composer-report]', { conversationId: current?.id, error: error.message });
  }
}
const composerHeartbeat = setInterval(() => reportComposer(), 2000);
$('prompt').addEventListener('input', () => reportComposer());
$('prompt').addEventListener('compositionstart', () => { composing = true; reportComposer(); });
$('prompt').addEventListener('compositionend', () => { composing = false; reportComposer(); });
window.addEventListener('pagehide', () => { clearInterval(composerHeartbeat); reportComposer(true); });
const streamed = new Map();
const stateIcon = document.createElement('span');
stateIcon.className = 'session-status';
stateIcon.setAttribute('role', 'img');
$('state').before(stateIcon);
window.addEventListener('document-open-error', event => displayError(event.detail));
const displayError = error => { $('conversation-notice').textContent = error.message; };
const action = fn => async event => {
  event?.preventDefault();
  $('conversation-notice').textContent = '';
  try {
    await fn();
  } catch (error) {
    displayError(error);
  }
};

function message(role, text, label) {
  const element = document.createElement('article');
  element.className = `message ${role}`;
  if (label) {
    const title = document.createElement('span');
    title.className = 'label';
    title.textContent = label;
    element.append(title);
  }
  const content = document.createElement('div');
  renderDocumentLinks(content, text, current?.cwd || cwd);
  element.append(content);
  $('transcript').append(element);
  return content;
}

function render() {
  if (reportedConversation !== current?.id) { reportComposer(); }
  if (!lifecycle.visible()) { return; }
  const transcript = $('transcript');
  const reset = renderedId !== current?.id || (current?.events.length || 0) < renderedCount;
  const follow = reset || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
  if (reset || !renderedCount) {
    transcript.replaceChildren();
    renderedCount = 0;
    streamed.clear();
    renderedId = current?.id;
  }
  $('cwd').textContent = current?.cwd || cwd || '独立空间';
  $('state').textContent = ({ running: '运行中', idle: '等待输入', failed: '执行失败', cancelled: '已停止', interrupted: '已中断' })[current?.state] || '就绪';
  $('send').disabled = runtime?.state !== 'ready' || current?.state === 'running';
  $('stop').disabled = current?.state !== 'running';
  $('reconnect-tools').disabled = !current;
  const pending = new Map(pendingRequests(current?.events || []).map(event => [event.id, event]));
  const pendingSequences = new Map([...pending].map(([id, event]) => [JSON.stringify(id), String(event.sequence)]));
  transcript.querySelectorAll('[data-request-id]').forEach(node => {
    if (pendingSequences.get(node.dataset.requestKey) !== node.dataset.requestSequence) { node.remove(); }
  });
  for (const event of (current?.events || []).slice(renderedCount)) {
    const params = event.params || {};
    if (event.method === 'user/message') {
      message('user', params.text, '你');
    } else if (event.method === 'item/agentMessage/delta') {
      const key = params.itemId || 'answer';
      const content = streamed.get(key) || message('ai', '', current?.engineId === 'claude' ? 'Claude Code' : 'Codex');
      content.append(document.createTextNode(params.delta));
      streamed.set(key, content);
    } else if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const content = streamed.get(params.item.id);
      if (content) { renderDocumentLinks(content, params.item.text || content.textContent, current?.cwd || cwd); }
      else { message('ai', params.item.text, current?.engineId === 'claude' ? 'Claude Code' : 'Codex'); }
    } else if (event.method === 'capability/invocation') {
      message('tool', `${params.invocationId} · ${params.state}`, '插件能力');
    } else if (isElicitationRequest(event) && pending.get(event.id) === event) {
      const conversationId = current.id;
      const content = message('tool', '', params.mode === 'url' ? '需要你的授权' : '需要你的回答');
      confirmation(content, event);
      mountElicitation(content, event, { openUrl: url => api.host.openExternal(url), respond: async (decision, answer) => {
        await call('conversation.elicit', conversationId, event.id, decision, answer);
        const record = await call('conversation.read', conversationId);
        if (current?.id === conversationId) { current = record; render(); }
      } });
    } else if (event.method === 'item/tool/requestUserInput' && pending.get(event.id) === event) {
      const content = message('tool', '', '需要你的回答');
      confirmation(content, event);
      const answers = new Map();
      for (const question of params.questions) {
        const label = document.createElement('label');
        label.textContent = question.question;
        const input = document.createElement('input');
        input.placeholder = (question.options || []).map(option => option.label).join(' / ');
        label.append(input);
        content.append(label);
        answers.set(question.id, input);
      }
      const submit = document.createElement('button');
      setButtonIcon(submit, '提交回答', 'send');
      submit.onclick = action(async () => {
        await call('conversation.answer', current.id, event.id, Object.fromEntries([...answers].map(([id, input]) => [id, input.value])));
        current = await call('conversation.read', current.id);
        render();
      });
      content.append(submit);
    } else if (isApprovalRequest(event) && pending.get(event.id) === event) {
      const content = message('tool', params.command || params.reason || params.message || JSON.stringify(params), '需要你的批准');
      confirmation(content, event);
      for (const [title, decision] of [['批准', 'accept'], ['拒绝', 'decline']]) {
        const button = document.createElement('button');
        setButtonIcon(button, title, title === '批准' ? 'check' : 'close');
        button.onclick = action(async () => {
          await call('conversation.approve', current.id, event.id, decision);
          current = await call('conversation.read', current.id);
          render();
        });
        content.append(button);
      }
    } else if (event.method === 'error') {
      message('error', params.message || params.error?.message || '引擎执行失败', '错误');
    } else if (event.method === 'item/completed' && params.item?.type !== 'userMessage' && params.item?.type !== 'agentMessage') {
      message('tool', JSON.stringify(params.item, null, 2), params.item?.type || '工具');
    }
  }
  if (!current?.events.length) {
    message('ai', '从这里开始，AI 可以发现并调用工作台插件提供的能力。');
  }
  renderedCount = current?.events.length || 0;
  const blocked = !!transcript.querySelector('.confirmation');
  sessionStatus(stateIcon, blocked ? 'blocked' : current?.state === 'running' ? 'working' : 'idle', blocked ? '需要你的确认' : $('state').textContent);
  if (follow) { transcript.scrollTop = transcript.scrollHeight; }
}

// Keep each pending decision inside its own session, preserving typed answers during streamed updates.
function confirmation(content, event) {
  const node = content.closest('article');
  node.classList.add('confirmation');
  node.dataset.requestId = event.id;
  node.dataset.requestKey = JSON.stringify(event.id);
  node.dataset.requestSequence = event.sequence;
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', node.querySelector('.label').textContent);
}

async function refreshHistory() {
  records = (await call('conversation.list')).filter(record => (!record.windowId || record.windowId === windowId)
    && !record.developmentId);
  $('history').replaceChildren(new Option('选择对话', ''));
  for (const record of records) {
    $('history').add(new Option(record.name, record.id));
  }
  $('history').value = current?.id || '';
}

const settings = { async refresh() {
  const [values, config] = await Promise.all([call('engines.list'), call('engines.config')]);
  engines = values;
  if (!current && !$('conversation-engine').dataset.selected) { $('conversation-engine').value = config.defaultEngine; }
  runtime = engines.find(engine => engine.id === (current?.engineId || $('conversation-engine').value || 'codex'));
  $('runtime-label').textContent = `${runtime.name} ${runtime.pin.version} · ${runtime.state === 'ready' ? '已安装' : '未安装'}`;
  render();
} };
conversationApi.onAccount(() => settings.refresh().catch(displayError));
$('window-group').onchange = action(async () => {
  windowId = $('window-group').value;
  window.name = `agent-window:${windowId}`;
  await call('conversation.registerWindow', { id: windowId, hostWindowId: hostWindow?.id });
  current = null;
  await refreshHistory();
  await settings.refresh();
});
$('settings-toggle').onclick = action(async () => {
  $('settings-toggle').setAttribute('aria-expanded', 'true');
  try { await showSettings({ onEnginesChange: () => settings.refresh() }); }
  finally { $('settings-toggle').setAttribute('aria-expanded', 'false'); }
  await settings.refresh();
});
$('conversation-engine').onchange = action(async () => {
  $('conversation-engine').dataset.selected = 'true';
  current = null;
  $('history').value = '';
  await settings.refresh();
});
$('directory').onclick = action(async () => {
  cwd = await api.host.chooseDirectory({ defaultPath: current?.cwd || cwd }) || cwd;
  $('cwd').textContent = cwd || '独立空间';
});
$('new').onclick = action(async () => {
  current = await call('conversation.create', { cwd, windowId, engineId: $('conversation-engine').value });
  await refreshHistory();
  render();
});
$('history').onchange = action(async () => {
  current = $('history').value ? await call('conversation.read', $('history').value) : null;
  if (current && !current.windowId) { current = await call('conversation.attachWindow', current.id, windowId); }
  if (current) { $('conversation-engine').value = current.engineId || 'codex'; }
  await settings.refresh();
});
$('composer').onsubmit = action(async () => {
  const text = $('prompt').value.trim();
  if (!text) {
    return;
  }
  current ||= await call('conversation.create', { cwd, windowId, engineId: $('conversation-engine').value });
  $('prompt').value = '';
  current = await call('conversation.send', current.id, text);
  await refreshHistory();
  render();
});
$('reconnect-tools').onclick = action(async () => {
  if (!current) { throw Error('请先选择一个对话'); }
  const result = await call('conversation.reconnect', current.id);
  $('conversation-notice').textContent = result.pending ? '本轮执行不受影响，将在下一轮开始前重新连接工具' : '工具已重新连接，会话历史已保留';
});
$('stop').onclick = action(() => call('conversation.cancel', current.id));
$('prompt').onkeydown = event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    $('composer').requestSubmit();
  }
};
lifecycle.subscribe(visible => { if (visible) { render(); } });
let renderFrame;
conversationApi.onEvent(({ conversationId, event, state }) => {
  if (current?.id === conversationId) {
    if (!current.events.some(existing => existing.sequence === event.sequence)) {
      current.events.push(event);
    }
    current.state = state;
    if (!lifecycle.visible()) { return; }
    renderFrame ||= requestAnimationFrame(() => { renderFrame = null; render(); });
  }
});
await action(async () => {
  await settings.refresh();
  await refreshHistory();
  if (current) { $('conversation-engine').value = current.engineId || 'codex'; }
  await settings.refresh();
  render();
})();
