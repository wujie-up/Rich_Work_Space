import { api, conversationApi } from './api.js';
import './conversation.css';
import './session-status.css';
import { sessionStatus } from './session-status.js';
import { renderDocumentLinks } from './document-links.js';
import { engineSettings } from './engine-settings.js';

const $ = id => document.getElementById(id);
const call = (method, ...args) => conversationApi.call(method, ...args);
let windowId = /^agent-window:[a-f0-9-]{36}$/.test(window.name) ? window.name.slice(13) : crypto.randomUUID();
window.name = `agent-window:${windowId}`;
await call('conversation.registerWindow', { id: windowId });
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
const streamed = new Map();
const stateIcon = document.createElement('span');
stateIcon.className = 'session-status';
stateIcon.setAttribute('role', 'img');
$('state').before(stateIcon);
window.addEventListener('document-open-error', event => displayError(event.detail));
const displayError = error => { $('notice').textContent = error.message; };
const action = fn => async event => {
  event?.preventDefault();
  $('notice').textContent = '';
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
  const answered = new Set((current?.events || []).filter(event => event.method === 'approval/answered' || event.params?.item?.type === 'approvalCancelled').map(event => event.params.requestId || event.params.item?.requestId));
  transcript.querySelectorAll('[data-request-id]').forEach(node => {
    if (answered.has(node.dataset.requestId)) { node.remove(); }
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
    } else if (event.method === 'item/tool/requestUserInput' && !answered.has(event.id)) {
      const content = message('tool', '', '需要你的回答');
      confirmation(content, event.id);
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
      submit.textContent = '提交回答';
      submit.onclick = action(async () => {
        await call('conversation.answer', current.id, event.id, Object.fromEntries([...answers].map(([id, input]) => [id, input.value])));
        current = await call('conversation.read', current.id);
        render();
      });
      content.append(submit);
    } else if (event.method.endsWith('/requestApproval') && !answered.has(event.id)) {
      const content = message('tool', params.command || params.reason || JSON.stringify(params), '需要你的批准');
      confirmation(content, event.id);
      for (const [title, decision] of [['批准', 'accept'], ['拒绝', 'decline']]) {
        const button = document.createElement('button');
        button.textContent = title;
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
function confirmation(content, id) {
  const node = content.closest('article');
  node.classList.add('confirmation');
  node.dataset.requestId = id;
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

const settings = engineSettings({ onError: displayError, onChange: async (values, config) => {
  engines = values;
  if (!current && !$('conversation-engine').dataset.selected) { $('conversation-engine').value = config.defaultEngine; }
  runtime = engines.find(engine => engine.id === (current?.engineId || $('conversation-engine').value || 'codex'));
  $('runtime-label').textContent = `${runtime.name} ${runtime.pin.version} · ${runtime.state === 'ready' ? '已安装' : '未安装'}`;
  render();
} });
$('window-group').onchange = action(async () => {
  windowId = $('window-group').value;
  window.name = `agent-window:${windowId}`;
  current = null;
  await refreshHistory();
  await settings.refresh();
});
$('settings-toggle').onclick = action(async () => {
  $('settings').hidden = !$('settings').hidden;
  $('settings-toggle').setAttribute('aria-expanded', String(!$('settings').hidden));
  if (!$('settings').hidden) { await settings.refresh(); }
});
$('conversation-engine').onchange = action(async () => {
  $('conversation-engine').dataset.selected = 'true';
  current = null;
  $('history').value = '';
  await settings.refresh();
});
$('directory').onclick = action(async () => {
  cwd = await api.host.chooseDirectory() || cwd;
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
$('stop').onclick = action(() => call('conversation.cancel', current.id));
$('prompt').onkeydown = event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    $('composer').requestSubmit();
  }
};
let renderFrame;
conversationApi.onEvent(({ conversationId, event, state }) => {
  if (current?.id === conversationId) {
    if (!current.events.some(existing => existing.sequence === event.sequence)) {
      current.events.push(event);
    }
    current.state = state;
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
