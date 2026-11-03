import '../../../../desk/src/resource/controls.css';
import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
import { pageLifecycle, pollVisible } from '../../../../desk/src/resource/page-lifecycle.js';
import { call, subscribe } from './api.js';
import './style.css';

const $ = selector => document.querySelector(selector);
const paths = { add: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  save: '<path d="M5 3h12l4 4v14H3V3h2Zm2 0v7h10V3M7 21v-7h10v7"/>', edit: '<path d="m4 16 12-12 4 4L8 20l-5 1zM14 6l4 4"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>', key: '<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 3 3-3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="m7 4 13 8-13 8z"/>', unlink: '<path d="m3 3 18 18M9 6l2-2a5 5 0 0 1 7 7l-2 2M8 11l-2 2a5 5 0 0 0 7 7l2-2"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>', scan: '<path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5M7 7h3v3H7zm7 0h3v3h-3zM7 14h3v3H7zm7 0h3v3h-3z"/>',
  check: '<path d="m4 12 5 5L20 6"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>' };
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const labels = { connected: '已连接', connecting: '连接中', login_required: '需要登录', scan: '等待扫码', scanned: '已扫码，请在手机确认登录', confirming: '已确认，正在初始化登录', verify_required: '需要验证码',
  error: '连接异常', disabled: '已禁用', stopped: '未启动', received: '等待授权或调度', queued: '排队中', submitting: '提交核对中', running: '执行中',
  waiting_input: '等待回复或本地确认', completed: '已完成', sent: '已发送', uncertain: '回执不确定', pending: '待发送', cancelled: '已关闭', failed: '失败', interrupted: '已中断' };
let state = { channels: [], routes: [], exchanges: [], deliveries: [], sources: [] };
let tab = 'routes';
let targets = [];
let refreshing;
let verifyChannel;
const lifecycle = pageLifecycle();

function report(error) { $('#error').hidden = false; $('#error').textContent = error.message; }
function action(name, title, callback) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'icon'; button.title = title; button.setAttribute('aria-label', title); button.innerHTML = icon(name);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { $('#error').hidden = true; await callback(button); await refresh(); }
    catch (error) { report(error); }
    finally { button.disabled = false; }
  });
  return button;
}

function row(name, status) {
  const root = document.createElement('div'); root.className = 'row';
  const details = document.createElement('div'); details.className = 'details';
  const title = document.createElement('strong'); title.textContent = name;
  const detail = document.createElement('span'); detail.className = 'state'; detail.textContent = status;
  const actions = document.createElement('div'); actions.className = 'actions';
  details.append(title, detail); root.append(details, actions);
  return { root, details, actions };
}

function empty(container, text) {
  if (container.children.length) { return; }
  const node = document.createElement('p'); node.className = 'empty'; node.textContent = text; container.append(node);
}

async function confirm(message, anchor) {
  const dialog = $('#confirm-dialog'); $('#confirm-message').textContent = message;
  return new Promise(resolve => {
    $('#confirm-yes').onclick = () => { resolve(true); closePopup(dialog); };
    $('#confirm-no').onclick = () => { resolve(false); closePopup(dialog); };
    dialog.oncancel = () => resolve(false);
    showPopup(dialog, anchor, { placement: 'center' });
  });
}

function render() {
  $('#authority').textContent = state.authorized ? 'Agent 桥接已授权' : '等待本地授权 · 收到的消息最多保留 10 分钟等待执行';
  $('#authorize').disabled = state.authorized; $('#revoke').disabled = !state.authorized;
  $('#add').hidden = !['routes', 'channels'].includes(tab);
  $('#add').title = $('#add').ariaLabel = tab === 'channels' ? '新增渠道' : '新增规则';
  for (const id of ['routes', 'channels', 'history', 'sources']) { $(`#${id}`).hidden = id !== tab; $(`#${id}`).replaceChildren(); }
  for (const route of state.routes) {
    const item = row(route.name || route.trigger.value || '@机器人', `${route.enabled ? '已启用' : '已暂停'} · ${route.target.mode === 'dedicated' ? '专属会话持续复用 · 只读' : '已有会话'} · ${route.trigger.type === 'mention' ? '@机器人' : route.trigger.value}`);
    item.actions.append(action('edit', '编辑规则', button => editRoute(route, button)), action(route.enabled ? 'pause' : 'play', route.enabled ? '暂停接收新消息' : '启用规则', () => call('bridge.saveRoute', { ...route, enabled: !route.enabled })),
      action('unlink', '解绑并关闭旧交互', async button => { if (await confirm('解绑会关闭该规则的旧消息交互，保留 Agent 会话与历史。', button)) { await call('bridge.unbindRoute', route.id); } }));
    $('#routes').append(item.root);
  }
  empty($('#routes'), '还没有转发规则。先配置渠道，再选择触发方式和 Agent 会话。');
  for (const channel of state.channels) {
    const item = row(channel.name, `${{ feishu: '飞书', wechat: '微信好友与群', 'weixin-bot': '微信机器人' }[channel.type]} · ${labels[channel.status.state] || channel.status.state}${channel.status.account ? ` · ${channel.status.account}` : ''}${channel.status.error ? ` · ${channel.status.error}` : ''}`);
    item.actions.append(action('edit', '编辑渠道', button => editChannel(channel, button)));
    if (channel.type !== 'feishu') {
      item.actions.append(action(channel.puppet === 'native' ? 'refresh' : 'scan', channel.puppet === 'native' ? '连接本机微信网关' : '扫码连接', () => call('bridge.login', channel.id)));
    }
    if (channel.status.state === 'verify_required') {
      item.actions.append(action('key', '输入微信验证码', button => { verifyChannel = channel.id; showPopup($('#verify-dialog'), button, { placement: 'center' }); }));
    }
    item.actions.append(action(channel.enabled ? 'pause' : 'play', channel.enabled ? '停止渠道并关闭旧交互' : '启用渠道', () => call('bridge.saveChannel', { ...channel, status: undefined, configured: undefined, enabled: !channel.enabled })),
      action('trash', '移除渠道', async button => { if (await confirm('移除渠道会停止监听并关闭旧交互，保留已有 Agent 会话。', button)) { await call('bridge.removeChannel', channel.id); } }));
    if (channel.status.qrDataUrl?.startsWith('data:image/png;base64,')) {
      const image = document.createElement('img'); image.src = channel.status.qrDataUrl; image.className = 'qr'; image.alt = '微信登录二维码'; item.details.append(image);
    }
    $('#channels').append(item.root);
  }
  empty($('#channels'), '还没有消息渠道。可添加飞书应用、微信专用机器人或微信好友与群接入。');
  for (const exchange of state.exchanges) {
    const item = row(`${exchange.source.chatId} · ${exchange.source.senderId}`, `${labels[exchange.state] || exchange.state} · ${new Date(exchange.createdAt).toLocaleString()}${exchange.queueReason ? ` · ${exchange.queueReason}` : ''}${exchange.error ? ` · ${exchange.error}` : ''}`);
    const deliveries = state.deliveries.filter(delivery => delivery.exchangeId === exchange.id);
    if (deliveries.length) {
      const detail = document.createElement('div'); detail.textContent = `回传：${deliveries.map(delivery => labels[delivery.state] || delivery.state).join(' / ')}`; item.details.append(detail);
    }
    for (const delivery of deliveries.filter(item => item.state === 'uncertain' && !exchange.closed)) {
      item.actions.append(action('refresh', '核对原聊天后重发该片段', async button => {
        if (await confirm('该片段可能已发送成功。请先核对原聊天；确认重发可能产生重复消息。', button)) { await call('bridge.retry', delivery.id, true); }
      }));
    }
    $('#history').append(item.root);
  }
  empty($('#history'), '尚无触发记录。');
  for (const source of state.sources) {
    const item = row(`${source.channelId} · ${source.chatType === 'group' ? '群聊' : '私聊'}`, `会话 ID：${source.chatId}　发送者 ID：${source.senderId}`);
    item.actions.append(action('add', '为此来源创建规则', button => editRoute({ channelId: source.channelId }, button)));
    $('#sources').append(item.root);
  }
  empty($('#sources'), '连接渠道后可在此查看消息来源；只有命中已启用规则的文本会发送给 Agent。');
}

function fill(form, values) {
  form.reset();
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    if (!field) { continue; }
    if (field.type === 'checkbox') { field.checked = Boolean(value); }
    else { field.value = value ?? ''; }
  }
}

function channelFields() {
  const form = $('#channel-form');
  const type = form.elements.type.value;
  document.querySelectorAll('.feishu-field').forEach(node => { node.hidden = type !== 'feishu'; });
  document.querySelectorAll('.wechat-field').forEach(node => { node.hidden = type !== 'wechat'; });
  const native = form.elements.puppet.value === 'native';
  document.querySelectorAll('.wechat-service-field').forEach(node => { node.hidden = type !== 'wechat' || form.elements.puppet.value === 'wechat4u'; });
  document.querySelectorAll('.wechat-native-field').forEach(node => { node.hidden = type !== 'wechat' || !native; });
  $('#gateway-token-label').textContent = native ? '本机网关 Token' : 'Puppet Service Token';
  form.elements.endpoint.placeholder = native ? '127.0.0.1:18401' : '由服务提供方提供';
}

function editChannel(channel = {}, anchor) {
  fill($('#channel-form'), { id: '', name: '', type: 'feishu', enabled: true, ...channel,
    puppet: channel.puppet || (channel.id ? (channel.type === 'wechat' && (channel.configured || channel.endpoint) ? 'service' : 'wechat4u') : 'native'),
    appSecret: '', token: '' });
  channelFields(); showPopup($('#channel-dialog'), anchor, { placement: 'center' });
}

function routeFields() {
  const form = $('#route-form'); const existing = form.elements.mode.value === 'existing';
  document.querySelectorAll('.existing-field').forEach(node => { node.hidden = !existing; });
  document.querySelectorAll('.dedicated-field').forEach(node => { node.hidden = existing; });
  form.elements.targetId.required = existing; form.elements.accepted.required = existing;
  form.elements.triggerValue.disabled = form.elements.triggerType.value === 'mention';
}

async function editRoute(route = {}, anchor) {
  const form = $('#route-form');
  form.elements.channelId.replaceChildren(new Option('选择渠道', ''), ...state.channels.map(channel => new Option(channel.name, channel.id)));
  targets = state.authorized ? (await call('bridge.catalog')).targets : [];
  form.elements.targetId.replaceChildren(new Option('选择已打开的会话', ''), ...targets.map(target => {
    const option = new Option(`${target.name || target.targetRef.id} · ${target.engineId}${target.available ? '' : ' · 暂不支持原生轮次关联'}`, target.targetRef.id);
    option.disabled = !target.available; return option;
  }));
  fill(form, { id: '', enabled: true, channelId: state.channels.length === 1 ? state.channels[0].id : '', ...route,
    triggerType: route.trigger?.type || 'prefix', triggerValue: route.trigger?.value || '@小微', mode: route.target?.mode || 'dedicated',
    engineId: route.target?.engineId || 'codex', cwd: route.target?.cwd || '', targetId: route.target?.targetRef?.id || '', accepted: route.executionPolicy?.accepted });
  routeFields(); showPopup($('#route-dialog'), anchor, { placement: 'center' });
}

async function refresh() {
  if (refreshing) { return refreshing; }
  refreshing = call('bridge.snapshot').then(value => {
    if (JSON.stringify(state) !== JSON.stringify(value)) { state = value; render(); }
  }).finally(() => { refreshing = null; });
  return refreshing;
}

for (const node of document.querySelectorAll('[data-icon]')) { node.innerHTML = icon(node.dataset.icon); }
for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => {
    tab = button.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(node => node.setAttribute('aria-pressed', String(node === button))); render();
  });
}
for (const button of document.querySelectorAll('[data-close]')) { button.addEventListener('click', () => closePopup($(`#${button.dataset.close}`))); }
const run = task => async event => { event?.preventDefault(); try { $('#error').hidden = true; await task(event); await refresh(); } catch (error) { report(error); } };
function saveForm(id, task) {
  const form = $(id);
  const submit = run(task);
  form.onsubmit = submit;
  // Plugin frames intentionally omit allow-forms; keep validation while handling the default button entirely in JS.
  form.querySelector('[type=submit]').onclick = event => {
    event.preventDefault();
    if (form.reportValidity()) { submit(event); }
  };
}
$('#add').onclick = run(event => tab === 'channels' ? editChannel({}, event.currentTarget) : editRoute({}, event.currentTarget));
$('#refresh').onclick = run(refresh);
$('#authorize').onclick = run(() => call('bridge.authorize'));
$('#revoke').onclick = run(async event => { if (await confirm('撤销授权将关闭旧消息交互，重新授权后也不会补发旧结果。', event.currentTarget)) { await call('bridge.revoke'); } });
$('#channel-form').elements.type.onchange = channelFields;
$('#channel-form').elements.puppet.onchange = channelFields;
$('#route-form').elements.mode.onchange = routeFields;
$('#route-form').elements.triggerType.onchange = routeFields;
saveForm('#channel-form', async () => {
  const data = Object.fromEntries(new FormData($('#channel-form'))); data.enabled = $('#channel-form').elements.enabled.checked;
  await call('bridge.saveChannel', data); closePopup($('#channel-dialog'));
});
saveForm('#route-form', async () => {
  const form = $('#route-form'); const data = Object.fromEntries(new FormData(form));
  const selected = targets.find(target => target.targetRef.id === data.targetId);
  const previous = state.routes.find(route => route.id === data.id);
  const target = data.mode === 'existing' ? { mode: 'existing', targetRef: selected?.targetRef }
    : { mode: 'dedicated', engineId: data.engineId, ...(data.cwd ? { cwd: data.cwd } : {}) };
  await call('bridge.saveRoute', { id: data.id, name: previous?.name || data.triggerValue || '@机器人', channelId: data.channelId,
    enabled: form.elements.enabled.checked, sourceMode: 'channel', priority: previous?.priority || 0, scope: previous?.scope || 'sender',
    trigger: { type: data.triggerType, ...(data.triggerType === 'mention' ? {} : { value: data.triggerValue }) }, target,
    executionPolicy: { mode: data.mode === 'existing' ? 'existing' : 'readOnly', ...(data.mode === 'existing' ? { accepted: form.elements.accepted.checked } : {}) } });
  closePopup($('#route-dialog'));
});
saveForm('#verify-form', async () => { await call('bridge.verify', verifyChannel, $('#verify-form').elements.code.value); closePopup($('#verify-dialog')); });
subscribe(() => { if (lifecycle.visible()) { refresh().catch(report); } });
pollVisible(lifecycle, refresh, 2000, { onError: report });
refresh().catch(report);
