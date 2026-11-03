import '../../../../desk/src/resource/controls.css';
import { pageLifecycle, pollVisible } from '../../../../desk/src/resource/page-lifecycle.js';
import { call } from './api.js';
import './style.css';

const $ = selector => document.querySelector(selector);
const lifecycle = pageLifecycle();
const paths = { start: 'm8 4 12 8-12 8z', stop: 'M5 5h14v14H5z', invite: 'M12 5v14M5 12h14',
  copy: 'M9 9h11v11H9zM15 9V4H4v11h5', confirm: 'm5 12 4 4L19 6', revoke: 'M6 6l12 12M18 6 6 18',
  assistant: 'M3 4h18v12H3zM8 20h8M12 16v4M8 10h8m-3-3 3 3-3 3',
  help: 'M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2M12 16h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0' };
let state;
let busy = false;
let invite;

function icon(button, name, title) {
  button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
  button.title = title;
  button.setAttribute('aria-label', title);
}

function row(text, detail, action, title, handler) {
  const item = document.createElement('div');
  item.className = 'row';
  const content = document.createElement('div');
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = text;
  label.title = text;
  content.append(label);
  const note = document.createElement('span');
  // Pairing fingerprints stay fully visible; display-only device IDs may be abbreviated by layout.
  note.className = action === 'confirm' ? 'detail fingerprint' : 'detail';
  note.textContent = detail;
  note.title = detail;
  content.append(note);
  item.append(content);
  if (action) {
    const button = document.createElement('button');
    button.className = `icon-button ${action === 'revoke' ? 'danger' : 'primary'}`;
    icon(button, action, title);
    button.disabled = busy;
    button.onclick = () => perform(handler);
    item.append(button);
  }
  return item;
}

function render() {
  $('#status').textContent = state?.running ? '远程访问已开启' : '远程访问已关闭';
  $('#status').dataset.running = Boolean(state?.running);
  icon($('#toggle'), state?.running ? 'stop' : 'start', state?.running ? '停止访问并断开全部设备' : '开启远程访问');
  $('#toggle').disabled = busy;
  $('#invite').disabled = busy || !state?.running;
  icon($('#assistant'), 'assistant', state?.assistantRunning ? '电脑助手已打开，关闭助手窗口后可重新打开' : '打开内置电脑助手，连接其他工作台');
  $('#assistant').disabled = busy || Boolean(state?.assistantRunning);
  if (!state?.running || invite?.expiresAt <= Date.now()) { invite = null; $('#ticket').value = ''; }
  $('#invitation').hidden = !invite;
  if (invite) { $('#expiry').textContent = `· ${Math.max(0, Math.ceil((invite.expiresAt - Date.now()) / 1000))} 秒后过期`; }
  $('#pending').replaceChildren(...(state?.pending || []).map(value => row(value.label, `核对助手指纹：${value.fingerprint}`,
    'confirm', `确认配对设备 ${value.label}`, () => call('pairing.confirm', value.requestId))));
  $('#pending').closest('section').hidden = !state?.pending?.length;
  $('#devices').replaceChildren(...(state?.devices || []).map(value => row(value.label, value.deviceId,
    'revoke', `撤销设备 ${value.label} 并断开连接`, () => call('devices.revoke', value.deviceId))));
  $('#connections').replaceChildren(...(state?.connections || []).map(value => row(
    state?.devices?.find(device => device.deviceId === value.deviceId)?.label || value.deviceId,
    `${({ direct: 'P2P 直连', relay: '加密中继', connecting: '路径协商中' })[value.path]} · ${value.streams} 条流`)));
  for (const [selector, empty] of [['#pending', '暂无待确认请求'], ['#devices', '尚未配对设备'], ['#connections', '暂无活动连接']]) {
    const list = $(selector);
    $(`${selector}-count`).textContent = list.childNodes.length;
    if (!list.childNodes.length) {
      const message = document.createElement('div');
      message.className = 'empty';
      message.textContent = empty;
      list.append(message);
    }
  }
}

async function refresh() {
  if (busy) { return; }
  try { state = await call('access.status'); render(); }
  catch (error) { $('#error').textContent = error.message; }
}

async function perform(action) {
  if (busy) { return; }
  busy = true;
  $('#error').textContent = '';
  render();
  try { await action(); }
  catch (error) { $('#error').textContent = error.message; }
  finally { busy = false; await refresh(); }
}

icon($('#invite'), 'invite', '创建两分钟配对邀请');
icon($('#copy'), 'copy', '复制邀请');
icon($('#help'), 'help', '查看连接与流量说明');
$('#toggle').onclick = () => perform(() => call(state?.running ? 'access.stop' : 'access.start'));
$('#assistant').onclick = () => perform(() => call('assistant.open'));
$('#invite').onclick = () => perform(async () => {
  invite = await call('pairing.create');
  $('#ticket').value = JSON.stringify(invite);
});
$('#copy').onclick = () => perform(() => navigator.clipboard.writeText($('#ticket').value));
pollVisible(lifecycle, refresh, 2000);
