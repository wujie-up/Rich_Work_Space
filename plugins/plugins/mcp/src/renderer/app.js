import './style.css';
import { invoke, escape, action } from './api.js';
let current;
let services = [];
const app = document.querySelector('#app');
app.innerHTML = `<header><h1>MCP 服务</h1><button id="refresh">刷新</button></header>
<p>填写远程 MCP 服务地址和密钥，启用后即可发现和调用工具。也支持本地 stdio 服务。</p>
<div class="layout"><nav id="services"></nav><section id="details"></section></div>
<section id="ai-settings"><h2>AI 接入</h2>
<p>本插件中已启用的服务自动供 Codex 使用，无需再次勾选。新建、恢复或分叉会话时生效；运行中的会话不会热更新，自定义 CLI 暂未适配。</p>
<div id="choices"></div><button type="button" id="save-ai">保存外部服务选择</button>
<details><summary>从旧 Adapter 导入选择</summary>
<p>先在软件配置中保留数据卸载旧 Adapter，再选择其 config.json。导入会替换当前选择，原文件会保留。</p>
<label>旧 Adapter 选择文件<input id="import-ai" type="file" accept=".json,application/json"></label></details>
</section><div id="status" role="status"></div>`;
const field = (name, label, value = '', textarea = false) => `<label>${label}<${textarea ? 'textarea' : 'input'} name="${name}" ${textarea ? '' : `value="${escape(value)}"`}>${textarea ? escape(value) + '</textarea>' : ''}</label>`;
async function refresh() {
  services = await invoke('mcp.list');
  document.querySelector('#services').innerHTML = services.map(value => `<button data-id="${escape(value.id)}" class="${current === value.id ? 'selected' : ''}">${escape(value.name)}<br><small>${escape(value.state)} · ${value.clients} 个连接</small></button>`).join('') + '<button id="new">＋ 添加服务</button>';
  document.querySelectorAll('[data-id]').forEach(button => { button.onclick = () => { current = button.dataset.id; render(); }; });
  document.querySelector('#new').onclick = () => { current = undefined; render(); };
  await refreshAi();
}

// Only IDs are imported; the backend resolves current connection details for each AI launch.
async function refreshAi() {
  const { candidates, selected } = await invoke('mcp.ai.list');
  const rows = [...candidates, ...selected.filter(value => !candidates.some(item =>
    item.pluginId === value.pluginId && item.serviceId === value.serviceId))
    .map(value => ({ ...value, name: value.serviceId, state: 'unavailable' }))];
  document.querySelector('#save-ai').hidden = !rows.some(value => value.pluginId !== 'mcp-services');
  document.querySelector('#choices').innerHTML = rows.length ? rows.map(value => `<label class="selection"><input type="checkbox"
    data-plugin="${escape(value.pluginId)}" data-service="${escape(value.serviceId || '')}" ${!value.serviceId || value.pluginId === 'mcp-services' ? 'disabled' : ''}
    ${(value.pluginId === 'mcp-services' ? value.state === 'running' : selected.some(item => item.pluginId === value.pluginId && item.serviceId === value.serviceId)) ? 'checked' : ''}>
    <span>${escape(value.name)}<br><small>${escape(value.pluginId)} / ${escape(value.serviceId)}</small></span>
    <small>${escape(value.state)}</small></label>`).join('') : '<p>添加并启用 MCP 服务后，AI 将自动发现工具。</p>';
}
function render() {
  const value = services.find(value => value.id === current) || { transport: 'http', args: [], env: {}, headers: {} };
  const bearer = Object.entries(value.headers || {}).find(([name, secret]) => name.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(secret));
  const headers = Object.fromEntries(Object.entries(value.headers || {}).filter(([name]) => name !== bearer?.[0]));
  document.querySelector('#details').innerHTML = `<form id="config"><div class="row">${field('id', '服务 ID', value.id)}${field('name', '显示名称', value.name)}</div>
<label>连接方式<select name="transport"><option value="stdio">本地 stdio</option><option value="http">远程 Streamable HTTP</option></select></label>
<div id="stdio">${field('command', '命令（可执行文件）', value.command)}${field('args', '参数 · JSON 数组', JSON.stringify(value.args || []), true)}${field('cwd', '工作目录（绝对路径，可留空）', value.cwd)}${field('env', '环境变量 · JSON 对象（敏感配置仅存本机）', JSON.stringify(value.env || {}), true)}</div>
<div id="http">${field('url', 'MCP 服务地址', value.url)}<label>密钥（Bearer Token，可留空）<input type="password" name="apiKey" autocomplete="off" value="${escape(bearer?.[1].replace(/^Bearer\s+/i, '') || '')}"></label>
<small>填写 MCP 服务的密钥。配置仅保存在本机，发送到你填写的服务地址。</small>
<details><summary>高级请求头（自定义认证）</summary>${field('headers', '请求头 · JSON 对象', JSON.stringify(headers), true)}</details></div>
<div class="row"><button type="button" id="save">保存配置</button><button type="button" id="save-start">保存并启用</button>${current ? '<button type="button" id="start">启用服务</button><button type="button" id="stop">停用服务</button><button type="button" id="remove">删除服务</button>' : ''}</div></form>
${current ? '<hr><div class="row"><button id="tools">发现工具</button><button id="logs">查看日志</button></div><label>工具<select id="tool"><option value="">请先发现工具</option></select></label><label>调用参数 · JSON 对象<textarea id="arguments">{}</textarea></label><button id="call">试调用</button><pre id="result">选择操作后在这里显示结果</pre>' : ''}`;
  const form = document.querySelector('#config');
  form.elements.id.readOnly = Boolean(current);
  form.elements.id.closest('label').hidden = !current;
  form.elements.transport.value = value.transport;
  const toggle = () => {
    document.querySelector('#stdio').hidden = form.elements.transport.value !== 'stdio';
    document.querySelector('#http').hidden = form.elements.transport.value !== 'http';
  };
  form.elements.transport.onchange = toggle;
  toggle();
  // Plugin frames forbid native form submission; persist through the host bridge.
  form.onsubmit = event => event.preventDefault();
  for (const id of ['save', 'save-start']) {
    document.querySelector(`#${id}`).onclick = () => action(async () => {
      const data = Object.fromEntries(new FormData(form));
      for (const key of data.transport === 'http' ? ['headers'] : ['args', 'env']) { data[key] = JSON.parse(data[key]); }
      // A new display name is enough; existing IDs remain stable for data and launch configuration.
      data.id ||= crypto.randomUUID();
      current = await invoke('mcp.save', data);
      try {
        if (id === 'save-start') { await invoke('mcp.start', current); }
      } finally {
        // Failed authentication still leaves a saved service that the user must be able to correct.
        await refresh(); render();
      }
    });
  }
  for (const method of ['start', 'stop', 'remove']) {
    const button = document.querySelector(`#${method}`);
    if (button) {
      button.onclick = () => action(async () => {
        await invoke(`mcp.${method}`, current);
        if (method === 'remove') { current = undefined; }
        await refresh(); render();
      });
    }
  }
  if (!current) { return; }
  const result = value => { document.querySelector('#result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  document.querySelector('#logs').onclick = () => action(async () => result(await invoke('mcp.logs', current)));
  document.querySelector('#tools').onclick = () => action(async () => {
    const tools = await invoke('mcp.tools', current);
    document.querySelector('#tool').innerHTML = tools.tools.map(tool => `<option value="${escape(tool.name)}">${escape(tool.name)}</option>`).join('');
    result(tools);
  });
  document.querySelector('#call').onclick = () => action(async () => result(await invoke('mcp.call', current,
    document.querySelector('#tool').value, JSON.parse(document.querySelector('#arguments').value))));
}
document.querySelector('#refresh').onclick = () => action(async () => { await refresh(); render(); });
document.querySelector('#save-ai').onclick = () => action(async () => {
  const selection = [...document.querySelectorAll('#choices input:checked:not(:disabled)')]
    .map(input => ({ pluginId: input.dataset.plugin, serviceId: input.dataset.service }));
  await invoke('mcp.ai.save', selection);
});
document.querySelector('#import-ai').onchange = event => action(async () => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }
  await invoke('mcp.ai.save', JSON.parse(await file.text()));
  await refreshAi();
  event.target.value = '';
});
await action(async () => { await refresh(); current = services[0]?.id; render(); });
