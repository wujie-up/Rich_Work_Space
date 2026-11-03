import { visibleNodeParams } from '../shared/node-params.js';
import { confirmConfigurationDelete } from './configuration-delete.js';
import { showPopup } from '../../../../desk/src/resource/popup.js';
import '../../../../desk/src/resource/controls.css';
import './style.css';
import { escape, invoke, preferences, subscribe, chooseFile, chooseDirectory } from './api.js';
import { createWorkflowTransfer } from './workflow-transfer.js';
import { workflowActivityInfo } from './workflow-activity.js';
import { createWorkflowGroups } from './workflow-groups.js';
import { createCanvas } from './canvas.js';
import { createMessagePanel } from './message-panel.js';
import { createFeishuRobotPanel } from './feishu-robot-panel.js';
import { createMenuPanel } from './menu-panel.js';
import { createNodePicker } from './node-picker.js';
import { createAgentHistory } from './agent-history.js';
import { agentRequests } from './agent-requests.js';
import { createUserInputDialog } from './user-input.js';

const state = { types: [], workflows: [], credentials: [], connections: [], providerInfo: { contract: '', providers: [] }, currentId: null,
  selectedNodeId: null, selectedEdge: null, run: null, history: [], dirty: false, status: '', statusError: false,
  focused: null, credentialDraft: null, triggerOptions: { modes: [], units: [], contract: '' }, triggers: [] };

const MODE_LABELS = { manual: '仅手动（可被其他插件触发）', once: '固定时间', daily: '每日固定时间（北京时间）', interval: '固定周期', message: '消息监听' };
const UNIT_LABELS = { second: '秒', minute: '分', hour: '小时', day: '天', month: '月', year: '年' };

let watchToken = 0;
const activeRuns = new Map();
const app = document.querySelector('#app');
app.innerHTML = `<header class="topbar">
<input id="workflow-name" placeholder="工作流名称" aria-label="工作流名称">
<button type="button" id="workflow-group" class="icon-button" title="设置工作流分组" aria-label="设置工作流分组"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3Z M7 12h10 M7 16h6"/></svg></button>
<button type="button" id="save" class="icon-button" title="保存" aria-label="保存"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z M7 3v6h10V3 M7 21v-8h10v8"/></svg></button>
<button type="button" id="import-workflow" class="icon-button" title="导入工作流" aria-label="导入工作流"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8V3h8l5 5v13H8v-3 M16 3v5h5 M3 13h11 m-4-4 4 4-4 4"/></svg></button>
<button type="button" id="export-workflow" class="icon-button" title="导出工作流（含当前编辑的文本、路径和参数，请确认其中没有敏感信息）" aria-label="导出工作流"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9V8l-5-5H3v18h13v-4 M11 3v5h5 M10 13h11 m-4-4 4 4-4 4"/></svg></button>
<button type="button" id="run" class="icon-button primary" title="运行" aria-label="运行"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 12 8-12 8Z"/></svg></button>
<button type="button" id="trigger-now" class="icon-button" title="立即触发" aria-label="立即触发" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="12" r="8"/><path d="M10 7v5l3 2 M18 11l5 4-5 4Z"/></svg></button>
<button type="button" id="continue-run" class="icon-button" title="继续流程" aria-label="继续流程" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7Z M5 5v14"/></svg></button>
<button type="button" id="cancel-run" class="icon-button" title="停止" aria-label="停止"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"/></svg></button>
<span class="spacer"></span><span id="status-text" role="status"></span><button type="button" id="status" class="icon-button" title="查看 Agent 会话记录" aria-label="查看 Agent 会话记录"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 7 M4 4v6h6 M12 7v5l3 2"/></svg></button>
<button type="button" id="delete-workflow" class="icon-button" title="删除工作流" aria-label="删除工作流"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button></header>
<div class="layout"><aside class="workflow-sidebar" id="workflow-sidebar">
<div class="sidebar-heading"><strong>工作流</strong><button type="button" id="new-group" class="icon-button" title="新建分组" aria-label="新建分组"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3Z M12 10v7 M8.5 13.5h7"/></svg></button></div>
<div id="list"></div>
<button type="button" id="new-workflow" class="icon-button" title="新建工作流" aria-label="新建工作流"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14 M5 12h14"/></svg></button>
</aside><button type="button" id="toggle-list" title="收起工作流列表（拖动调整宽度）" aria-label="收起工作流列表" aria-controls="workflow-sidebar" aria-expanded="true"></button>
<main class="canvas-area">
<div id="menu-panel" hidden></div>
<div class="toolbar canvas-tools" id="canvas-tools"><div id="palette"></div>
<button type="button" id="auto-layout" title="按依赖整理节点和连线，之后可保存布局" aria-label="自动布局" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3h6v6H3z M15 15h6v6h-6z M3 15h6v6H3z M15 3h6v6h-6z M9 6h6 M6 9v6 M18 9v6"/></svg></button><span class="spacer"></span>
<button type="button" id="zoom-out" class="icon-button" title="缩小画布" aria-label="缩小画布"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button>
<button type="button" id="zoom-reset" title="恢复 100% 缩放" aria-label="恢复 100% 缩放" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7 M20 4v6h-6"/></svg></button>
<button type="button" id="zoom-in" class="icon-button" title="放大画布" aria-label="放大画布"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14 M12 5v14"/></svg></button>
<button type="button" id="zoom-fit" title="显示完整流程" aria-label="适合画布" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6"/></svg></button>
<button type="button" class="icon-button canvas-help" aria-label="画布操作说明" aria-describedby="stage-hint" title="画布操作说明"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3.5 M12 17v.1"/></svg></button>
<small id="stage-hint" role="tooltip"></small></div>
<div id="stage-wrap"><div id="stage-space"><div id="stage"></div></div></div></main>
<aside class="inspector"><div id="properties"></div><div id="workflow-properties"><div class="panel-title">流程执行情况</div><div id="notice"></div>
<details><summary>运行方式</summary><div id="triggers"></div></details>
<details open><summary>运行结果</summary><div id="results"></div></details>
</div><details id="message-connections" hidden><summary>消息连接</summary><div id="message-panel"></div></details>
<details id="mail-credentials" hidden><summary>邮件账号</summary><div id="credentials"></div></details>
<details id="feishu-robot-settings" hidden><summary>飞书机器人</summary><div id="feishu-robot-panel"></div></details></aside></div>`;

const menuPanel = createMenuPanel(document.querySelector('#menu-panel'), onRunChanged, setStatus);
const feishuRobotPanel = createFeishuRobotPanel(document.querySelector('#feishu-robot-panel'), { invoke, setStatus });
const agentHistory = createAgentHistory({ invoke });
const nodePicker = createNodePicker({ getTypes: () => state.types, onAdd: type => addNode(type) });
const userInput = createUserInputDialog({ invoke, onConfirmed: run => {
  onRunChanged(run);
  if (run.workflowId === state.currentId) { watchRun(run.id); }
} });
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
const workflowGroups = createWorkflowGroups({ invoke, setStatus, render, getWorkflows: () => state.workflows,
  current, onSelect: selectWorkflow, onCreate: createWorkflow,
  getActivity: id => workflowActivityInfo([...activeRuns.values()].find(run => run.workflowId === id)),
  getSchedule: id => state.triggers.find(row => row.workflowId === id),
  onReorder: order => {
    const saved = new Map(state.workflows.map(workflow => [workflow.id, workflow]));
    const ordered = order.map(id => saved.get(id)).filter(Boolean);
    const ids = new Set(order);
    state.workflows = state.workflows.map(workflow => ids.has(workflow.id) ? ordered.shift() : workflow);
  } });
const transfer = createWorkflowTransfer({ invoke, chooseFile, chooseDirectory, current, setStatus, onImported: async workflow => {
  state.workflows = [workflow, ...state.workflows.filter(item => item.id !== workflow.id)];
  await workflowGroups.load();
  // Other workflows may still contain unsaved edits; importing must not clear their pending save.
  await selectWorkflow(workflow.id);
} });
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
    const previous = sessionStorage.getItem('work-flow.current');
    state.currentId = workflows.find(workflow => workflow.id === previous)?.id || workflows[0].id;
  } else {
    const draft = scenarioWorkflow();
    state.workflows.push(draft);
    state.currentId = draft.id;
    state.dirty = true;
  }
  subscribe('runs.changed')(onRunChanged);
  subscribe('triggers.changed')(({ items }) => {
    state.triggers = items;
    renderStatus();
    renderList();
    // Background progress must not replace an input while the user is editing a schedule.
    if (!document.querySelector('#triggers').contains(document.activeElement)) {
      renderTriggers();
    }
  });
  await Promise.all([messagePanel.load(), workflowGroups.load(), invoke('runs.activity').then(runs => {
    runs.forEach(run => activeRuns.set(run.id, run));
  })]);
  wireTopbar();
  if (workflows.length) { await selectWorkflow(state.currentId); }
  render();
  setStatus(state.dirty ? '已创建新工作流，记得保存。' : '');
}

function wireTopbar() {
  wireSidebar();
  document.querySelector('#new-group').onclick = event => workflowGroups.create(event.currentTarget);
  document.querySelector('#workflow-group').onclick = event => workflowGroups.open(event.currentTarget);
  document.querySelector('#import-workflow').onclick = () => act(() => transfer.openImport());
  document.querySelector('#export-workflow').onclick = () => act(() => transfer.exportCurrent());
  document.querySelector('#status').onclick = () => state.run && agentHistory.open(state.run.id, state.run.workflowId);
  document.querySelector('#save').onclick = () => act(() => saveWorkflow());
  document.querySelector('#delete-workflow').onclick = () => act(deleteWorkflow);
  document.querySelector('#new-workflow').onclick = () => createWorkflow();
  document.querySelector('#auto-layout').onclick = () => {
    if (canvas.autoLayout()) {
      state.dirty = true;
      setStatus('已自动布局，点击保存保留节点位置。');
    }
  };
  document.querySelector('#run').onclick = () => act(startWorkflow);
  document.querySelector('#trigger-now').onclick = () => act(() => runWorkflow('triggers.fire'));
  document.querySelector('#continue-run').onclick = () => act(() => continueRun(state.run.id));
  document.querySelector('#cancel-run').onclick = () => act(cancelRun);
  document.querySelector('#workflow-name').oninput = event => {
    const workflow = current();
    if (!workflow) {
      return;
    }
    workflow.name = event.target.value;
    event.target.title = workflow.name;
    state.dirty = true;
    renderList();
  };
}

function createWorkflow(group) {
  const draft = { id: crypto.randomUUID(), name: '新建工作流', nodes: [], edges: [],
    ...(group ? { groupId: group.id, group: group.name } : {}) };
  state.workflows.push(draft);
  selectWorkflow(draft.id);
  state.dirty = true;
}

// Keep resizing local to the editor; workflow definitions contain only execution and canvas data.
function wireSidebar() {
  const layout = document.querySelector('.layout');
  const sidebar = document.querySelector('.workflow-sidebar');
  const toggle = document.querySelector('#toggle-list');
  let drag;
  const resize = width => {
    const size = Math.max(160, Math.min(width, 480, layout.clientWidth * .4));
    layout.style.setProperty('--sidebar-width', `${size}px`);
  };
  toggle.onclick = event => {
    // A resize also emits click; only a stationary pointer click should hide the list.
    if (event.detail > 0 && drag?.moved) {
      drag = null;
      return;
    }
    const collapsed = layout.dataset.listCollapsed !== 'true';
    layout.dataset.listCollapsed = String(collapsed);
    sidebar.inert = collapsed;
    toggle.ariaLabel = collapsed ? '展开工作流列表' : '收起工作流列表';
    toggle.title = collapsed ? '展开工作流列表' : '收起工作流列表（拖动调整宽度）';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  toggle.onpointerdown = event => {
    drag = null;
    if (event.button !== 0 || sidebar.inert) {
      return;
    }
    drag = { x: event.clientX, width: sidebar.offsetWidth, moved: false };
    toggle.setPointerCapture(event.pointerId);
  };
  toggle.onpointermove = event => {
    if (!drag || !toggle.hasPointerCapture(event.pointerId)) {
      return;
    }
    drag.moved ||= Math.abs(event.clientX - drag.x) > 4;
    if (drag.moved) {
      layout.classList.add('list-resizing');
      resize(drag.width + event.clientX - drag.x);
    }
  };
  toggle.onlostpointercapture = () => layout.classList.remove('list-resizing');
  toggle.onpointercancel = () => { drag = null; };
  toggle.onkeydown = event => {
    if (!sidebar.inert && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      resize(sidebar.offsetWidth + (event.key === 'ArrowRight' ? 20 : -20));
    }
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
  await workflowGroups.load();
  setStatus('已保存。');
  render();
}

// The schedule switch controls future occurrences; the stop button controls the current run.
async function startWorkflow() {
  const workflow = current();
  if (!['once', 'daily', 'interval'].includes(workflow?.trigger?.mode)) {
    return runWorkflow();
  }
  const enabled = !state.triggers.find(item => item.workflowId === workflow.id)?.enabled;
  if (enabled && state.dirty) {
    workflow.trigger = { ...workflow.trigger, enabled: true };
    state.dirty = true;
    await saveWorkflow();
  }
  const saved = await invoke('triggers.setEnabled', { workflowId: workflow.id, enabled });
  state.workflows = state.workflows.map(item => item.id !== saved.id ? item : state.dirty
    ? { ...item, trigger: { ...item.trigger, enabled: saved.trigger.enabled } } : saved);
  state.triggers = await invoke('triggers.next');
  if (!enabled) {
    setStatus('定时已关闭，后续不再自动触发。');
  } else if (!['running', 'waiting'].includes(state.run?.status)) {
    setStatus(state.triggers.find(item => item.workflowId === workflow.id)?.nextAt != null
      ? '定时已开启，等待到期触发。' : '单次定时已结束，请修改时间后重新开启。');
  } else {
    setStatus('定时已开启，当前运行继续。');
  }
  render();
}

async function runWorkflow(method = 'runs.start') {
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
  const started = await invoke(method, workflow.id);
  // Run events can arrive before the trigger RPC returns; keep the newest state for that run.
  if (state.run?.id !== started.id) {
    state.run = started;
  }
  state.selectedNodeId = null;
  await loadHistory();
  if (state.run.status === 'running') {
    setStatus('运行中…');
  } else {
    onRunChanged(state.run);
  }
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

// Continue always uses the saved execution snapshot, preserving the current editable template.
async function continueRun(runId) {
  state.run = await invoke('runs.continue', runId);
  state.selectedNodeId = null;
  await loadHistory();
  render();
  await resumeIfWaiting(state.run);
  watchRun(runId);
}

async function reselectFile(runId, node) {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog';
  dialog.setAttribute('aria-labelledby', 'reselect-file-title');
  dialog.innerHTML = `<h2 id="reselect-file-title">重新选择文件</h2><p></p>
    <footer><button type="button" data-cancel autofocus title="取消" aria-label="取消" class="icon-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M6 18L18 6"/></svg></button>
    <button type="button" data-confirm title="确认重新选择" aria-label="确认重新选择" class="icon-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button></footer>`;
  dialog.querySelector('p').textContent = `返回“${node.title}”重新选择文件？依赖旧文件的后续结果将清除并重跑，其他分支结果和历史记录保留。已写入项目的文件不会撤销。`;
  document.body.append(dialog);
  const confirmed = await new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
    dialog.querySelector('[data-confirm]').onclick = () => dialog.close('confirm');
    showPopup(dialog);
  });
  dialog.remove();
  if (!confirmed) { return; }
  state.run = await invoke('runs.reselectFile', { runId, nodeId: node.id });
  state.selectedNodeId = null;
  await loadHistory();
  render();
  watchRun(runId);
}

function serialize(workflow) {
  return { id: workflow.id, name: workflow.name, group: workflow.group, groupId: workflow.groupId, edges: workflow.edges, trigger: workflow.trigger,
    nodes: workflow.nodes.map(node => ({ id: node.id, type: node.type, title: node.title, x: node.x, y: node.y,
      width: node.width, height: node.height, params: node.params })) };
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

async function removeNode(nodeIdValue, anchor = document.activeElement) {
  const workflow = current();
  if (!workflow) {
    return;
  }
  const node = workflow.nodes.find(node => node.id === nodeIdValue);
  if (!await confirmConfigurationDelete('删除节点', `确认删除节点“${node.title || node.id}”及其关联连线？保存后生效。`, anchor)) {
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

async function removeEdge(key, anchor = document.activeElement) {
  const workflow = current();
  if (!workflow || !key) {
    return;
  }
  const [from, to] = key.split('>');
  if (!await confirmConfigurationDelete('删除连线', '确认删除所选连线？保存后生效。', anchor)) {
    return;
  }
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
  renderCanvas();
}

function renderStatus() {
  const name = document.querySelector('#workflow-name');
  const workflow = current();
  name.value = workflow?.name || '';
  name.title = workflow?.name || '';
  name.disabled = !workflow;
  document.querySelector('#save').disabled = !workflow;
  document.querySelector('#workflow-group').disabled = !workflow;
  document.querySelector('#workflow-group').title = `设置工作流分组：${workflow?.group || '未分组'}`;
  document.querySelector('#export-workflow').disabled = !workflow;
  document.querySelector('#delete-workflow').disabled = !workflow;
  const busy = ['running', 'waiting'].includes(state.run?.status);
  const scheduled = ['once', 'daily', 'interval'].includes(workflow?.trigger?.mode);
  const timerEnabled = scheduled && state.triggers.some(item => item.workflowId === workflow.id && item.enabled);
  const start = document.querySelector('#run');
  start.disabled = !workflow || !scheduled && busy;
  start.title = scheduled ? timerEnabled ? '关闭定时' : '开启定时' : '运行';
  start.setAttribute('aria-label', start.title);
  if (scheduled) {
    start.setAttribute('aria-pressed', String(timerEnabled));
  } else {
    start.removeAttribute('aria-pressed');
  }
  start.querySelector('path').setAttribute('d', scheduled
    ? 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M12 7v5l3 2' : 'm8 4 12 8-12 8Z');
  const triggerNow = document.querySelector('#trigger-now');
  triggerNow.hidden = !scheduled;
  triggerNow.disabled = !workflow || busy;
  document.querySelector('#cancel-run').disabled = !busy;
  const continuation = document.querySelector('#continue-run');
  continuation.hidden = !state.run?.resumable || busy;
  continuation.disabled = busy;
  document.querySelector('#status-text').textContent = state.status;
  document.querySelector('#status').disabled = !state.run;
  document.querySelector('#status-text').className = state.statusError ? 'error-text' : '';
}

function renderList() {
  workflowGroups.render(document.querySelector('#list'));
}

async function deleteWorkflow() {
  const workflow = current();
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog';
  dialog.setAttribute('aria-labelledby', 'delete-workflow-title');
  dialog.innerHTML = `<h2 id="delete-workflow-title">删除工作流</h2><p></p>
    <footer><button type="button" data-cancel autofocus title="取消" aria-label="取消" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12 M6 18L18 6"/></svg></button><button type="button" data-delete title="确认删除" aria-label="确认删除" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button></footer>`;
  dialog.querySelector('p').textContent = `确认删除“${workflow.name}”？此操作无法撤销，正在执行的任务也会停止。`;
  document.body.append(dialog);
  // Bind confirmation to the displayed workflow rather than whichever item is current after awaiting it.
  const confirmed = await new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true });
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
    dialog.querySelector('[data-delete]').onclick = () => dialog.close('delete');
    showPopup(dialog);
  });
  dialog.remove();
  if (!confirmed) {
    return;
  }
  await invoke('workflows.remove', workflow.id);
  state.workflows = state.workflows.filter(item => item.id !== workflow.id);
  state.currentId = state.workflows[0]?.id || null;
  state.selectedNodeId = null;
  state.selectedEdge = null;
  state.run = null;
  await loadHistory();
  setStatus('');
  render();
}

function renderPalette() {
  const container = document.querySelector('#palette');
  container.innerHTML = `<button type="button" id="add-node" class="icon-button" aria-label="添加节点" title="添加节点">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>`;
  container.querySelector('#add-node').onclick = () => { nodePicker.open(); act(refreshAgents); };
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
    ? '<div class="warning">请在工作台启用或升级 AI Agent 插件，再点击添加节点。</div>' : ''}
    ${legacy ? `<div class="warning">该工作流${shape.start ? '缺少开始节点' : ''}${shape.start && shape.end ? '、' : ''}${shape.end ? '缺少终止节点' : ''}，
       仍可按旧规则运行（以无上游的节点为入口）。<button type="button" id="complete-ends" title="补齐开始/终止节点" aria-label="补齐开始/终止节点" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14 M5 12h14"/></svg></button></div>` : ''}`;
  document.querySelector('#complete-ends')?.addEventListener('click', () => act(completeEnds));
}

function renderProperties() {
  const container = document.querySelector('#properties');
  const node = nodeOf(state.selectedNodeId);
  document.querySelector('#workflow-properties').hidden = Boolean(node || state.selectedEdge);
  // Connection editors stay mounted to preserve unfinished forms, but belong only to matching node properties.
  document.querySelector('#message-connections').hidden = !typeOf(node?.type)?.params?.some(spec => spec.kind === 'connection');
  document.querySelector('#mail-credentials').hidden = !typeOf(node?.type)?.params?.some(spec => spec.kind === 'credential');
  feishuRobotPanel.show(node?.type === 'output.feishu');
  messagePanel.render(current(), typeOf(node?.type)?.params?.find(spec => spec.kind === 'connection')?.channel);
  if (state.selectedEdge) {
    renderEdgeProperties(container);
    return;
  }
  if (!node) {
    container.innerHTML = `<p class="hint">点击画布上的节点即可编辑参数。<br>点击连线可选中并删除。</p>
      ${state.selectedEdge ? '<button type="button" id="delete-edge" title="删除所选连线" aria-label="删除所选连线" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button>' : ''}`;
    document.querySelector('#delete-edge')?.addEventListener('click', event => removeEdge(state.selectedEdge, event.currentTarget));
    return;
  }
  const type = typeOf(node.type);
  const variables = availableVariables(node.id);
  container.innerHTML = `<div class="panel-title">${escape(type?.label || node.type)}</div>
    <p class="hint">${escape(type?.summary || '')}</p>
    <section data-selected-file hidden></section>
    <label>节点名称<input data-field="title" value="${escape(node.title)}"></label>
    ${node.type === 'custom.configured' && node.params.mode === 'script' ? '<p class="error-text">脚本可访问本机资源，仅执行可信代码。独立进程不是权限沙箱。</p>' : ''}
    ${visibleNodeParams(type, node.params)
      .map(spec => paramHtml(node, spec)).join('')}
    <div class="panel-title">可用变量</div>
    <div class="variables">${variables.length ? variables.map(name =>
      `<button type="button" data-var="{{${escape(name)}}}">{{${escape(name)}}}</button>`).join('') : '<small>上游节点运行后显示</small>'}</div>
    ${state.selectedEdge ? '<label></label><button type="button" id="delete-edge" title="删除所选连线" aria-label="删除所选连线" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button>' : ''}
    <label></label><button type="button" id="delete-node" title="删除节点" aria-label="删除节点" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button>`;
  container.querySelector('[data-field="title"]').oninput = event => {
    node.title = event.target.value;
    state.dirty = true;
    renderCanvas();
  };
  container.querySelector('#delete-node').onclick = event => removeNode(node.id, event.currentTarget);
  document.querySelector('#delete-edge')?.addEventListener('click', event => removeEdge(state.selectedEdge, event.currentTarget));
  for (const element of container.querySelectorAll('[data-param]')) {
    const name = element.dataset.param;
    const update = () => {
      node.params[name] = element.dataset.kind === 'number' ? Number(element.value) : element.value;
      state.dirty = true;
      if (name === 'connectionId') { renderTriggers(); }
      if (name === 'interaction') { renderProperties(); }
      else if (type?.params?.some(spec => Object.hasOwn(spec.when || {}, name))) {
        const focused = document.activeElement === element;
        renderProperties();
        if (focused) {
          container.querySelector(`[data-param="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
        }
      }
    };
    element.oninput = type?.params?.some(spec => Object.hasOwn(spec.when || {}, name)) ? null : update;
    element.onchange = update;
    element.onfocus = () => { state.focused = element; };
  }
  for (const button of container.querySelectorAll('[data-var]')) {
    button.onclick = () => insertVariable(button.dataset.var);
  }
  renderSelectedFile();
}

// Read the submitted snapshot; opening a file must not reread a changed source or fetch a URL.
function filePreview(node, output, open = false) {
  if (node?.type !== 'flow.user-input' || !output?.file || typeof output.text !== 'string') {
    return '';
  }
  return `<details class="node-file-preview" data-file-preview="${escape(node.id)}" ${open ? 'open' : ''}>
    <summary title="查看本次运行提交的内容"><span data-file-name>${escape(output.file.name)}</span>
      <small>${output.file.url ? '链接' : '文件'} · ${escape(output.file.size)} 字节</small></summary>
    <pre class="output" tabindex="0" aria-label="${output.file.url ? '已提交链接' : '已提交文件内容'}">${escape(output.text)}</pre></details>`;
}

// Run events update only this section so property edits and an open preview keep their focus and scroll position.
function renderSelectedFile() {
  const container = document.querySelector('#properties [data-selected-file]');
  if (!container) { return; }
  const node = nodeOf(state.selectedNodeId);
  const output = state.run?.nodes[node?.id]?.output;
  if (container.dataset.run === state.run?.id
    && container.querySelector('[data-file-name]')?.textContent === output?.file?.name
    && container.querySelector('pre')?.textContent === output?.text) {
    return;
  }
  const preview = filePreview(node, output);
  container.hidden = !preview;
  container.dataset.run = state.run?.id || '';
  container.innerHTML = preview ? `<div class="panel-title">已提交文件</div>${preview}` : '';
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
    <button type="button" id="delete-edge" title="删除所选连线" aria-label="删除所选连线" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button>`;
  container.querySelector('#delete-edge').onclick = event => removeEdge(state.selectedEdge, event.currentTarget);
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
  const nextAt = planned?.nextAt ? new Date(planned.nextAt).toLocaleString('zh-CN',
    trigger.mode === 'daily' ? { timeZone: 'Asia/Shanghai' } : undefined) : '';
  const statuses = { starting: '启动中', running: '运行中', waiting: '等待确认或服务调用', succeeded: '已完成',
    failed: '失败', canceled: '已停止', interrupted: '已中断，可继续' };
  const lastRun = planned?.lastStartedAt ? new Date(planned.lastStartedAt).toLocaleString('zh-CN') : '';
  const modes = state.triggerOptions.modes.length ? state.triggerOptions.modes : ['manual', 'once', 'daily', 'interval'];
  const units = state.triggerOptions.units.length ? state.triggerOptions.units : ['minute'];
  container.innerHTML = `<label>运行方式<select id="trigger-mode">${modes.map(mode =>
    `<option value="${escape(mode)}" ${trigger.mode === mode ? 'selected' : ''}>${escape(MODE_LABELS[mode] || mode)}</option>`).join('')}</select></label>
    ${trigger.mode === 'once' ? `<label>触发时间<input id="trigger-at" type="datetime-local"
      value="${escape(String(trigger.at || '').replace(' ', 'T'))}"></label>` : ''}
    ${trigger.mode === 'daily' ? `<label>北京时间<input id="trigger-at" type="time"
      value="${escape(trigger.at || '10:00')}"></label>` : ''}
    ${trigger.mode === 'interval' ? `<div class="row"><label>每<input id="trigger-every" type="number" min="1"
      value="${escape(String(trigger.every || 1))}"></label><label>单位<select id="trigger-unit">${units.map(unit =>
    `<option value="${escape(unit)}" ${trigger.unit === unit ? 'selected' : ''}>${escape(UNIT_LABELS[unit] || unit)}</option>`).join('')}</select></label></div>` : ''}
    ${trigger.mode === 'manual' ? '' : `<label class="row"><input id="trigger-enabled" type="checkbox" role="switch"
      ${trigger.enabled ? 'checked' : ''} ${trigger.mode === 'message' && !canListen ? 'disabled' : ''}>启用${trigger.mode === 'message' ? '消息监听' : '自动触发'}</label>`}
    ${trigger.mode === 'message' ? `<p class="hint">${canListen ? '保存启用后等待消息；关闭最后一个窗口会停止监听，待执行消息保留。' : '请添加一个消息入口、选择连接，并移除普通开始节点。'}</p>` : `<small class="trigger-summary">下次运行：${nextAt || '不会自动触发'}</small>`}
    ${lastRun ? `<small class="trigger-summary">最近执行：${escape(lastRun)} · ${escape(statuses[planned.lastStatus] || planned.lastStatus)}${planned.lastSource === 'manual' ? '（手动触发）' : '（定时触发）'}</small>` : ''}
    ${planned?.lastError ? `<p class="error-text">${escape(planned.lastError.message)}</p>` : ''}
    ${trigger.mode !== 'manual' && trigger.enabled ? `<span class="trigger-help"><button type="button" class="icon-button"
      title="自动触发说明" aria-label="自动触发说明" aria-describedby="trigger-help"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3.5 M12 17v.1"/></svg></button>
      <small id="trigger-help" role="tooltip">${trigger.mode === 'message' ? '桌面启动后，首次打开本插件才会恢复消息监听。'
        : '插件启动后恢复定时；到期未执行的任务立即补跑一次。立即触发不改变原排期，正在执行的任务不重复启动。'}</small></span>` : ''}
    ${state.triggerOptions.contract && trigger.mode !== 'message' ? `<small>其他插件可通过契约 ${escape(state.triggerOptions.contract)} 触发本工作流。</small>` : ''}`;
  container.querySelector('#trigger-mode').onchange = event => {
    workflow.trigger = { ...trigger, mode: event.target.value, at: event.target.value === 'once'
      ? String(trigger.at || '').replace(' ', 'T') : '', every: Number(trigger.every) || 1,
    unit: trigger.unit || 'minute', enabled: trigger.mode === event.target.value ? trigger.enabled : event.target.value !== 'message' };
    if (event.target.value === 'daily') {
      workflow.trigger.at = trigger.mode === 'daily' ? trigger.at : '10:00';
      workflow.trigger.timezone = 'Asia/Shanghai';
    }
    state.dirty = true;
    renderTriggers();
    renderStatus();
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
  document.querySelector('#canvas-tools').hidden = menu;
  document.querySelector('#palette').hidden = menu;
  const run = state.run;
  userInput.show(run);
  renderSelectedFile();
  const nodes = current()?.nodes || [];
  const recorded = run?.nodes || {};
  const statusLabels = { running: '运行中', waiting: '等待确认或服务调用', succeeded: '已完成', failed: '失败', canceled: '已停止',
    interrupted: '已中断，可继续', skipped: '已跳过' };
  // Polling must preserve the details the user opened without carrying them into a different run or workflow.
  const resultKey = `${state.currentId}:${run?.id || ''}`;
  const expanded = new Set(container.dataset.resultKey === resultKey
    ? [...container.querySelectorAll('details[data-result-node][open]')].map(item => item.dataset.resultNode) : []);
  const fileViews = new Map(container.dataset.resultKey === resultKey
    ? [...container.querySelectorAll('[data-file-preview]')].map(item => [item.dataset.filePreview,
      { open: item.open, scrollTop: item.querySelector('pre').scrollTop }]) : []);
  container.dataset.resultKey = resultKey;
  const timeline = nodes.map(node => {
    const entry = recorded[node.id];
    const canReselect = run?.resumable && (run.status === 'interrupted'
      || run.status === 'waiting' && ['manual', 'loop'].includes(run.pending?.kind))
      && node.type === 'flow.user-input' && entry?.status === 'succeeded' && entry.output?.file;
    const detail = entry?.error ? `<pre class="output error-text">${escape(entry.error.message)}</pre>`
      : entry?.output !== undefined ? filePreview(node, entry.output, fileViews.get(node.id)?.open)
        || `<pre class="output">${escape(text(entry.output))}</pre>`
        : entry?.reason ? `<pre class="output">${escape(entry.reason)}</pre>` : '';
    return `<details class="result-item node-result" data-result-node="${escape(node.id)}" ${expanded.has(node.id) ? 'open' : ''}>
      <summary><span class="result-name">${escape(node.title)}</span><span class="result-status"><span class="state-dot state-${escape(entry?.status || 'none')}"></span>${escape(statusLabels[entry?.status] || '未运行')}${entry?.iteration ? ` · 第 ${entry.iteration} 轮` : ''}</span></summary>
      ${canReselect ? `<button type="button" data-reselect-file="${escape(node.id)}" title="重新选择文件" aria-label="重新选择文件" class="icon-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7 M20 4v6h-6"/></svg></button>` : ''}
      ${detail || '<p class="hint">暂无执行内容。</p>'}</details>`;
  }).join('');
  const history = state.history.toSorted((a, b) => b.startedAt - a.startedAt).slice(0, 5).map(item => {
    const startedAt = new Date(item.startedAt).toLocaleString('zh-CN');
    const status = { waiting: '等待中', interrupted: '已中断' }[item.status] || statusLabels[item.status] || item.status;
    return `<div class="run-history-row"
    role="listitem" data-started-at="${item.startedAt}">
    <span class="run-history-time" title="${escape(startedAt)}">${escape(startedAt)}</span>
    <span class="run-history-status${item.status === 'failed' ? ' error-text' : ''}"
      title="${escape(item.error?.message || status)}">${escape(status)}</span>
    <div class="run-history-actions">
    <button type="button" data-history-run="${escape(item.id)}" title="Agent 会话记录" aria-label="Agent 会话记录" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 7 M4 4v6h6 M12 7v5l3 2"/></svg></button>
    ${item.resumable && ['interrupted', 'failed', 'canceled'].includes(item.status) ? `<button type="button" data-continue-run="${escape(item.id)}" title="继续流程" aria-label="继续流程" class="icon-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7Z M5 5v14"/></svg></button>` : ''}
    </div></div>`;
  }).join('');
  container.innerHTML = `${run ? `<div class="result-item"><header><span>${escape(statusLabels[run.status] || run.status)}</span>
    <span>${escape(new Date(run.startedAt).toLocaleString('zh-CN'))}</span></header>
    ${run.error ? `<pre class="output error-text">${escape(run.error.message)}</pre>` : ''}</div>` : '<p class="hint">还没有运行记录。</p>'}
    ${run?.status === 'waiting' && run?.pending?.kind === 'service' ? agentRequests(run.pending.interaction ? [] : run.pending.task?.requests, run.pending.mode || 'plan') : ''}
    ${run?.status === 'waiting' && (run?.pending?.interaction || run?.pending?.kind === 'manual' && run.pending.form) ? '<div class="result-item"><p>等待补充信息，确认后继续当前流程。</p><button type="button" data-user-input title="填写并继续" aria-label="填写并继续" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 5 7 7-7 7 M3 12h18"/></svg></button></div>' : ''}
    ${run?.status === 'waiting' && run?.pending?.kind === 'loop' ? `<div class="result-item"><p>${escape(run.pending.message || `循环已达到最大轮次（当前第 ${run.iterations?.[run.pending.nodeId] || 1} 轮）。`)}</p>
      ${run.pending.canContinue === false ? '' : `<button type="button" data-loop="continue" title="${run.pending.reason === 'no-progress' ? '已调整，继续下一轮' : '继续下一组循环'}" aria-label="${run.pending.reason === 'no-progress' ? '已调整，继续下一轮' : '继续下一组循环'}" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 5 7 7-7 7 M3 12h18"/></svg></button>`}
      <button type="button" data-loop="exit" title="退出循环，进入后续分支" aria-label="退出循环，进入后续分支" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H3v18h6 M8 12h13 M16 7l5 5-5 5"/></svg></button></div>` : ''}
    ${!run?.resumable && run?.status === 'failed' && (typeOf(nodeOf(run.error?.nodeId)?.type)?.service
      || ['flow.route', 'flow.loop', 'flow.parallel'].includes(nodeOf(run.error?.nodeId)?.type)) ? '<button type="button" id="retry-node" title="重试失败节点" aria-label="重试失败节点" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7 M20 4v6h-6"/></svg></button>' : ''}
    ${timeline}<div class="panel-title">最近运行</div><div class="run-history" role="list" aria-label="最近运行">${history || '<small>暂无</small>'}</div>`;
  for (const preview of container.querySelectorAll('[data-file-preview]')) {
    preview.querySelector('pre').scrollTop = fileViews.get(preview.dataset.filePreview)?.scrollTop || 0;
  }
  container.querySelector('[data-user-input]')?.addEventListener('click', () => userInput.open());
  for (const button of container.querySelectorAll('[data-reselect-file]')) {
    button.onclick = () => act(() => reselectFile(run.id, nodes.find(node => node.id === button.dataset.reselectFile)));
  }
  for (const button of container.querySelectorAll('[data-continue-run]')) {
    button.onclick = () => act(() => continueRun(button.dataset.continueRun));
  }
  for (const button of container.querySelectorAll('[data-history-run]')) {
    button.onclick = () => agentHistory.open(button.dataset.historyRun, current().id);
  }
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
    <div class="row" style="margin-top:6px"><button type="button" data-edit-credential="${escape(item.id)}" title="编辑" aria-label="编辑" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16-1 5 5-1L21 7l-4-4z M14 6l4 4"/></svg></button>
    <button type="button" data-remove-credential="${escape(item.id)}" title="删除" aria-label="删除" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button></div></div>`).join('') || '<p class="hint">还没有邮件账号。</p>'}
    <hr><div class="panel-title">${draft.id ? '编辑账号' : '新增账号'}</div>
    ${field('name', '名称', draft.name)}${field('host', '服务器地址', draft.host)}
    <div class="row">${field('port', '端口', draft.port, 'number')}
    <label>连接方式<select data-credential="security">${security}</select></label></div>
    ${field('username', '登录账号', draft.username)}${field('password', '密码 / 授权码', '', 'password')}
    <button type="button" id="save-credential" title="保存账号" aria-label="保存账号" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8"/></svg></button>`;
  for (const button of container.querySelectorAll('[data-edit-credential]')) {
    button.onclick = async () => {
      const detail = await invoke('credentials.list');
      state.credentialDraft = { ...detail.find(item => item.id === button.dataset.editCredential), password: '' };
      renderCredentials();
    };
  }
  for (const button of container.querySelectorAll('[data-remove-credential]')) {
    button.onclick = () => act(async () => {
      const credential = state.credentials.find(item => item.id === button.dataset.removeCredential);
      if (!await confirmConfigurationDelete('删除邮件账号', `确认删除邮件账号“${credential.name}”？使用此账号的节点需重新配置。`, button)) {
        return;
      }
      await invoke('credentials.remove', credential.id);
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
    statuses: state.run?.nodes || {}, handlers: { onSelectNode, onSelectEdge, onMoveNode, onResizeNode: onMoveNode,
      onLink: linkNodes, onRemoveNode: removeNode,
      typeOf } });
}

async function selectWorkflow(workflowId) {
  state.currentId = workflowId;
  // Host question dialogs survive view reloads; keep their workflow selected as well.
  sessionStorage.setItem('work-flow.current', workflowId);
  state.selectedNodeId = null;
  state.selectedEdge = null;
  const stored = await invoke('runs.list', workflowId);
  state.history = stored;
  state.run = stored.length ? await invoke('runs.get', stored.at(-1).id).catch(() => {
    const previous = structuredClone(stored.at(-1));
    // A persisted run has no live Engine context after restart, including ordinary Agent service calls.
    if (['running', 'waiting'].includes(previous.status)) {
      previous.status = 'interrupted';
      previous.pending = null;
      previous.error = { message: '旧版本运行缺少完整恢复数据，请核对外部结果后重新运行。' };
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
  setStatus('节点布局已调整，尚未保存。');
}

function onRunChanged(run) {
  if (['running', 'waiting'].includes(run.status)) { activeRuns.set(run.id, run); } else { activeRuns.delete(run.id); }
  renderList();
  if (!current() || run.workflowId !== current().id) {
    return;
  }
  state.run = run;
  if (run.status === 'waiting') {
    setStatus(run.pending?.kind === 'loop' ? run.pending.message || '循环已达到最大轮次，等待选择继续或退出…'
      : run.pending?.kind === 'manual' ? '等待人工确认…'
      : run.pending?.task?.requests?.length ? '等待 Agent 问题确认…' : '');
    act(() => resumeIfWaiting(run));
  }
  if (!['running', 'waiting'].includes(run.status)) {
    setStatus(run.status === 'succeeded' ? '运行完成。' : run.status === 'canceled' ? '运行已停止。' : run.status === 'interrupted' ? '进度已保存，点击继续流程。' : '运行失败，查看右侧详情。',
      run.status === 'failed');
    // Disabling the plugin can reject this final event's history request before its view closes.
    act(async () => {
      await loadHistory();
      renderResults();
    });
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
