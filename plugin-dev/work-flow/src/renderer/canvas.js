import { KIND_TAGS as KIND_LABELS } from '../shared/node-categories.js';
import { escape } from './api.js';

const MARGIN = 120;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 620;
const IO_LABELS = { source: '输入', transform: '输入输出', sink: '输出' };

// A canvas keeps its own pointer state: nodes are absolutely positioned cards over an SVG edge layer.
export function createCanvas(root) {
  let workflow = null;
  let selected = null;
  let selectedEdge = null;
  let statuses = {};
  let handlers = {};
  let linking = null;
  let dragging = false;

  // A click outside any node cancels linking and clears the edge selection; one listener avoids stacking on redraw.
  root.addEventListener('click', event => {
    if (event.target === root) {
      linking = null;
      handlers.onSelectEdge?.(null);
      updateStatus();
    }
  });

  function mount(options) {
    workflow = options.workflow;
    selected = options.selectedNodeId;
    selectedEdge = options.selectedEdge;
    statuses = options.statuses || {};
    handlers = options.handlers || {};
    linking = null;
    draw();
  }

  function draw() {
    if (!workflow) {
      root.innerHTML = '<p class="hint">新建一个工作流，或选择左侧已有工作流。</p>';
      return;
    }
    root.innerHTML = `<svg class="edges"></svg>${workflow.nodes.map(nodeHtml).join('')}`;
    for (const node of workflow.nodes) {
      const element = elementOf(node.id);
      element.querySelector('header').addEventListener('pointerdown', event => startDrag(event, node, element));
      element.querySelector('.port.out').addEventListener('click', event => {
        event.stopPropagation();
        linking = { from: node.id };
        updateStatus();
      });
      element.querySelector('.port.in').addEventListener('click', event => {
        event.stopPropagation();
        if (linking && linking.from !== node.id) {
          handlers.onLink?.(linking.from, node.id);
        }
        linking = null;
        updateStatus();
      });
      element.querySelector('.remove').addEventListener('click', event => {
        event.stopPropagation();
        handlers.onRemoveNode?.(node.id);
      });
      element.addEventListener('click', event => {
        // Dragging must not change the selection, so only clean clicks select.
        if (dragging) {
          dragging = false;
          return;
        }
        event.stopPropagation();
        handlers.onSelectNode?.(node.id);
      });
    }
    resize();
    drawEdges();
    updateStatus();
  }

  function nodeHtml(node) {
    const type = handlers.typeOf?.(node.type);
    const state = statuses[node.id];
    const classes = ['node', `role-${type?.role || 'step'}`, selected === node.id ? 'selected' : ''].filter(Boolean).join(' ');
    return `<div class="${classes}" data-node="${escape(node.id)}" style="left:${Math.max(0, node.x)}px;top:${Math.max(0, node.y)}px">
<header><span class="title">${escape(node.title || type?.label || node.type)}</span>
<span class="badge">${escape(type?.label || node.type)}</span>
<span class="tag" title="输入输出：${escape(IO_LABELS[type?.io] || '未知')}">${escape(IO_LABELS[type?.io] || '')}</span>
<span class="tag" title="功能：${escape(KIND_LABELS[type?.kind] || '未知')}">${escape(KIND_LABELS[type?.kind] || '')}</span>
<button type="button" class="remove icon-button" title="删除节点" aria-label="删除节点"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M6 18L18 6"/></svg></button></header>
<p class="summary">${escape(type?.summary || '')}</p>
<p class="run-state" data-state="${escape(node.id)}">${stateHtml(state)}</p>
<button type="button" class="port in" title="连接到此节点"></button>
<button type="button" class="port out" title="从此节点开始连线"></button></div>`;
  }

  function stateHtml(state) {
    if (!state) {
      return '<span class="state-dot"></span>未运行';
    }
    return `<span class="state-dot state-${escape(state.status)}"></span>${escape(stateText(state))}`;
  }

  function stateText(state) {
    const labels = { running: '运行中', waiting: '等待确认或服务', succeeded: '已完成', failed: '失败', skipped: '已跳过', canceled: '已停止' };
    const label = labels[state.status] || state.status;
    const detail = state.error ? ` · ${state.error.message}` : state.reason ? ` · ${state.reason}` : '';
    return `${label}${state.iteration ? ` · 第 ${state.iteration} 轮` : ''}${detail}`;
  }

  function resize() {
    const width = Math.max(MIN_WIDTH, ...workflow.nodes.map(node => node.x + 320));
    const height = Math.max(MIN_HEIGHT, ...workflow.nodes.map(node => node.y + 220));
    root.style.width = `${width + MARGIN}px`;
    root.style.height = `${height + MARGIN}px`;
  }

  function elementOf(nodeId) {
    return root.querySelector(`[data-node="${cssId(nodeId)}"]`);
  }

  function drawEdges() {
    const svg = root.querySelector('svg.edges');
    svg.innerHTML = workflow.edges.map(edge => {
      const from = elementOf(edge.from);
      const to = elementOf(edge.to);
      if (!from || !to) {
        return '';
      }
      const start = anchor(from, 'out');
      const end = anchor(to, 'in');
      const curve = Math.max(36, Math.abs(end.x - start.x) / 2);
      const path = `M ${start.x} ${start.y} C ${start.x + curve} ${start.y}, ${end.x - curve} ${end.y}, ${end.x} ${end.y}`;
      const key = `${edge.from}>${edge.to}`;
      const active = selectedEdge === key ? 'selected' : '';
      return `${edge.branch ? `<text class="edge-label" x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 10}" text-anchor="middle">${escape(edge.branch)}</text>` : ''}<path d="${path}"></path><path class="hit ${active}" d="${path}" data-edge="${escape(key)}"></path>`;
    }).join('');
    for (const hit of svg.querySelectorAll('[data-edge]')) {
      hit.addEventListener('click', event => {
        event.stopPropagation();
        handlers.onSelectEdge?.(hit.dataset.edge);
      });
    }
  }

  function anchor(element, side) {
    const y = element.offsetTop + element.offsetHeight / 2;
    const x = side === 'out' ? element.offsetLeft + element.offsetWidth : element.offsetLeft;
    return { x, y };
  }

  function startDrag(event, node, element) {
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
    dragging = false;
    const move = pointer => {
      const dx = pointer.clientX - origin.x;
      const dy = pointer.clientY - origin.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        dragging = true;
      }
      node.x = Math.max(0, origin.nodeX + dx);
      node.y = Math.max(0, origin.nodeY + dy);
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      resize();
      drawEdges();
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      if (dragging) {
        handlers.onMoveNode?.(node);
      }
      setTimeout(() => { dragging = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  }

  function updateStatus() {
    root.querySelectorAll('[data-state]').forEach(element => {
      element.innerHTML = stateHtml(statuses[element.dataset.state]);
    });
    const hint = document.querySelector('#stage-hint');
    if (hint) {
      hint.textContent = linking ? '已选择起点，点击目标节点左侧端口完成连线（点击空白处取消）。'
        : '拖拽标题移动节点；点击右侧圆点开始连线，再点击目标节点左侧圆点完成。';
    }
  }

  return { mount };
}

const cssId = value => String(value).replace(/["\\]/g, '\\$&');
