import { pageLifecycle, pollVisible } from '../../../../desk/src/resource/page-lifecycle.js';
import '../../../../desk/src/resource/controls.css';
import { call, listWindows, subscribe } from './api.js';
import './style.css';

const lifecycle = pageLifecycle();
const $ = selector => document.querySelector(selector);
let state;
let selected;
let offset = 0;
let decoder = new TextDecoder();
let fragment = '';
let generation = 0;
let loading = false;
let refreshTimer;
let sources = [];
let busy = false;
let lastDirection;
const maxDisplay = 2 * 1024 * 1024;

function report(error) { $('#error').textContent = error.message; }

function renderStatus(value) {
  state = value;
  $('#toggle').disabled = busy || !target()?.supported;
  $('#toggle').innerHTML = value.enabled ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg>' : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 4 12 8-12 8z"/></svg>';
  $('#toggle').title = value.enabled ? '停止记录' : '开始记录';
  $('#toggle').setAttribute('aria-label', $('#toggle').title);
  const labels = { unselected: '请选择 Agent 窗口和具体对话', stopped: '已停止记录，已有连接继续转发',
    connected: '已接入，等待请求', captured: '已捕获目标对话的请求和响应', unavailable: '目标 Agent 已失联，请刷新并重新选择',
    unsupported: '该引擎尚不支持网络抓包' };
  $('#status').textContent = value.state === 'waiting'
    ? (value.running ? '等待当前轮次结束，下一轮接入' : '已开启，等待该对话的下一次请求') : labels[value.state] || '请选择目标对话';
  if (value.logDirectory) { $('#directory').textContent = `日志目录：${value.logDirectory}`; }
  $('#error').textContent = value.error || value.warning || '';
}

function target() {
  const [sourceIndex, selectionId] = $('#agent-window').value.split('/');
  const source = sources[Number(sourceIndex)];
  const group = source?.windows.find(value => value.selectionId === selectionId);
  const record = group?.conversations.find(value => value.id === $('#conversation').value);
  return record ? { pluginId: source.pluginId, instanceId: source.instanceId, windowId: group.id,
    conversationId: record.id, supported: record.supported } : null;
}

function targetIdentity(value) {
  if (!value) { return null; }
  const { pluginId, instanceId, windowId, conversationId } = value;
  return { pluginId, instanceId, windowId, conversationId };
}

function sameTarget(one, two) { return JSON.stringify(targetIdentity(one)) === JSON.stringify(targetIdentity(two)); }

function conversations() {
  const previous = $('#conversation').value;
  const [index, selectionId] = $('#agent-window').value.split('/');
  const group = sources[Number(index)]?.windows.find(value => value.selectionId === selectionId);
  $('#conversation').replaceChildren(new Option('选择具体对话', ''));
  for (const record of group?.conversations || []) {
    $('#conversation').add(new Option(`${record.name || '新对话'} · ${record.engineId}${record.supported ? '' : '（不支持）'}`, record.id));
  }
  if ([...$('#conversation').options].some(option => option.value === previous)) { $('#conversation').value = previous; }
}

async function discover() {
  const [catalogs, liveWindows] = await Promise.all([call('capture.sources'), listWindows()]);
  // Stored conversation groups are history, not desktop windows. Only the host can establish liveness and display names.
  const current = catalogs.map(source => ({ ...source, windows: liveWindows.filter(view => view.pluginId === source.pluginId).flatMap(view => {
    const group = source.windows.find(group => group.hostWindowIds?.includes(view.id));
    return group ? [{ ...group, selectionId: view.id, name: view.name }] : [];
  }) }));
  if (JSON.stringify(current) === JSON.stringify(sources)) { return; }
  const previous = targetIdentity(target()) || state?.target;
  const [previousIndex, selectionId] = $('#agent-window').value.split('/');
  const previousSource = sources[Number(previousIndex)];
  sources = current;
  $('#agent-window').replaceChildren(new Option('选择 Agent 窗口', ''));
  sources.forEach((source, index) => {
    for (const group of source.windows) {
      const option = new Option(group.name, `${index}/${group.selectionId}`);
      option.title = `${source.pluginId} · ${group.selectionId}`;
      $('#agent-window').add(option);
    }
  });
  const restored = selectionId ? previousSource : state?.target;
  if (restored) {
    const index = sources.findIndex(source => source.pluginId === restored.pluginId && source.instanceId === restored.instanceId);
    const group = sources[index]?.windows.find(group => selectionId ? group.selectionId === selectionId : group.id === restored.windowId);
    if (group) { $('#agent-window').value = `${index}/${group.selectionId}`; }
  }
  conversations();
  if (!selectionId && restored) { $('#conversation').value = restored.conversationId; }
  if (previous && !sameTarget(previous, target())) { await changeTarget(); }
  if (!sources.length) { report(Error('未发现支持会话抓包的 Agent，请启用新版 AI 插件')); }
}

function resetOutput() {
  selected = null;
  generation++;
  offset = 0;
  fragment = '';
  lastDirection = null;
  decoder = new TextDecoder();
  $('#request-output').textContent = '';
  $('#response-output').textContent = '';
  $('#records').replaceChildren();
  $('#empty').hidden = false;
  $('#count').textContent = '';
  $('#directory').textContent = '';
  $('#selection').textContent = '选择一条请求查看上下文';
  $('#position').textContent = '';
  $('#more').disabled = true;
}

async function list() {
  const current = targetIdentity(target());
  if (!current || !sameTarget(current, state?.target)) { return; }
  const records = await call('capture.list', current);
  if (!sameTarget(current, target())) { return; }
  const container = $('#records');
  container.replaceChildren();
  $('#empty').hidden = records.length > 0;
  for (const record of records) {
    const button = document.createElement('button');
    button.className = record.id === selected ? 'selected' : '';
    button.textContent = `${new Date(record.at).toLocaleTimeString()} · ${(record.bytes / 1024).toFixed(1)} KB\n${record.id.slice(0, 8)}`;
    button.title = record.id;
    button.setAttribute('aria-pressed', String(record.id === selected));
    button.addEventListener('click', () => select(record.id).catch(report));
    container.append(button);
  }
  $('#count').textContent = `${records.length} 条（最近 200 条）`;
  if (!selected && records.length) { await select(records[0].id); }
}

function display(event) {
  if ($('#raw').checked) { return `${JSON.stringify(event)}\n`; }
  if (event.type.endsWith('.body')) { return ''; }
  if (event.type.endsWith('.text')) {
    const prefix = lastDirection === event.type ? '' : `\n[${event.type}]\n`;
    lastDirection = event.type;
    return prefix + event.text;
  }
  if (event.type.endsWith('.message')) {
    return `\n[${event.type}]\n${event.text || `[二进制消息] ${event.base64}`}\n`;
  }
  const { id, sequence, at, type, ...details } = event;
  return `\n[${type}] ${at || ''}\n${JSON.stringify(details, null, 2)}\n`;
}

async function more() {
  if (!lifecycle.visible() || !selected || loading) { return; }
  const current = generation;
  let remaining = false;
  loading = true;
  try {
    const page = await call('capture.read', selected, offset, targetIdentity(target()));
    if (current !== generation) { return; }
    const bytes = Uint8Array.from(atob(page.data), c => c.charCodeAt(0));
    fragment += decoder.decode(bytes, { stream: true });
    offset = page.offset;
    const lines = fragment.split('\n');
    fragment = lines.pop();
    const additions = { request: '', response: '' };
    for (const line of lines) {
      if (!line) { continue; }
      const event = JSON.parse(line);
      const direction = event.type.startsWith('request.') ? 'request' : 'response';
      additions[direction] += display(event);
    }
    for (const [direction, addition] of Object.entries(additions)) {
      const output = $(`#${direction}-output`);
      const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 60;
      output.textContent += addition;
      if (output.textContent.length > maxDisplay) {
        output.textContent = `[每栏仅保留最近 2 MB，完整数据在本地日志中]\n${output.textContent.slice(-maxDisplay)}`;
      }
      if (follow) { output.scrollTop = output.scrollHeight; }
    }
    $('#more').disabled = offset >= page.bytes;
    $('#position').textContent = `${offset.toLocaleString()} / ${page.bytes.toLocaleString()} 字节`;
    remaining = offset < page.bytes;
  } finally {
    loading = false;
    if (lifecycle.visible() && (current !== generation || remaining)) { queueMicrotask(() => more().catch(report)); }
  }
}

async function select(id) {
  selected = id;
  generation++;
  offset = 0;
  fragment = '';
  lastDirection = null;
  decoder = new TextDecoder();
  $('#request-output').textContent = '';
  $('#response-output').textContent = '';
  $('#selection').textContent = id;
  await list();
  if (loading) { setTimeout(() => more().catch(report), 100); }
  else { await more(); }
}

async function configure(recording) {
  const chosen = target();
  busy = true;
  $('#toggle').disabled = true;
  try {
    $('#error').textContent = '';
    renderStatus(await call('capture.configure', { enabled: recording, target: targetIdentity(chosen) }));
  } finally { busy = false; $('#toggle').disabled = !chosen?.supported; }
}

async function changeTarget() {
  const enabled = Boolean(state?.enabled);
  resetOutput();
  if (target()?.supported) { await configure(enabled); await list(); }
  else {
    try {
      if (state?.enabled) { await call('capture.configure', { enabled: false }); }
    } finally { renderStatus({ enabled: false, state: target() ? 'unsupported' : 'unselected' }); }
  }
}
$('#toggle').addEventListener('click', () => configure(!state.enabled).catch(report));
$('#agent-window').addEventListener('change', () => { conversations(); changeTarget().catch(report); });
$('#conversation').addEventListener('change', () => changeTarget().catch(report));
$('#refresh').addEventListener('click', () => refresh(true).catch(report));
$('#more').addEventListener('click', () => more().catch(report));
// 只切换可见栏，避免重新读取日志或丢失另一方向的内容。
$('#direction').addEventListener('change', () => {
  const direction = $('#direction').value;
  $('#output').dataset.direction = direction;
  $('#request-pane').hidden = direction === 'response';
  $('#response-pane').hidden = direction === 'request';
});
$('#raw').addEventListener('change', () => { if (selected) { select(selected).catch(report); } });
subscribe(event => {
  if (event.type === 'capture.unavailable') { report(Error(`Agent 连接暂时不可用：${event.message || event.code}`)); return; }
  if (event.type === 'capture.error') { report(Error(`日志写入失败：${event.code}`)); return; }
  if (lifecycle.visible() && !refreshTimer) {
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (!lifecycle.visible()) { return; }
      try { await list(); await more(); } catch (error) { report(error); }
    }, 250);
  }
});

async function refresh(withSources = false) {
  if (busy || !lifecycle.visible()) { return; }
  if (withSources) { await discover(); }
  const expected = targetIdentity(target());
  const status = await call('capture.status');
  if (busy || !sameTarget(expected, target())) { return; }
  if (target() && sameTarget(target(), status.target)) { renderStatus(status); await list(); await more(); }
  else { renderStatus({ enabled: false, state: target() && !target().supported ? 'unsupported' : 'unselected' }); }
}
try { state = await call('capture.status'); await discover(); }
catch (error) { report(error); }
pollVisible(lifecycle, () => refresh(true), 1500, { onError: report });
