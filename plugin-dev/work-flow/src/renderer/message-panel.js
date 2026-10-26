import { escape } from './api.js';

const CHANNELS = { wechat: '微信', feishu: '飞书' };
const STATES = { connecting: '连接中', connected: '已连接', scan: '等待扫码', error: '连接异常', disconnected: '已断开', paused: '已暂停' };
const QUEUE_STATES = { pending: '排队中', claimed: '执行中 / 等待确认', succeeded: '已完成', failed: '执行失败', canceled: '已取消',
  interrupted: '中断，需核对外部结果', invalid: '配置已变化', rejected: '队列已满，拒收' };
const icon = (label, attrs, path) => `<button type="button" class="icon-button" title="${label}" aria-label="${label}" ${attrs}>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg></button>`;

// Keep secrets in the short-lived form only; list/status events never repopulate password fields.
export function createMessagePanel(container, { invoke, subscribe, onConnectionsChanged, setStatus }) {
  let connections = [];
  let statuses = [];
  let queue = [];
  let workflowId;
  let generation = 0;
  let disposed = false;
  container.innerHTML = `<div class="message-actions">
    ${icon('新增消息连接', 'id="message-new"', 'M12 5v14M5 12h14')}
    ${icon('刷新消息连接', 'id="message-refresh"', 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1')}
    </div><div id="message-errors"></div><div id="message-list"></div><div id="message-form"></div>
    <p class="hint">仅接收文本；ID 白名单和关键词留空不限。飞书默认仅提及机器人，接收范围取决于应用权限。
    不同工作流独立消费，同一工作流串行排队。关闭最后一个窗口会停止监听。</p>
    <div class="message-actions"><strong>消息队列</strong>${icon('清空消息队列', 'id="message-clear"', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13')}</div>
    <div id="message-queue"></div>`;

  const act = async action => {
    try {
      await action();
    } catch (error) {
      setStatus(error.message, true);
    }
  };
  async function load() {
    const token = ++generation;
    const values = await Promise.all([invoke('messages.connections.list'), invoke('messages.status'),
      workflowId ? invoke('messages.queue.list', workflowId) : Promise.resolve([])]);
    if (disposed || token !== generation) {
      return;
    }
    [connections, statuses, queue] = values;
    onConnectionsChanged(connections);
    renderList();
    renderQueue();
  }
  function renderList() {
    container.querySelector('#message-errors').innerHTML = statuses.filter(item => item.workflowId).map(item =>
      `<p class="error-text">${escape(item.name)}：${escape(item.error)}</p>`).join('');
    const list = container.querySelector('#message-list');
    list.innerHTML = connections.map(connection => {
      const status = statuses.find(item => item.connectionId === connection.id && !item.workflowId);
      const qr = /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(status?.qrDataUrl || '') ? status.qrDataUrl : '';
      return `<section class="message-connection"><strong>${escape(connection.name)}</strong>
        <small>${CHANNELS[connection.channel]} · ${escape(STATES[status?.state] || '未监听')}</small>
        <small>订阅 ${status?.subscriptions || 0} · 收到 ${status?.received || 0} · 入队 ${status?.accepted || 0}
        · 忽略 ${status?.ignored || 0} · 拒收 ${status?.rejected || 0}（本次后台会话）</small>
        ${status?.lastMessage ? `<small>最近消息 ${escape(status.lastMessage.messageId)} · 会话 ${escape(status.lastMessage.chatId)}
        · 发送人 ${escape(status.lastMessage.senderId)} · ${new Date(status.lastMessage.receivedAt).toLocaleString('zh-CN')}</small>` : ''}
        ${status?.lastIssue ? `<small>最近忽略/拒收：${escape(({ 'queue-full': '队列已满', 'invalid-or-oversize': '无效或超过 64 KiB',
          'processing-failed': '处理或入队失败', 'self-or-non-text': '自发或非文本消息',
          'self-or-non-group-or-non-text': '自发、非群聊或非文本消息' })[status.lastIssue] || status.lastIssue)}</small>` : ''}
        ${status?.account ? `<small>${escape(status.account)}</small>` : ''}
        ${status?.error ? `<small class="error-text">${escape(status.error)}</small>` : ''}
        ${qr ? `<img class="message-qr" src="${qr}" alt="微信登录二维码（仅本地显示）">` : ''}
        <div class="message-actions">
          ${icon('编辑连接', `data-message-edit="${escape(connection.id)}"`, 'M4 20l4-1L20 7l-3-3L5 16zM14 7l3 3')}
          ${icon('测试连接', `data-message-test="${escape(connection.id)}"`, 'M9 3h6M10 3v6L5 19a1 1 0 0 0 1 2h12a1 1 0 0 0 1-2L14 9V3M8 15h8')}
          ${icon('重新连接', `data-message-reconnect="${escape(connection.id)}"`, 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1')}
          ${icon('断开连接', `data-message-disconnect="${escape(connection.id)}"`, 'M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v4')}
          ${icon('删除连接', `data-message-remove="${escape(connection.id)}"`, 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13')}
        </div></section>`;
    }).join('') || '<p class="hint">尚无连接，请添加 Wechaty 服务或飞书应用。</p>';
    list.querySelectorAll('[data-message-edit]').forEach(button => {
      button.onclick = () => edit(connections.find(item => item.id === button.dataset.messageEdit));
    });
    for (const action of ['test', 'reconnect', 'disconnect', 'remove']) {
      list.querySelectorAll(`[data-message-${action}]`).forEach(button => {
        button.onclick = () => act(async () => {
          if (action === 'remove' && !confirm('删除此消息连接？被工作流引用的连接不能删除。')) {
            return;
          }
          await invoke(`messages.connections.${action}`, button.getAttribute(`data-message-${action}`));
          await load();
        });
      });
    }
  }
  function edit(connection = { channel: 'wechat' }) {
    const form = container.querySelector('#message-form');
    const field = (name, label, type = 'text', value = '') => `<label>${label}<input id="message-${name}" type="${type}"
      value="${escape(value)}" autocomplete="off" ${type === 'password' ? 'placeholder="编辑时留空保留原密钥"' : ''}></label>`;
    form.innerHTML = `<form><label>渠道<select id="message-channel" ${connection.id ? 'disabled' : ''}>
      ${Object.entries(CHANNELS).map(([id, label]) => `<option value="${id}" ${connection.channel === id ? 'selected' : ''}>${label}</option>`).join('')}
      </select></label>${field('name', '连接名称', 'text', connection.name)}
      ${connection.channel === 'wechat' ? `${field('token', 'Wechaty 服务 Token', 'password')}
        ${field('endpoint', '服务端点（可选，域名:端口，默认 TLS）', 'text', connection.endpoint)}`
    : `${field('appId', 'App ID', 'text', connection.appId)}${field('appSecret', 'App Secret', 'password')}`}
      <div class="message-actions">${icon('保存连接', 'id="message-save"', 'M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8')}
      ${icon('取消编辑', 'id="message-cancel"', 'M6 6l12 12M18 6L6 18')}</div></form>`;
    form.querySelector('#message-channel').onchange = event => edit({ channel: event.target.value });
    form.querySelector('#message-cancel').onclick = () => { form.innerHTML = ''; };
    const save = event => {
      event.preventDefault();
      act(async () => {
        const input = { id: connection.id, channel: connection.channel };
        form.querySelectorAll('input').forEach(element => { input[element.id.replace('message-', '')] = element.value; });
        await invoke('messages.connections.save', input);
        form.innerHTML = '';
        setStatus('消息连接已保存。');
        await load();
      });
    };
    form.querySelector('form').onsubmit = save;
    form.querySelector('#message-save').onclick = save;
  }
  function renderQueue() {
    container.querySelector('#message-clear').disabled = !workflowId;
    container.querySelector('#message-queue').innerHTML = queue.map(item => `<section class="message-queue-item">
      <strong>${escape(QUEUE_STATES[item.status] || item.status)}</strong><small>${escape(item.message.channel)} · ${escape(item.message.chat.id)}
      · ${escape(item.message.sender.id)}</small><small>消息 ${escape(item.message.messageId)} · ${new Date(item.receivedAt).toLocaleString('zh-CN')}</small>
      ${item.reason ? `<small>${escape(item.reason)}</small>` : ''}
      ${!['pending', 'claimed'].includes(item.status) ? icon('核对后重新运行', `data-message-retry="${escape(item.id)}"`, 'M8 5v14l11-7z') : ''}
      </section>`).join('') || '<p class="hint">当前工作流暂无消息记录。</p>';
    container.querySelectorAll('[data-message-retry]').forEach(button => {
      button.onclick = () => act(async () => {
        if (confirm('重新运行会新建一次执行，可能重复产生外部写入。请先核对外部结果，确认继续？')) {
          await invoke('messages.queue.retry', button.dataset.messageRetry);
          await load();
        }
      });
    });
  }
  container.querySelector('#message-new').onclick = () => edit();
  container.querySelector('#message-refresh').onclick = () => act(load);
  container.querySelector('#message-clear').onclick = () => act(async () => {
    if (workflowId && confirm('清空当前工作流的排队消息和异常历史？活动运行保持不变。')) {
      await invoke('messages.queue.clear', workflowId);
      await load();
    }
  });
  const unsubscribe = subscribe('messages.changed')(() => act(load));
  return { load, render(workflow) {
    if (workflowId !== workflow?.id) {
      workflowId = workflow?.id;
      act(load);
    }
  }, dispose() { disposed = true; generation++; unsubscribe(); } };
}
