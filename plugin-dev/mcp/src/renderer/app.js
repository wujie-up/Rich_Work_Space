import { pageLifecycle, pollVisible } from '../../../../desk/src/resource/page-lifecycle.js';
import '../../../../desk/src/resource/controls.css';
import './style.css';
import { invoke, escape, action } from './api.js';
import { deploymentForm, bindDeployment } from './deployment-form.js';
import { readServiceArchive } from './service-archive.js';
import { confirmDelete } from './confirm-delete.js';
import { renderBuiltinTools } from './builtin-tools.js';
let current;
let services = [];
const lifecycle = pageLifecycle();
lifecycle.subscribe(visible => {
  clearTimeout(poll);
  debugRefresh++;
  if (visible && debugId) {
    updateDebug(debugId).catch(error => { document.querySelector('#status').textContent = error.message; });
  }
});
let debugId;
let poll;
let debugRefresh = 0;
let renderSequence = 0;
const app = document.querySelector('#app');
app.innerHTML = `<header class="workspace-tools"><button id="back" class="icon-button" hidden aria-label="返回服务列表" title="返回服务列表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18"/></svg></button>
<div class="workspace-actions"><button id="import-archive" type="button" class="icon-button" aria-label="导入服务压缩包" title="导入服务压缩包"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h12l4 4v14H4z M14 3v5h6 M12 11v7m-3-3 3 3 3-3"/></svg></button>
<button id="new" type="button" class="icon-button" aria-label="添加服务" title="添加服务"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
<input id="archive-file" type="file" accept=".zip,application/zip" aria-label="选择服务压缩包" hidden></header>
<div class="layout"><nav id="services" aria-label="MCP 服务列表"></nav><section id="details" hidden></section></div>
<div id="status" role="status"></div>`;
const field = (name, label, value = '', textarea = false) => `<label>${label}<${textarea ? 'textarea' : 'input'} name="${name}" ${textarea ? '' : `value="${escape(value)}"`}>${textarea ? escape(value) + '</textarea>' : ''}</label>`;

async function endDebug() {
  clearTimeout(poll);
  if (debugId) {
    const state = await invoke('mcp.debug.cancel', debugId);
    if (!state.cleaned) { throw Error(state.error); }
  }
  debugId = undefined;
}

function serviceControls(value) {
  const active = ['running', 'starting'].includes(value.state);
  return [
    ['start', '开启', 'M12 3v9 M7 5a9 9 0 1 0 10 0'],
    ['stop', '关闭', 'M5 5h14v14H5z']
  ].map(([method, label, path]) => `<button class="icon-button" data-service-id="${escape(value.id)}"
    data-service-method="${method}" title="${label} ${escape(value.name)}" aria-label="${label} ${escape(value.name)}"
    ${(method === 'start' ? active : !active) ? 'disabled' : ''}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg></button>`).join('');
}

const serviceStatus = value => `${value.state} · ${value.clients} 个连接`;

async function refreshServiceStatus() {
  if (document.querySelector('#services').hidden) { return; }
  const values = await invoke('mcp.list');
  // Patch status text only: replacing rows would interrupt focus and in-progress actions.
  for (const value of values) {
    const status = document.querySelector(`[data-service-status="${CSS.escape(value.id)}"]`);
    if (status) { status.textContent = serviceStatus(value); }
  }
}

async function refresh() {
  services = await invoke('mcp.list');
  document.querySelector('#services').innerHTML = services.map(value => `<div class="service-row ${current === value.id && !document.querySelector('#details').hidden ? 'selected' : ''}"><div class="service-name">${escape(value.name)}<br><small data-service-status="${escape(value.id)}">${escape(serviceStatus(value))}</small></div>${serviceControls(value)}<button data-id="${escape(value.id)}" aria-label="配置 ${escape(value.name)}" title="配置 ${escape(value.name)}" aria-expanded="${current === value.id && !document.querySelector('#details').hidden}" aria-controls="details"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--panel)"/><circle cx="15" cy="17" r="3" fill="var(--panel)"/></svg></button></div>`).join('');
  document.querySelectorAll('[data-service-method]').forEach(button => {
    button.onclick = () => action(async () => {
      const { serviceId, serviceMethod } = button.dataset;
      try {
        try {
          await invoke(`mcp.${serviceMethod}`, serviceId);
        } finally {
          // A failed start also changes runtime state; always read it back from the service.
          await refresh();
        }
        document.querySelector(`[data-service-id="${CSS.escape(serviceId)}"]:not(:disabled)`)?.focus();
        console.info('[mcp:list-control]', { pluginId: 'mcp-services', serviceId, method: serviceMethod });
      } catch (error) {
        console.error('[mcp:list-control-failed]', { pluginId: 'mcp-services', serviceId, method: serviceMethod }, error);
        throw error;
      }
    });
  });
  document.querySelectorAll('[data-id]').forEach(button => {
    button.onclick = () => action(async () => {
      await endDebug();
      if (current === button.dataset.id) {
        showDetails();
        await refresh();
        return;
      }
      current = button.dataset.id;
      showDetails();
      await refresh();
      await render();
    });
  });
  if (!(await invoke('mcp.builtin.status')).removed) {
    document.querySelector('#services').insertAdjacentHTML('beforeend', '<div class="service-row"><div class="service-name">飞书文档与电脑工具</div><button id="builtin-settings" class="icon-button" title="配置飞书文档与电脑工具" aria-label="配置飞书文档与电脑工具"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></svg></button><button id="builtin-remove" class="icon-button" title="删除内置飞书文档与电脑工具" aria-label="删除内置飞书文档与电脑工具"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div>');
    document.querySelector('#builtin-settings').onclick = () => action(async () => {
      await endDebug();
      current = undefined;
      const sequence = ++renderSequence;
      const config = await invoke('mcp.builtin.read');
      if (sequence !== renderSequence) { return; }
      showDetails();
      renderBuiltinTools(document.querySelector('#details'), config);
    });
    document.querySelector('#builtin-remove').onclick = async () => {
      if (!await confirmDelete('飞书文档与电脑工具', '将停用相关内置能力并移除列表入口，保留本机凭据及独立 MCP 服务。')) { return; }
      await action(async () => {
        await invoke('mcp.builtin.remove');
        await refresh();
      });
      if (!document.querySelector('#builtin-remove')) { document.querySelector('#new').focus(); }
    };
  }
  document.querySelector('#new').onclick = () => action(async () => { await endDebug(); current = undefined; await refresh(); await render(); });
}

// Keep the form mounted when returning to the list so unsaved edits survive navigation.
function showDetails(visible = true) {
  document.querySelector('#details').hidden = !visible;
  document.querySelector('#services').hidden = visible;
  document.querySelector('#back').hidden = !visible;
}

function closeDetails() {
  ++renderSequence;
  current = undefined;
  const details = document.querySelector('#details');
  showDetails(false);
  details.replaceChildren();
}

async function render(imported) {
  const sequence = ++renderSequence;
  const selected = current;
  const value = { ...(imported || services.find(value => value.id === current)
    || { transport: 'script', args: [], env: {}, headers: {} }) };
  if (value.transport === 'script' && value.deployment) { value.source = await invoke('mcp.source', selected); }
  if (sequence !== renderSequence || selected !== current) { return; }
  showDetails();
  const bearer = Object.entries(value.headers || {}).find(([name, secret]) => name.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(secret));
  const headers = Object.fromEntries(Object.entries(value.headers || {}).filter(([name]) => name !== bearer?.[0]));
  document.querySelector('#details').innerHTML = `<form id="config"><input type="hidden" name="id" value="${escape(value.id)}">${field('name', '显示名称', value.name)}
${field('description', '功能描述', value.description, true)}
<label>服务类型<select name="transport"><option value="script">Python / JavaScript</option><option value="stdio">本地 stdio</option><option value="http">远程 Streamable HTTP</option></select></label>
${deploymentForm(value)}
<div id="stdio">${field('command', '命令（可执行文件）', value.command)}${field('args', '参数 · JSON 数组', JSON.stringify(value.args || []), true)}${field('cwd', '工作目录（绝对路径，可留空）', value.cwd)}${field('env', '环境变量 · JSON 对象（敏感配置仅存本机）', JSON.stringify(value.env || {}), true)}</div>
<div id="http">${field('url', 'MCP 服务地址', value.url)}<label>密钥（Bearer Token，可留空）<input type="password" name="apiKey" autocomplete="off" value="${escape(bearer?.[1].replace(/^Bearer\s+/i, '') || '')}"></label>
<small>配置仅保存在本机，发送到填写的服务地址。</small>
<details><summary>高级请求头</summary>${field('headers', '请求头 · JSON 对象', JSON.stringify(headers), true)}</details></div>
<details><summary>调试目标（可选）</summary><label>用自然语言描述希望 AI 验证的功能<textarea id="debug-prompt" placeholder="例如：查询最近五分钟的测试日志并解释结果"></textarea></label></details>
<div class="row actions"><button type="button" id="save" title="保存" aria-label="保存" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8"/></svg></button><button type="button" id="debug" title="调试" aria-label="调试" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8h8v10a4 4 0 0 1-8 0z M9 8V5h6v3 M3 12h5 M16 12h5 M3 18h5 M16 18h5 M5 6l3 3 M19 6l-3 3"/></svg></button><button type="button" id="start" ${!current || value.state === 'running' ? 'disabled' : ''} title="启用" aria-label="启用" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9 M7 5a9 9 0 1 0 10 0"/></svg></button><button type="button" id="stop" ${value.state !== 'running' ? 'disabled' : ''} title="停用" aria-label="停用" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg></button><button type="button" id="remove" ${!current ? 'disabled' : ''} title="删除" aria-label="删除" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button></div>
<small>保存有效修改后服务会停用；点击启用后使用新配置。调试使用当前代码和配置，结束后清理临时服务。</small></form>
<section id="debug-panel" hidden aria-label="AI 调试结果"><div class="row"><strong>AI 调试</strong><button id="end-debug" title="结束调试" aria-label="结束调试" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg></button></div><p id="debug-state" role="status"></p><div id="debug-questions"></div><pre id="debug-result"></pre></section>
${current ? '<details id="service-logs" open><summary>服务日志</summary><div class="row"><button id="logs" aria-label="刷新日志" title="刷新日志"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg></button><button id="clear-logs" aria-label="清理当前服务日志" title="清理当前服务日志"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div><pre id="result" aria-label="服务日志内容">加载中…</pre></details>' : ''}`;
  const form = document.querySelector('#config');
  form.elements.description.maxLength = 2000;
  form.elements.transport.value = value.transport;
  const readDeployment = bindDeployment(form, value);
  const toggle = () => {
    for (const transport of ['script', 'stdio', 'http']) { document.querySelector(`#${transport}`).hidden = form.elements.transport.value !== transport; }
  };
  form.elements.transport.onchange = toggle;
  toggle();
  form.onsubmit = event => event.preventDefault();
  const read = () => {
    const data = Object.fromEntries(new FormData(form));
    for (const key of data.transport === 'http' ? ['headers'] : data.transport === 'stdio' ? ['args', 'env'] : []) { data[key] = JSON.parse(data[key]); }
    if (data.transport === 'script') { delete data.source; Object.assign(data, readDeployment()); }
    const keys = data.transport === 'script' ? ['language', 'entry', 'interpreter', 'fields', 'env', 'files', 'source', 'deployment']
      : data.transport === 'stdio' ? ['command', 'args', 'cwd', 'env'] : ['url', 'headers', 'apiKey'];
    const input = Object.fromEntries(Object.entries(data).filter(([key]) => ['id', 'name', 'description', 'transport', ...keys].includes(key)));
    input.id ||= crypto.randomUUID();
    return input;
  };
  document.querySelector('#save').onclick = () => action(async () => {
    await endDebug();
    current = await invoke('mcp.save', read());
    await refresh(); await render();
  });
  for (const method of ['start', 'stop', 'remove']) {
    document.querySelector(`#${method}`).onclick = async () => {
      const id = current;
      if (method === 'remove' && !await confirmDelete(value.name, '将停止服务并删除连接配置和凭据；本机服务代码保留。')) { return; }
      await action(async () => {
        await endDebug();
        await invoke(`mcp.${method}`, id);
        if (method === 'remove') { closeDetails(); }
        await refresh();
        if (method !== 'remove') { await render(); }
      });
    };
  }
  document.querySelector('#debug').onclick = () => action(async () => {
    await endDebug();
    const session = await invoke('mcp.debug.start', read(), document.querySelector('#debug-prompt').value);
    debugId = session.id;
    document.querySelector('#debug-panel').hidden = false;
    await updateDebug(session.id);
  });
  document.querySelector('#end-debug').onclick = () => action(async () => {
    const id = debugId;
    await endDebug();
    if (id) { await updateDebug(id, true); }
  });
  const logs = document.querySelector('#logs');
  if (logs) {
    const result = document.querySelector('#result');
    const panel = document.querySelector('#service-logs');
    let readSequence = 0;
    const loadLogs = async () => {
      const request = ++readSequence;
      const text = await invoke('mcp.logs', selected);
      // Ignore requests completed after switching services or clearing the panel.
      if (!result.isConnected || request !== readSequence) { return; }
      result.textContent = text || '暂无日志';
      result.scrollTop = result.scrollHeight;
    };
    logs.onclick = () => action(loadLogs);
    document.querySelector('#clear-logs').onclick = () => action(async () => {
      ++readSequence;
      await invoke('mcp.clearLogs', selected);
      await loadLogs();
    });
    // Initial rendering already loads logs; only user reopening should start another action.
    panel.querySelector('summary').onclick = () => { if (!panel.open) { action(loadLogs); } };
    await loadLogs();
  }
}

async function updateDebug(id, final = false) {
  if (!final && !lifecycle.visible()) { return; }
  const refresh = ++debugRefresh;
  clearTimeout(poll);
  const state = await invoke('mcp.debug.read', id);
  // A newer refresh owns the timer, including a hide/show while this request was pending.
  if (refresh !== debugRefresh) { return; }
  // A completed poll must not overwrite another service's form after navigation.
  if (debugId !== id && !final) { return; }
  document.querySelector('#debug-state').textContent = `${state.stage}${state.error ? `：${state.error}` : ''}`;
  const calls = state.evidence.calls.map(call => `${call.name} · ${call.state}\n${JSON.stringify(call.result || call.error || '', null, 2)}`).join('\n\n');
  document.querySelector('#debug-result').textContent = `发现 ${state.evidence.discovered} 个工具；实际调用 ${state.evidence.calls.length} 次\n\n${calls}\n\n${state.output || ''}`;
  renderQuestions(id, state.requests || []);
  if (lifecycle.visible() && !state.cleaned && state.state !== 'cleanup-failed' && debugId === id) {
    poll = setTimeout(() => updateDebug(id).catch(error => { document.querySelector('#status').textContent = error.message; }), 600);
  }
}

function renderQuestions(id, requests) {
  const container = document.querySelector('#debug-questions');
  if (container.dataset.requests === JSON.stringify(requests)) { return; }
  container.dataset.requests = JSON.stringify(requests);
  container.replaceChildren();
  for (const request of requests) {
    const block = document.createElement('div');
    const questions = request.method === 'item/tool/requestUserInput' ? request.params.questions || [] : [];
    block.innerHTML = questions.length ? questions.map(question => `<label>${escape(question.question || question.header || question.id)}<input data-question="${escape(question.id)}"></label>`).join('')
      : '<p>AI 请求执行额外操作。调试保持只读，可拒绝该操作或结束调试。</p>';
    const button = document.createElement('button');
    button.className = 'icon-button';
    button.title = questions.length ? '提交回答' : '拒绝额外操作';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${questions.length
      ? 'm3 3 18 9-18 9 4-9z M7 12h14' : 'M6 6l12 12 M6 18L18 6'}"/></svg>`;
    button.onclick = () => action(async () => {
      const answers = Object.fromEntries([...block.querySelectorAll('[data-question]')].map(input => [input.dataset.question, input.value]));
      await invoke('mcp.debug.respond', id, { requestId: request.id, ...(questions.length ? { answers } : { decision: 'decline' }) });
    });
    block.append(button);
    container.append(block);
  }
}
document.querySelector('#import-archive').onclick = () => {
  const input = document.querySelector('#archive-file');
  input.value = '';
  input.click();
};
document.querySelector('#archive-file').onchange = event => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  action(async () => {
    // Validate first so cancelling or rejecting an archive does not replace the current editor.
    const imported = await readServiceArchive(file);
    await endDebug();
    current = undefined;
    await refresh();
    await render(imported);
    document.querySelector('[name="name"]').focus();
  });
};
document.querySelector('#back').onclick = () => action(async () => {
  await endDebug();
  showDetails(false);
  await refresh();
});
await action(refresh);

pollVisible(lifecycle, refreshServiceStatus, 1000, { onError: error => {
  const statuses = [...document.querySelectorAll('[data-service-status]')];
  console.error('[mcp:list-status-failed]', {
    pluginId: 'mcp-services', serviceIds: statuses.map(status => status.dataset.serviceStatus)
  }, error);
  statuses.forEach(status => { status.textContent = '连接状态刷新失败，正在重试'; });
} });
