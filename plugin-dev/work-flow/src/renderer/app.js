import './style.css';
import { escape, invoke, preferences, subscribe } from './api.js';
import { createCanvas } from './canvas.js';
import { createMessagePanel } from './message-panel.js';
import { createMenuPanel } from './menu-panel.js';
import { KIND_TAGS } from '../shared/node-categories.js';
import { agentRequests } from './agent-requests.js';

const state = { types: [], workflows: [], credentials: [], connections: [], providerInfo: { contract: '', providers: [] }, currentId: null,
  selectedNodeId: null, selectedEdge: null, run: null, history: [], dirty: false, status: '', statusError: false,
  focused: null, credentialDraft: null, triggerOptions: { modes: [], units: [], contract: '' }, triggers: [],
  paletteKind: 'input', paletteType: '' };

const MODE_LABELS = { manual: '仅手动（可被其他插件触发）', once: '固定时间', interval: '固定周期', message: '消息监听' };
const UNIT_LABELS = { second: '秒', minute: '分', hour: '小时', day: '天', month: '月', year: '年' };

let watchToken = 0;
const app = document.querySelector('#app');
app.innerHTML = `<header class="topbar">
<input id="workflow-name" placeholder="工作流名称" style="max-width:220px">
<button type="button" id="save">保存</button><button type="button" id="run" class="primary">运行</button>
<button type="button" id="cancel-run">停止</button><span class="spacer"></span>
<span id="status"></span></header>
<div class="layout"><aside id="list"></aside>
<main class="canvas-area"><div class="toolbar" id="palette"></div>
<div id="menu-panel" hidden></div><small id="stage-hint"></small><div id="stage-wrap"><div id="stage"></div></div></main>
<aside class="inspector"><div id="notice"></div><div id="properties"></div>
<details><summary>运行方式</summary><div id="triggers"></div></details>
<details open><summary>运行结果</summary><div id="results"></div></details>
<details id="message-connections"><summary>消息连接</summary><div id="message-panel"></div></details>
<details><summary>邮件账号</summary><div id="credentials"></div></details></aside></div>`;

const menuPanel = createMenuPanel(document.querySelector('#menu-panel'), onRunChanged, setStatus);
const messagePanel = createMessagePanel(document.querySelector('#message-panel'), { invoke, subscribe, setStatus, onRunChanged,
  onConnectionsChanged: connections => {
    if (JSON.stringify(connections) !== JSON.stringify(state.connections)) {
      state.connections = connections;
      renderProperties();
      renderTriggers();
    }
  } });
const canvas = createCanvas(document.querySelector('#stage'));
const current = () => state.workflows.find(item => item.id === state.currentId) || null;
const typeOf = typeId => state.types.find(item => item.type === typeId);
const nodeOf = nodeIdValue => current()?.nodes.find(node => node.id === nodeIdValue) || null;
const newNodeId = prefix => `${prefix}-${crypto.randomUUID().slice(0, 4)}`;

async function boot() {
  const theme = await preferences().catch(() => ({ theme: null }));
  if (theme?.theme) {
    document.documentElement.dataset.theme = theme.theme;
  }
  const [types, workflows, credentials, providerInfo, triggerOptions, triggers] = await Promise.all([invoke('nodes.types'),
    invoke('workflows.list'), invoke('credentials.list'), invoke('agents.providers'), invoke('triggers.options'),
    invoke('triggers.next')]);
  Object.assign(state, { types, workflows, credentials, providerInfo, triggerOptions, triggers });
  if (workflows.length) {
    state.currentId = workflows[0].id;
  } else {
    const draft = scenarioWorkflow();
    state.workflows.push(draft);
    state.currentId = draft.id;
    state.dirty = true;
  }
  subscribe('runs.changed')(onRunChanged);
  await messagePanel.load();
  wireTopbar();
  if (workflows.length) { await selectWorkflow(state.currentId); }
  render();
  setStatus(state.dirty ? '已创建新工作流，记得保存。' : '');
}

function wireTopbar() {
  document.querySelector('#save').onclick = () => act(() => saveWorkflow());
  document.querySelector('#run').onclick = () => act(runWorkflow);
  document.querySelector('#cancel-run').onclick = () => act(cancelRun);
  document.querySelector('#workflow-name').oninput = event => {
    const workflow = current();
    if (!workflow) {
      return;
    }
    workflow.name = event.target.value;
    state.dirty = true;
    renderList();
  };
}

async function loadHistory() {
  const workflow = current();
  state.history = workflow ? await invoke('runs.list', workflow.id) : [];
}

async function saveWorkflow() {
  const workflow = current();
  if (!workflow) {
    return;
  }
  const saved = await invoke('workflows.save', serialize(workflow));
  state.workflows = state.workflows.map(item => (item.id === saved.id ? saved : item));
  state.currentId = saved.id;
  state.dirty = false;
  state.triggers = await invoke('triggers.next');
  setStatus('已保存。');
  render();
}

async function runWorkflow() {
  const workflow = current();
  if (!workflow) {
    return;
  }
  if (workflow.nodes.some(node => node.type.startsWith('message.'))) {
    setStatus('消息工作流需要在运行方式中开启消息监听，并保存后等待消息。');
    return;
  }
  if (state.dirty) {
    await saveWorkflow();
  }
  state.run = await invoke('runs.start', workflow.id);
  state.selectedNodeId = null;
  await loadHistory();
  setStatus('运行中…');
  render();
  await resumeIfWaiting(state.run);
  watchRun(state.run.id);
}

// A service node pauses the run; the open view is the RPC caller that may place the cross-plugin call.
async function resumeIfWaiting(run) {
  if (!run || run.origin?.kind === 'message' || run.status !== 'waiting' || run.pending?.kind !== 'service' || state.resuming === run.id) {
    return;
  }
  state.resuming = run.id;
  try {
    const next = await invoke('runs.resume', run.id);
    if (next.id === state.run?.id && JSON.stringify(next) !== JSON.stringify(state.run)) {
      state.run = next;
      renderStatus();
      renderResults();
      renderCanvas();
    }
  } finally {
    state.resuming = null;
  }
}

// Events drive the panel, but a missed one must not leave the UI stuck on "running".
async function watchRun(runId) {
  const token = ++watchToken;
  while (token === watchToken) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const run = await invoke('runs.get', runId).catch(() => null);
    if (token !== watchToken) {
      return;
    }
    if (run && !['running', 'waiting'].includes(run.status)) {
      onRunChanged(run);
      return;
    }
    if (run?.status === 'waiting') {
      if (state.run?.status !== run.status || state.run?.pending?.nodeId !== run.pending?.nodeId) { onRunChanged(run); }
      await resumeIfWaiting(run);
    }
  }
}

async function cancelRun() {
  if (!state.run) {
    return;
  }
  await invoke('runs.cancel', state.run.id);
  setStatus('正在停止…');
}

function serialize(workflow) {
  return { id: workflow.id, name: workflow.name, edges: workflow.edges, trigger: workflow.trigger,
    nodes: workflow.nodes.map(node => ({ id: node.id, type: node.type, title: node.title, x: node.x, y: node.y, params: node.params })) };
}

function scenarioWorkflow() {
  const build = (type, title, x, params = {}) => ({ id: newNodeId(type.split('.')[1] || type), type, title, x, y: 40, params });
  const start = build('flow.start', '开始', 20);
  const mail = build('mail.fetch', '报错邮件抓取', 300);
  const extract = build('log.extract', '关键日志提取', 560, { input: `{{${mail.id}.emails}}` });
  const gate = build('flow.gate', '存在错误才继续', 820, { input: `{{${extract.id}.matches}}` });
  const agent = build('agent.review', 'Agent 排查', 1080, { input: `{{${extract.id}.report}}`,
    instructions: '你是线上问题排查助手，请根据以下日志定位根因并给出处置建议：' });
  const collect = build('result.collect', '结果汇总', 1340,
    { input: `关键日志：\n{{${extract.id}.report}}\n\nAgent 排查结论：\n{{${agent.id}.output}}` });
  const end = build('flow.end', '终止', 1600, { input: `{{${collect.id}.report}}` });
  const nodes = [start, mail, extract, gate, agent, collect, end];
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
  return { id: crypto.randomUUID(), name: '邮件报错排查', nodes, edges };
}

// The canvas rejects the same rules the storage enforces, so a wrong link never reaches a save.
function linkBlockers(workflow, from, to) {
  const source = typeOf(workflow.nodes.find(node => node.id === from)?.type);
  const target = typeOf(workflow.nodes.find(node => node.id === to)?.type);
  if (source?.role === 'end' || source?.io === 'sink') {
    return `${source?.label || from} 是输出/终止节点，不能再连到下游。`;
  }
  if (target?.role === 'start') {
    return `${target?.label || to} 是开始节点，不能有上游。`;
  }
  if (target?.io === 'source' && source?.role !== 'start') {
    return `${target?.label || to} 是输入节点，只能接在开始节点之后。`;
  }
  return '';
}

// Flows built before start and end nodes existed stay runnable; this only completes their shape.
function missingEnds(workflow) {
  const roles = workflow.nodes.map(node => typeOf(node.type)?.role);
  return { start: !roles.includes('start'), end: !roles.includes('end') };
}

function completeEnds() {
  const workflow = current();
  if (!workflow) {
    return;
  }
  const missing = missingEnds(workflow);
  if (missing.start) {
    const start = addTypedNode('flow.start');
    for (const node of workflow.nodes.filter(node => node.id !== start.id
      && !workflow.edges.some(edge => edge.to === node.id))) {
      workflow.edges.push({ from: start.id, to: node.id });
    }
  }
  if (missing.end) {
    const end = addTypedNode('flow.end');
    for (const node of workflow.nodes.filter(node => node.id !== end.id
      && !workflow.edges.some(edge => edge.from === node.id) && typeOf(node.type)?.io !== 'source')) {
      workflow.edges.push({ from: node.id, to: end.id });
    }
  }
  state.dirty = true;
  render();
  setStatus('已补齐开始/终止节点，记得保存。');
}

function addTypedNode(typeId) {
  const workflow = current();
  const node = { id: newNodeId(typeId.split('.')[1] || typeId), type: typeId, title: typeOf(typeId)?.label || typeId, params: {},
    x: 20, y: 20 + workflow.nodes.length * 90 };
  workflow.nodes.push(node);
  return node;
}

function addNode(typeId) {
  const workflow = current();
  if (!workflow) {
    return;
  }
  const index = workflow.nodes.length;
  const type = typeOf(typeId);
  const node = { id: newNodeId(typeId.split('.')[1] || typeId), type: typeId, title: type?.label || typeId, params: {},
    x: 40 + (index % 4) * 250, y: 40 + Math.floor(index / 4) * 180 };
  workflow.nodes.push(node);
  state.selectedNodeId = node.id;
  state.selectedEdge = null;
  state.dirty = true;
  render();
}

function removeNode(nodeIdValue) {
  const workflow = current();
  if (!workflow) {
    return;
  }
  workflow.nodes = workflow.nodes.filter(node => node.id !== nodeIdValue);
  workflow.edges = workflow.edges.filter(edge => edge.from !== nodeIdValue && edge.to !== nodeIdValue);
  state.selectedNodeId = null;
  state.dirty = true;
  render();
}

function linkNodes(from, to) {
  const workflow = current();
  if (!workflow || from === to || workflow.edges.some(edge => edge.from === from && edge.to === to)) {
    return setStatus('连线已存在或无效。', true);
  }
  const source = nodeOf(from);
  const backward = createsCycle(from, to);
  if (backward && source.type !== 'flow.loop') {
    return setStatus('返回连线必须来自条件循环节点的 continue 分支。', true);
  }
  const blocked = linkBlockers(workflow, from, to);
  if (blocked) {
    return setStatus(blocked, true);
  }
  const used = workflow.edges.filter(edge => edge.from === from).map(edge => edge.branch);
  const branch = source.type === 'flow.loop' ? (backward ? 'continue' : 'exit')
    : source.type === 'flow.route' ? (used.includes('true') ? 'false' : 'true') : '';
  workflow.edges.push({ from, to, ...(branch ? { branch } : {}) });
  state.selectedNodeId = null;
  state.selectedEdge = `${from}>${to}`;
  state.dirty = true;
  render();
}

function removeEdge(key) {
  const workflow = current();
  if (!workflow || !key) {
    return;
  }
  const [from, to] = key.split('>');
  workflow.edges = workflow.edges.filter(edge => !(edge.from === from && edge.to === to));
  state.selectedEdge = null;
  state.dirty = true;
  render();
}

function createsCycle(from, to) {
  const queue = [to];
  const seen = new Set();
  while (queue.length) {
    const nodeIdValue = queue.pop();
    if (nodeIdValue === from) {
      return true;
    }
    if (seen.has(nodeIdValue)) {
      continue;
    }
    seen.add(nodeIdValue);
    for (const edge of current().edges.filter(edge => edge.from === nodeIdValue
      && !(nodeOf(edge.from)?.type === 'flow.loop' && edge.branch === 'continue'))) {
      queue.push(edge.to);
    }
  }
  return false;
}

function render() {
  renderStatus();
  renderList();
  renderPalette();
  renderNotice();
  renderProperties();
  renderTriggers();
  renderResults();
  renderCredentials();
  messagePanel.render(current());
  renderCanvas();
}

function renderStatus() {
  const name = document.querySelector('#workflow-name');
  const workflow = current();
  name.value = workflow?.name || '';
  name.disabled = !workflow;
  document.querySelector('#save').disabled = !workflow;
  const busy = ['running', 'waiting'].includes(state.run?.status);
  document.querySelector('#run').disabled = !workflow || busy;
  document.querySelector('#cancel-run').disabled = !busy;
  document.querySelector('#status').textContent = state.status;
  document.querySelector('#status').className = state.statusError ? 'error-text' : '';
}

function renderList() {
  const container = document.querySelector('#list');
  container.innerHTML = `<div class="panel-title">工作流</div>
    ${state.workflows.map(item => `<button type="button" class="list-item ${item.id === state.currentId ? 'selected' : ''}"
      data-workflow="${escape(item.id)}">${escape(item.name)}</button>`).join('')}
    <button type="button" id="new-workflow"><svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14 M5 12h14"/></svg> 新建</button>
    ${current() ? '<button type="button" id="delete-workflow" style="margin-top:8px">删除当前工作流</button>' : ''}`;
  for (const button of container.querySelectorAll('[data-workflow]')) {
    button.onclick = () => selectWorkflow(button.dataset.workflow);
  }
  const menuButton = document.createElement('button');
  menuButton.id = 'new-menu-workflow';
  menuButton.textContent = '菜单初始化模板';
  menuButton.style.marginTop = '8px';
  container.append(menuButton);
  menuButton.onclick = () => {
    const nodes = ['flow.start', 'menu.load', 'menu.tree', 'menu.code', 'menu.sql', 'flow.end'].map((type, index) =>
      ({ id: newNodeId(type.split('.')[1]), type, title: typeOf(type)?.label || type, x: 30 + index * 250, y: 40, params: {} }));
    const draft = { id: crypto.randomUUID(), name: 'AI 菜单初始化', nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })), trigger: { mode: 'manual', enabled: false } };
    state.workflows.push(draft);
    state.dirty = true;
    selectWorkflow(draft.id);
  };
  container.querySelector('#new-workflow').onclick = () => {
    const draft = { id: crypto.randomUUID(), name: '新建工作流', nodes: [], edges: [] };

    state.workflows.push(draft);
    selectWorkflow(draft.id);
  };
  container.querySelector('#delete-workflow')?.addEventListener('click', () => act(async () => {
    const workflow = current();
    await invoke('workflows.remove', workflow.id);
    state.workflows = state.workflows.filter(item => item.id !== workflow.id);
    state.currentId = state.workflows[0]?.id || null;
    state.run = null;
    await loadHistory();
    setStatus('已删除工作流。');
    render();
  }));
}

function renderPalette() {
  const types = state.types.filter(type => type.kind === state.paletteKind && !type.manual);
  const selected = types.find(type => type.type === state.paletteType) || types[0];
  state.paletteType = selected?.type || '';
  const container = document.querySelector('#palette');
  container.innerHTML = `<label class="palette-field">功能分类<select id="node-category">${Object.entries(KIND_TAGS).map(([id, label]) =>
    `<option value="${id}" ${state.paletteKind === id ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select></label>
    <label class="palette-field">基础能力<select id="node-capability">${types.map(type =>
      `<option value="${escape(type.type)}" ${selected?.type === type.type ? 'selected' : ''}>${escape(type.label)}</option>`).join('')}</select></label>
    <button type="button" id="add-node" class="icon-button" aria-label="添加节点" title="添加节点并配置" ${selected ? '' : 'disabled'}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
    ${state.paletteKind === 'invoke' ? `<span class="spacer"></span><small>${escape(state.providerInfo.providers.length
      ? `AI Agent：${state.providerInfo.providers.map(item => item.pluginId).join('、')}` : '请启用 AI Agent 插件')}</small>
      <button type="button" id="refresh-agents" class="icon-button" aria-label="刷新 Agent 能力" title="刷新 Agent 能力">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg></button>` : ''}`;
  container.querySelector('#node-category').onchange = event => {
    state.paletteKind = event.target.value;
    state.paletteType = '';
    renderPalette();
    if (state.paletteKind === 'invoke') { act(refreshAgents); }
  };
  container.querySelector('#node-capability').onchange = event => { state.paletteType = event.target.value; };
  container.querySelector('#add-node').onclick = () => addNode(state.paletteType);
  container.querySelector('#refresh-agents')?.addEventListener('click', () => act(refreshAgents));
}

async function refreshAgents() {
  state.providerInfo = await invoke('agents.providers');
  renderPalette();
  renderNotice();
  renderProperties();
}

function renderNotice() {
  const workflow = current();
  const missing = state.providerInfo.providers.length === 0 && workflow?.nodes.some(node => node.type === 'agent.review');
  const shape = workflow ? missingEnds(workflow) : { start: false, end: false };
  const legacy = shape.start || shape.end;
  document.querySelector('#notice').innerHTML = `${missing
    ? '<div class="warning">请在工作台启用或升级 AI Agent 插件，再到“AI 能力”刷新列表。</div>' : ''}
    ${legacy ? `<div class="warning">该工作流${shape.start ? '缺少开始节点' : ''}${shape.start && shape.end ? '、' : ''}${shape.end ? '缺少终止节点' : ''}，
       仍可按旧规则运行（以无上游的节点为入口）。<button type="button" id="complete-ends">补齐开始/终止节点</button></div>` : ''}`;
  document.querySelector('#complete-ends')?.addEventListener('click', () => act(completeEnds));
}

function renderProperties() {
  const container = document.querySelector('#properties');
  const node = nodeOf(state.selectedNodeId);
  if (state.selectedEdge) {
    renderEdgeProperties(container);
    return;
  }
  if (!node) {
    container.innerHTML = `<p class="hint">点击画布上的节点即可编辑参数。<br>点击连线可选中并删除。</p>
      ${state.selectedEdge ? '<button type="button" id="delete-edge">删除所选连线</button>' : ''}`;
    document.querySelector('#delete-edge')?.addEventListener('click', () => removeEdge(state.selectedEdge));
    return;
  }
  const type = typeOf(node.type);
  const variables = availableVariables(node.id);
  container.innerHTML = `<div class="panel-title">${escape(type?.label || node.type)}</div>
    <p class="hint">${escape(type?.summary || '')}</p>
    <label>节点名称<input data-field="title" value="${escape(node.title)}"></label>
    ${(type?.params || []).map(spec => paramHtml(node, spec)).join('')}
    <div class="panel-title">可用变量</div>
    <div class="variables">${variables.length ? variables.map(name =>
      `<button type="button" data-var="{{${escape(name)}}}">{{${escape(name)}}}</button>`).join('') : '<small>上游节点运行后显示</small>'}</div>
    ${state.selectedEdge ? '<label></label><button type="button" id="delete-edge">删除所选连线</button>' : ''}
    <label></label><button type="button" id="delete-node">删除节点</button>`;
  container.querySelector('[data-field="title"]').oninput = event => {
    node.title = event.target.value;
    state.dirty = true;
    renderCanvas();
  };
  container.querySelector('#delete-node').onclick = () => removeNode(node.id);
  document.querySelector('#delete-edge')?.addEventListener('click', () => removeEdge(state.selectedEdge));
  for (const element of container.querySelectorAll('[data-param]')) {
    const name = element.dataset.param;
    const update = () => {
      node.params[name] = element.dataset.kind === 'number' ? Number(element.value) : element.value;
      state.dirty = true;
      if (name === 'connectionId') { renderTriggers(); }
    };
    element.oninput = update;
    element.onchange = update;
    element.onfocus = () => { state.focused = element; };
  }
  for (const button of container.querySelectorAll('[data-var]')) {
    button.onclick = () => insertVariable(button.dataset.var);
  }
}

// Branch names belong to connections, so one routing node can target user-defined Agent roles.
function renderEdgeProperties(container) {
  const edge = current()?.edges.find(item => `${item.from}>${item.to}` === state.selectedEdge);
  if (!edge) { return; }
  const source = nodeOf(edge.from);
  const branch = ['flow.route', 'flow.loop'].includes(source.type);
  container.innerHTML = `<div class="panel-title">连线：${escape(source.title)} → ${escape(nodeOf(edge.to).title)}</div>
    ${branch ? `<label>分支值<input id="edge-branch" value="${escape(edge.branch || '')}"></label>
      <p class="hint">${source.type === 'flow.loop' ? 'continue：返回循环体；exit：退出。' : '条件模式填写 true / false；Agent 路由填写固定输出的 route 值。'}</p>` : ''}
    <button type="button" id="delete-edge">删除所选连线</button>`;
  container.querySelector('#delete-edge').onclick = () => removeEdge(state.selectedEdge);
  const input = container.querySelector('#edge-branch');
  if (input) {
    input.oninput = () => {
      edge.branch = input.value.trim();
      state.dirty = true;
      renderCanvas();
    };
  }
}

function renderTriggers() {
  const container = document.querySelector('#triggers');
  const workflow = current();
  if (!workflow) {
    container.innerHTML = '<p class="hint">没有工作流。</p>';
    return;
  }
  const trigger = workflow.trigger || { mode: 'manual', at: '', every: 1, unit: 'minute', enabled: false };
  const entries = workflow.nodes.filter(node => node.type.startsWith('message.'));
  const canListen = entries.length === 1 && state.connections.some(connection =>
    connection.id === entries[0].params.connectionId && entries[0].type === `message.${connection.channel}`)
    && !workflow.nodes.some(node => node.type === 'flow.start');
  const planned = state.triggers.find(item => item.workflowId === workflow.id);
  const nextAt = planned?.nextAt ? new Date(planned.nextAt).toLocaleString('zh-CN') : '';
  const modes = state.triggerOptions.modes.length ? state.triggerOptions.modes : ['manual', 'once', 'interval'];
  const units = state.triggerOptions.units.length ? state.triggerOptions.units : ['minute'];
  container.innerHTML = `<label>运行方式<select id="trigger-mode">${modes.map(mode =>
    `<option value="${escape(mode)}" ${trigger.mode === mode ? 'selected' : ''}>${escape(MODE_LABELS[mode] || mode)}</option>`).join('')}</select></label>
    ${trigger.mode === 'once' ? `<label>触发时间<input id="trigger-at" type="datetime-local"
      value="${escape(String(trigger.at || '').replace(' ', 'T'))}"></label>` : ''}
    ${trigger.mode === 'interval' ? `<div class="row"><label>每<input id="trigger-every" type="number" min="1"
      value="${escape(String(trigger.every || 1))}"></label><label>单位<select id="trigger-unit">${units.map(unit =>
    `<option value="${escape(unit)}" ${trigger.unit === unit ? 'selected' : ''}>${escape(UNIT_LABELS[unit] || unit)}</option>`).join('')}</select></label></div>` : ''}
    ${trigger.mode === 'manual' ? '' : `<label class="row"><input id="trigger-enabled" type="checkbox"
      ${trigger.enabled ? 'checked' : ''} ${trigger.mode === 'message' && !canListen ? 'disabled' : ''}>启用${trigger.mode === 'message' ? '消息监听' : '自动触发'}</label>`}
    ${trigger.mode === 'message' ? `<p class="hint">${canListen ? '保存启用后等待消息；关闭最后一个窗口会停止监听，待执行消息保留。' : '请添加一个消息入口、选择连接，并移除普通开始节点。'}</p>` : `<small>下次运行：${nextAt || '不会自动触发'}</small>`}
    ${trigger.mode === 'once' && !nextAt ? '<p class="hint">设定的时间已过去，不会补跑；请改时间或改用固定周期。</p>' : ''}
    ${trigger.mode !== 'manual' && trigger.enabled ? '<p class="hint">桌面启动后，首次打开本插件才会开始监听或计时。</p>' : ''}
    ${state.triggerOptions.contract && trigger.mode !== 'message' ? `<small>其他插件可通过契约 ${escape(state.triggerOptions.contract)} 触发本工作流。</small>` : ''}`;
  container.querySelector('#trigger-mode').onchange = event => {
    workflow.trigger = { ...trigger, mode: event.target.value, at: event.target.value === 'once'
      ? String(trigger.at || '').replace(' ', 'T') : '', every: Number(trigger.every) || 1,
    unit: trigger.unit || 'minute', enabled: trigger.mode === event.target.value ? trigger.enabled : event.target.value !== 'message' };
    state.dirty = true;
    renderTriggers();
  };
  const at = container.querySelector('#trigger-at');
  if (at) {
    at.onchange = () => { workflow.trigger = { ...workflow.trigger, at: at.value }; state.dirty = true; renderTriggers(); };
  }
  const every = container.querySelector('#trigger-every');
  if (every) {
    every.onchange = () => { workflow.trigger = { ...workflow.trigger, every: Math.max(1, Number(every.value) || 1) }; state.dirty = true; renderTriggers(); };
  }
  const unit = container.querySelector('#trigger-unit');
  if (unit) {
    unit.onchange = () => { workflow.trigger = { ...workflow.trigger, unit: unit.value }; state.dirty = true; renderTriggers(); };
  }
  const enabled = container.querySelector('#trigger-enabled');
  if (enabled) {
    enabled.onchange = () => { workflow.trigger = { ...workflow.trigger, enabled: enabled.checked }; state.dirty = true; renderTriggers(); };
  }
}

function paramHtml(node, spec) {
  const raw = node.params[spec.name] ?? spec.default ?? '';
  const attr = `data-param="${escape(spec.name)}" data-kind="${escape(spec.kind)}"`;
  if (spec.kind === 'select') {
    const options = (spec.options || []).map(option => `<option value="${escape(option.value)}"
      ${String(raw) === option.value ? 'selected' : ''}>${escape(option.label)}</option>`).join('');
    return `<label>${escape(spec.label)}<select ${attr}>${options}</select></label>`;
  }
  if (spec.kind === 'connection') {
    const options = state.connections.filter(item => item.channel === spec.channel).map(item => `<option value="${escape(item.id)}"
      ${String(raw) === item.id ? 'selected' : ''}>${escape(item.name)}</option>`).join('');
    return `<label>${escape(spec.label)}<select ${attr}><option value="">请选择…</option>${options}</select>
      <small>在下方“消息连接”中配置渠道账号。</small></label>`;
  }
  if (spec.kind === 'credential') {
    const options = state.credentials.map(item => `<option value="${escape(item.id)}"
      ${String(raw) === item.id ? 'selected' : ''}>${escape(item.name)}（${escape(item.username)}）</option>`).join('');
    return `<label>${escape(spec.label)}<select ${attr}><option value="">请选择…</option>${options}</select>
      <small>没有账号？在下方“邮件账号”里添加。</small></label>`;
  }
  if (spec.kind === 'provider') {
    const options = state.providerInfo.providers.map(item => `<option value="${escape(item.pluginId)}"
      ${String(raw) === item.pluginId ? 'selected' : ''}>${escape(item.pluginId)}</option>`).join('');
    return `<label>${escape(spec.label)}<select ${attr}><option value="">自动（唯一提供方）</option>${options}</select>
      <small>由工作台协调 AI Agent 插件；目录留空时使用插件独立运行空间。</small></label>`;
  }
  if (spec.kind === 'textarea') {
    return `<label>${escape(spec.label)}<textarea ${attr} rows="${spec.rows || 3}"
      placeholder="${escape(spec.placeholder || '')}">${escape(raw)}</textarea></label>`;
  }
  if (spec.kind === 'number') {
    return `<label>${escape(spec.label)}<input type="number" ${attr} value="${escape(raw)}"></label>`;
  }
  return `<label>${escape(spec.label)}<input ${attr} value="${escape(raw)}" placeholder="${escape(spec.placeholder || '')}"></label>`;
}

function insertVariable(text) {
  const element = state.focused;
  const node = nodeOf(state.selectedNodeId);
  if (!element || !node) {
    return setStatus('先点击要插入的参数输入框。', true);
  }
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? element.value.length;
  element.value = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`;
  node.params[element.dataset.param] = element.value;
  element.focus();
  state.dirty = true;
}

function availableVariables(nodeIdValue) {
  const workflow = current();
  if (!workflow || !state.run) {
    return [];
  }
  const parent = id => workflow.edges.filter(edge => edge.to === id).map(edge => edge.from);
  const queue = parent(nodeIdValue);
  const seen = new Set(queue);
  while (queue.length) {
    const currentIdValue = queue.pop();
    for (const next of parent(currentIdValue)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const result = [];
  for (const id of seen) {
    const recorded = state.run.nodes[id];
    if (!recorded || recorded.status !== 'succeeded') {
      continue;
    }
    const output = recorded.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      for (const key of Object.keys(output)) {
        result.push(`${id}.${key}`);
      }
    } else {
      result.push(id);
    }
  }
  return result;
}

function renderResults() {
  const container = document.querySelector('#results');
  const menu = Boolean(current()?.nodes.some(node => node.type.startsWith('menu.')));
  menuPanel.show(state.run, menu);
  document.querySelector('#stage-wrap').hidden = menu;
  document.querySelector('#stage-hint').hidden = menu;
  document.querySelector('#palette').hidden = menu;
  const run = state.run;
  const nodes = current()?.nodes || [];
  const recorded = run?.nodes || {};
  const statusLabels = { running: '运行中', waiting: '等待确认或服务调用', succeeded: '已完成', failed: '失败', canceled: '已停止',
    skipped: '已跳过' };
  const timeline = nodes.map(node => {
    const entry = recorded[node.id];
    const detail = entry?.error ? `<pre class="output error-text">${escape(entry.error.message)}</pre>`
      : entry?.output !== undefined ? `<pre class="output">${escape(text(entry.output))}</pre>`
        : entry?.reason ? `<pre class="output">${escape(entry.reason)}</pre>` : '';
    return `<div class="result-item"><header><span>${escape(node.title)}</span>
      <span><span class="state-dot state-${escape(entry?.status || 'none')}"></span>${escape(statusLabels[entry?.status] || '未运行')}${entry?.iteration ? ` · 第 ${entry.iteration} 轮` : ''}</span></header>
      ${detail}</div>`;
  }).join('');
  const history = state.history.slice(-5).reverse().map(item => `<div class="result-item"><header><span>${escape(item.status)}</span>
    <span>${escape(new Date(item.startedAt).toLocaleString('zh-CN'))}</span></header>
    ${item.error ? `<pre class="output error-text">${escape(item.error.message)}</pre>` : ''}</div>`).join('');
  container.innerHTML = `${run ? `<div class="result-item"><header><span>${escape(statusLabels[run.status] || run.status)}</span>
    <span>${escape(new Date(run.startedAt).toLocaleString('zh-CN'))}</span></header>
    ${run.error ? `<pre class="output error-text">${escape(run.error.message)}</pre>` : ''}</div>` : '<p class="hint">还没有运行记录。</p>'}
    ${run?.pending?.kind === 'service' ? agentRequests(run.pending.task?.requests, run.pending.mode || 'plan') : ''}
    ${run?.pending?.kind === 'loop' ? `<div class="result-item"><p>循环已达到最大轮次（当前第 ${run.iterations?.[run.pending.nodeId] || 1} 轮）。</p>
      <button type="button" data-loop="continue">继续下一组循环</button> <button type="button" data-loop="exit">退出循环，进入后续分支</button></div>` : ''}
    ${run?.status === 'failed' && (typeOf(nodeOf(run.error?.nodeId)?.type)?.service
      || ['flow.route', 'flow.loop'].includes(nodeOf(run.error?.nodeId)?.type)) ? '<button type="button" id="retry-node">重试失败节点</button>' : ''}
    ${timeline}<div class="panel-title">最近运行</div>${history || '<small>暂无</small>'}`;
  for (const button of container.querySelectorAll('[data-loop]')) {
    button.onclick = () => act(async () => {
      state.run = await invoke('runs.loop', { runId: run.id, decision: button.dataset.loop });
      render();
      await resumeIfWaiting(state.run);
      watchRun(run.id);
    });
  }
  container.querySelector('#retry-node')?.addEventListener('click', () => act(async () => {
    state.run = await invoke('runs.retry', run.id);
    render();
    await resumeIfWaiting(state.run);
    watchRun(run.id);
  }));
  for (const button of container.querySelectorAll('[data-approval], [data-answer]')) {
    button.onclick = () => act(async () => {
      const index = Number(button.dataset.approval ?? button.dataset.answer);
      const request = run.pending.task.requests[index];
      await invoke('runs.respond', { runId: run.id, requestId: request.id,
        ...(button.dataset.answer !== undefined
          ? { answers: JSON.parse(container.querySelector(`#request-${button.dataset.kind}-${index}`).value) } : { decision: button.dataset.decision }) });
      await resumeIfWaiting(run);
    });
  }
}

function renderCredentials() {
  const container = document.querySelector('#credentials');
  const draft = state.credentialDraft || { id: '', name: '', host: '', port: 993, security: 'tls', username: '', password: '' };
  const field = (name, label, value, kind = 'text') => `<label>${escape(label)}<input type="${kind}" data-credential="${name}"
    value="${escape(value || '')}" ${kind === 'password' ? 'autocomplete="off" placeholder="留空表示保持不变"' : ''}></label>`;
  const security = ['tls', 'starttls', 'none'].map(value => `<option value="${value}"
    ${draft.security === value ? 'selected' : ''}>${value}</option>`).join('');
  container.innerHTML = `${state.credentials.map(item => `<div class="result-item"><header><span>${escape(item.name)}</span>
    <span>${escape(item.username)}</span></header><small>${escape(item.host)}:${escape(item.port)} · ${escape(item.security)}</small>
    <div class="row" style="margin-top:6px"><button type="button" data-edit-credential="${escape(item.id)}">编辑</button>
    <button type="button" data-remove-credential="${escape(item.id)}">删除</button></div></div>`).join('') || '<p class="hint">还没有邮件账号。</p>'}
    <hr><div class="panel-title">${draft.id ? '编辑账号' : '新增账号'}</div>
    ${field('name', '名称', draft.name)}${field('host', '服务器地址', draft.host)}
    <div class="row">${field('port', '端口', draft.port, 'number')}
    <label>连接方式<select data-credential="security">${security}</select></label></div>
    ${field('username', '登录账号', draft.username)}${field('password', '密码 / 授权码', '', 'password')}
    <button type="button" id="save-credential">保存账号</button>`;
  for (const button of container.querySelectorAll('[data-edit-credential]')) {
    button.onclick = async () => {
      const detail = await invoke('credentials.list');
      state.credentialDraft = { ...detail.find(item => item.id === button.dataset.editCredential), password: '' };
      renderCredentials();
    };
  }
  for (const button of container.querySelectorAll('[data-remove-credential]')) {
    button.onclick = () => act(async () => {
      await invoke('credentials.remove', button.dataset.removeCredential);
      state.credentials = await invoke('credentials.list');
      state.credentialDraft = null;
      renderCredentials();
      renderProperties();
    });
  }
  container.querySelector('#save-credential').onclick = () => act(async () => {
    const input = Object.fromEntries([...container.querySelectorAll('[data-credential]')].map(element =>
      [element.dataset.credential, element.value]));
    await invoke('credentials.save', { ...input, id: draft.id, port: Number(input.port) });
    state.credentials = await invoke('credentials.list');
    state.credentialDraft = null;
    setStatus('邮件账号已保存。');
    renderCredentials();
    renderProperties();
  });
}

function renderCanvas() {
  const workflow = current();
  canvas.mount({ workflow, selectedNodeId: state.selectedNodeId, selectedEdge: state.selectedEdge,
    statuses: state.run?.nodes || {}, handlers: { onSelectNode, onSelectEdge, onMoveNode, onLink: linkNodes, onRemoveNode: removeNode,
      typeOf } });
}

async function selectWorkflow(workflowId) {
  state.currentId = workflowId;
  state.selectedNodeId = null;
  state.selectedEdge = null;
  const stored = await invoke('runs.list', workflowId);
  state.history = stored;
  state.run = stored.length ? await invoke('runs.get', stored.at(-1).id).catch(() => {
    const previous = structuredClone(stored.at(-1));
    if ((previous.origin?.kind === 'message' || current()?.nodes.some(node => node.type.startsWith('menu.'))) && ['running', 'waiting'].includes(previous.status)) {
      previous.status = 'interrupted';
      previous.pending = null;
      previous.error = { message: '插件已重启，本次运行不自动恢复，请核对外部结果后重新运行。' };
    }
    return previous;
  }) : null;
  if (state.run && ['running', 'waiting'].includes(state.run.status)) { watchRun(state.run.id); }
  render();
}

function onSelectNode(nodeIdValue) {
  state.selectedNodeId = nodeIdValue;
  state.selectedEdge = null;
  renderProperties();
  renderCanvas();
}

function onSelectEdge(key) {
  state.selectedEdge = key;
  state.selectedNodeId = null;
  renderProperties();
  renderCanvas();
}

function onMoveNode() {
  state.dirty = true;
  renderStatus();
}

function onRunChanged(run) {
  if (!current() || run.workflowId !== current().id) {
    return;
  }
  state.run = run;
  if (run.status === 'waiting') {
    setStatus(run.pending?.kind === 'loop' ? '循环已达到最大轮次，等待选择继续或退出…'
      : run.pending?.kind === 'manual' ? '等待人工确认…'
      : run.pending?.task?.requests?.length ? '等待 Agent 问题确认…' : 'Agent 任务处理中…');
    resumeIfWaiting(run);
  }
  if (!['running', 'waiting'].includes(run.status)) {
    setStatus(run.status === 'succeeded' ? '运行完成。' : run.status === 'canceled' ? '运行已停止。' : '运行失败，查看右侧详情。',
      run.status === 'failed');
    loadHistory().then(() => renderResults());
  }
  renderStatus();
  renderCanvas();
  renderResults();
}

function setStatus(message, isError = false) {
  state.status = message;
  state.statusError = isError;
  renderStatus();
}

function text(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

async function act(work) {
  try {
    await work();
  } catch (error) {
    setStatus(error.message, true);
  }
}

await boot();
