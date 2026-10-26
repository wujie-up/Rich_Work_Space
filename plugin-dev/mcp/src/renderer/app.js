import './style.css';
import { invoke, escape, action } from './api.js';
import { deploymentForm, bindDeployment } from './deployment-form.js';
let current;
let services = [];
let debugId;
let poll;
let renderSequence = 0;
const app = document.querySelector('#app');
app.innerHTML = `<header class="workspace-tools"><button id="refresh">刷新</button></header>
<div class="layout"><nav id="services" aria-label="MCP 服务列表"></nav><section id="details"></section></div>
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

async function refresh() {
  services = await invoke('mcp.list');
  document.querySelector('#services').innerHTML = services.map(value => `<button data-id="${escape(value.id)}" class="${current === value.id ? 'selected' : ''}">${escape(value.name)}<br><small>${escape(value.state)} · ${value.clients} 个连接</small></button>`).join('') + '<button id="new"><svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14 M5 12h14"/></svg> 添加服务</button>';
  document.querySelectorAll('[data-id]').forEach(button => {
    button.onclick = () => action(async () => { await endDebug(); current = button.dataset.id; await refresh(); await render(); });
  });
  document.querySelector('#new').onclick = () => action(async () => { await endDebug(); current = undefined; await refresh(); await render(); });
}

async function render() {
  const sequence = ++renderSequence;
  const selected = current;
  const value = { ...(services.find(value => value.id === current) || { transport: 'script', args: [], env: {}, headers: {} }) };
  if (value.transport === 'script' && value.deployment) { value.source = await invoke('mcp.source', selected); }
  if (sequence !== renderSequence || selected !== current) { return; }
  const bearer = Object.entries(value.headers || {}).find(([name, secret]) => name.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(secret));
  const headers = Object.fromEntries(Object.entries(value.headers || {}).filter(([name]) => name !== bearer?.[0]));
  document.querySelector('#details').innerHTML = `<form id="config"><input type="hidden" name="id" value="${escape(value.id)}">${field('name', '显示名称', value.name)}
<label>服务类型<select name="transport"><option value="script">Python / JavaScript</option><option value="stdio">本地 stdio</option><option value="http">远程 Streamable HTTP</option></select></label>
${deploymentForm(value)}
<div id="stdio">${field('command', '命令（可执行文件）', value.command)}${field('args', '参数 · JSON 数组', JSON.stringify(value.args || []), true)}${field('cwd', '工作目录（绝对路径，可留空）', value.cwd)}${field('env', '环境变量 · JSON 对象（敏感配置仅存本机）', JSON.stringify(value.env || {}), true)}</div>
<div id="http">${field('url', 'MCP 服务地址', value.url)}<label>密钥（Bearer Token，可留空）<input type="password" name="apiKey" autocomplete="off" value="${escape(bearer?.[1].replace(/^Bearer\s+/i, '') || '')}"></label>
<small>配置仅保存在本机，发送到填写的服务地址。</small>
<details><summary>高级请求头</summary>${field('headers', '请求头 · JSON 对象', JSON.stringify(headers), true)}</details></div>
<details><summary>调试目标（可选）</summary><label>用自然语言描述希望 AI 验证的功能<textarea id="debug-prompt" placeholder="例如：查询最近五分钟的测试日志并解释结果"></textarea></label></details>
<div class="row actions"><button type="button" id="save">保存</button><button type="button" id="debug">调试</button><button type="button" id="start" ${!current || value.state === 'running' ? 'disabled' : ''}>启用</button><button type="button" id="stop" ${value.state !== 'running' ? 'disabled' : ''}>停用</button><button type="button" id="remove" ${!current ? 'disabled' : ''}>删除</button></div>
<small>保存有效修改后服务会停用；点击启用后使用新配置。调试使用当前代码和配置，结束后清理临时服务。</small></form>
<section id="debug-panel" hidden aria-label="AI 调试结果"><div class="row"><strong>AI 调试</strong><button id="end-debug">结束调试</button></div><p id="debug-state" role="status"></p><div id="debug-questions"></div><pre id="debug-result"></pre></section>
${current ? '<details><summary>服务日志</summary><button id="logs">刷新日志</button><pre id="result">点击刷新日志查看</pre></details>' : ''}`;
  const form = document.querySelector('#config');
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
    const input = Object.fromEntries(Object.entries(data).filter(([key]) => ['id', 'name', 'transport', ...keys].includes(key)));
    input.id ||= crypto.randomUUID();
    return input;
  };
  document.querySelector('#save').onclick = () => action(async () => {
    await endDebug();
    current = await invoke('mcp.save', read());
    await refresh(); await render();
  });
  for (const method of ['start', 'stop', 'remove']) {
    document.querySelector(`#${method}`).onclick = () => action(async () => {
      await endDebug();
      await invoke(`mcp.${method}`, current);
      if (method === 'remove') { current = undefined; }
      await refresh(); await render();
    });
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
  if (logs) { logs.onclick = () => action(async () => { document.querySelector('#result').textContent = await invoke('mcp.logs', current); }); }
}

async function updateDebug(id, final = false) {
  const state = await invoke('mcp.debug.read', id);
  // A completed poll must not overwrite another service's form after navigation.
  if (debugId !== id && !final) { return; }
  document.querySelector('#debug-state').textContent = `${state.stage}${state.error ? `：${state.error}` : ''}`;
  const calls = state.evidence.calls.map(call => `${call.name} · ${call.state}\n${JSON.stringify(call.result || call.error || '', null, 2)}`).join('\n\n');
  document.querySelector('#debug-result').textContent = `发现 ${state.evidence.discovered} 个工具；实际调用 ${state.evidence.calls.length} 次\n\n${calls}\n\n${state.output || ''}`;
  renderQuestions(id, state.requests || []);
  if (!state.cleaned && state.state !== 'cleanup-failed' && debugId === id) {
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
    button.textContent = questions.length ? '提交回答' : '拒绝额外操作';
    button.onclick = () => action(async () => {
      const answers = Object.fromEntries([...block.querySelectorAll('[data-question]')].map(input => [input.dataset.question, input.value]));
      await invoke('mcp.debug.respond', id, { requestId: request.id, ...(questions.length ? { answers } : { decision: 'decline' }) });
    });
    block.append(button);
    container.append(block);
  }
}
document.querySelector('#refresh').onclick = () => action(async () => { await endDebug(); await refresh(); await render(); });
await action(async () => { await refresh(); current = services[0]?.id; await render(); });
