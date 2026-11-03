import { KIND_TAGS as KIND_LABELS } from '../shared/node-categories.js';
import { escape } from './api.js';
import { layoutNodes, routeEdges } from './canvas-layout.js';
import { nodeShape, shapeOutline } from './node-shape.js';
import { createViewport } from './canvas-viewport.js';

const MARGIN = 120;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 620;
const MIN_NODE_WIDTH = 210;
const MIN_NODE_HEIGHT = 130;
const STATE_LABELS = { running: '运行中', waiting: '等待确认', succeeded: '已完成', failed: '失败', skipped: '已跳过', canceled: '已停止' };
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
  const viewport = createViewport(root);
  const preview = document.createElement('section');
  preview.id = 'node-preview';
  preview.className = 'node-preview';
  preview.setAttribute('role', 'tooltip');
  preview.hidden = true;
  document.body.append(preview);
  let previewTimer;
  const hidePreview = () => { clearTimeout(previewTimer); preview.hidden = true; };
  const leavePreview = () => { previewTimer = setTimeout(hidePreview, 100); };
  preview.addEventListener('pointerenter', () => clearTimeout(previewTimer));
  preview.addEventListener('pointerleave', leavePreview);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { hidePreview(); } });
  window.addEventListener('resize', hidePreview);
  root.parentElement.parentElement.addEventListener('scroll', hidePreview);
  document.addEventListener('pointerdown', event => { if (!preview.contains(event.target)) { hidePreview(); } }, true);
  document.addEventListener('wheel', event => { if (!preview.contains(event.target)) { hidePreview(); } }, { passive: true });

  // A click outside any node cancels linking and clears the edge selection; one listener avoids stacking on redraw.
  root.parentElement.parentElement.addEventListener('click', event => {
    if (!event.target.closest('.node, [data-edge]')) {
      linking = null;
      handlers.onSelectEdge?.(null);
      updateStatus();
    }
  });

  function mount(options) {
    const changed = workflow?.id !== options.workflow?.id;
    workflow = options.workflow;
    selected = options.selectedNodeId;
    selectedEdge = options.selectedEdge;
    statuses = options.statuses || {};
    handlers = options.handlers || {};
    linking = null;
    draw();
    if (changed) {
      viewport.reset();
      if (workflow?.nodes.length) {
        viewport.focus(measuredNodes()[0]);
      }
    }
  }

  function draw() {
    hidePreview();
    if (!workflow) {
      root.innerHTML = '<p class="hint">新建一个工作流，或选择左侧已有工作流。</p>';
      return;
    }
    root.innerHTML = `<svg class="edges"></svg>${workflow.nodes.map(nodeHtml).join('')}`;
    for (const node of workflow.nodes) {
      const element = elementOf(node.id);
      fitLabel(element);
      element.addEventListener('pointerenter', () => showPreview(node, element));
      element.addEventListener('pointerleave', leavePreview);
      element.addEventListener('focusin', () => showPreview(node, element));
      element.addEventListener('focusout', leavePreview);
      element.addEventListener('keydown', event => {
        if (event.target === element && ['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          handlers.onSelectNode?.(node.id);
        }
      });
      element.querySelector('header').addEventListener('pointerdown', event => startDrag(event, node, element));
      const handle = element.querySelector('.resize-handle');
      handle.addEventListener('pointerdown', event => startResize(event, node, element));
      handle.addEventListener('keydown', event => resizeWithKeyboard(event, node, element));
      handle.addEventListener('click', event => event.stopPropagation());
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
        handlers.onRemoveNode?.(node.id, event.currentTarget);
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
    drawEdges();
    updateStatus();
  }

  function nodeHtml(node) {
    const type = handlers.typeOf?.(node.type);
    const state = statuses[node.id];
    const shape = nodeShape(type);
    const classes = ['node', `shape-${shape}`, `role-${type?.role || 'step'}`, selected === node.id ? 'selected' : ''].filter(Boolean).join(' ');
    const size = `${node.width ? `;width:${Math.max(MIN_NODE_WIDTH, node.width)}px` : ''}${node.height ? `;height:${Math.max(MIN_NODE_HEIGHT, node.height)}px` : ''}`;
    return `<div class="${classes}" data-node="${escape(node.id)}" tabindex="0" aria-describedby="node-preview"
      style="left:${Math.max(0, node.x)}px;top:${Math.max(0, node.y)}px${size}">
${shapeOutline(shape)}<div class="node-label"><header><span class="title">${escape(node.title || type?.label || node.type)}</span></header>
<p class="run-state" data-state="${escape(node.id)}">${stateHtml(state)}</p></div>
<button type="button" class="remove icon-button" title="删除节点" aria-label="删除节点"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M6 18L18 6"/></svg></button>
<button type="button" class="port in" title="连接到此节点"></button>
<button type="button" class="port out" title="从此节点开始连线"></button>
<button type="button" class="resize-handle icon-button" aria-label="调整节点大小" title="拖拽调整大小；方向键微调，Shift 加速"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20L20 8 M14 20l6-6"/></svg></button></div>`;
  }

  function stateHtml(state) {
    return `<span class="state-dot state-${escape(state?.status || 'none')}"></span>${escape(STATE_LABELS[state?.status] || state?.status || '未运行')}`;
  }

  // The label occupies the diamond's central half; growing its minimum height keeps wrapped titles inside the outline.
  function fitLabel(element) {
    const height = element.querySelector('.node-label').offsetHeight;
    element.style.minHeight = `${Math.max(MIN_NODE_HEIGHT, element.classList.contains('shape-route') ? height * 2 + 20 : height + 60)}px`;
  }

  // Render only public capability metadata; connection parameters may contain credentials.
  function showPreview(node, element) {
    clearTimeout(previewTimer);
    const type = handlers.typeOf?.(node.type);
    const state = statuses[node.id];
    const fields = [['基础能力', type?.label || node.type], ['功能分类', KIND_LABELS[type?.kind] || '未知'],
      ['输入输出', IO_LABELS[type?.io] || '未知'], ['执行状态', STATE_LABELS[state?.status] || state?.status || '未运行'],
      ...(state?.iteration ? [['执行轮次', `第 ${state.iteration} 轮`]] : []), ['能力说明', type?.summary || '暂无说明'],
      ...(state?.error || state?.reason ? [['执行详情', state.error?.message || state.reason]] : [])];
    preview.innerHTML = `<h3>${escape(node.title || type?.label || node.type)}</h3><dl>${fields.map(([label, value]) =>
      `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`;
    preview.hidden = false;
    const rect = element.getBoundingClientRect();
    const width = preview.offsetWidth;
    const height = preview.offsetHeight;
    const right = rect.right + 12;
    const left = rect.left - width - 12;
    const x = right + width <= window.innerWidth - 12 ? right : left >= 12 ? left : rect.left;
    const y = right + width > window.innerWidth - 12 && left < 12 ? rect.bottom + 12 : rect.top;
    preview.style.left = `${Math.max(12, Math.min(x, window.innerWidth - width - 12))}px`;
    preview.style.top = `${Math.max(12, Math.min(y, window.innerHeight - height - 12))}px`;
  }

  function resize(routes) {
    const width = Math.max(MIN_WIDTH, ...workflow.nodes.map(node => node.x + Math.max(320, elementOf(node.id).offsetWidth)));
    const height = Math.max(MIN_HEIGHT, ...workflow.nodes.map(node => node.y + Math.max(220, elementOf(node.id).offsetHeight)));
    const points = routes.flatMap(route => route.points);
    const fullWidth = Math.max(width, ...points.map(point => point.x)) + MARGIN;
    const fullHeight = Math.max(height, ...points.map(point => point.y)) + MARGIN;
    root.style.width = `${fullWidth}px`;
    root.style.height = `${fullHeight}px`;
    viewport.updateSize(fullWidth, fullHeight);
  }

  function elementOf(nodeId) {
    return root.querySelector(`[data-node="${cssId(nodeId)}"]`);
  }

  function drawEdges() {
    const svg = root.querySelector('svg.edges');
    const routes = routeEdges(measuredNodes(), workflow.edges);
    svg.innerHTML = `<defs><marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1l8 4-8 4"/></marker></defs>` + routes.map(({ edge, points, label }) => {
      const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
      const key = `${edge.from}>${edge.to}`;
      const active = selectedEdge === key ? 'selected' : '';
      return `${edge.branch ? `<text class="edge-label" x="${label.x}" y="${label.y}" text-anchor="middle">${escape(edge.branch)}</text>` : ''}<path class="edge-line ${active}" marker-end="url(#edge-arrow)" d="${path}"></path><path class="hit" d="${path}" data-edge="${escape(key)}"></path>`;
    }).join('');
    resize(routes);
    for (const hit of svg.querySelectorAll('[data-edge]')) {
      hit.addEventListener('click', event => {
        event.stopPropagation();
        handlers.onSelectEdge?.(hit.dataset.edge);
      });
    }
  }

  function measuredNodes() {
    return workflow.nodes.map(node => {
      const element = elementOf(node.id);
      return { ...node, width: element.offsetWidth, height: element.offsetHeight };
    });
  }

  function autoLayout() {
    if (!workflow?.nodes.length) {
      return false;
    }
    const positions = layoutNodes(measuredNodes(), workflow.edges);
    workflow.nodes.forEach(node => Object.assign(node, positions.get(node.id)));
    draw();
    viewport.fit();
    return true;
  }

  function startDrag(event, node, element) {
    if (event.button !== 0 || event.target.closest('button')) {
      return;
    }
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
    dragging = false;
    const move = pointer => {
      const dx = (pointer.clientX - origin.x) / viewport.scale;
      const dy = (pointer.clientY - origin.y) / viewport.scale;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        dragging = true;
      }
      node.x = Math.max(0, origin.nodeX + dx);
      node.y = Math.max(0, origin.nodeY + dy);
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
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

  // Pointer capture keeps resizing active when the handle leaves the plugin viewport.
  function startResize(event, node, element) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY, width: element.offsetWidth, height: element.offsetHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = pointer => {
      if (pointer.pointerId === event.pointerId) {
        resizeNode(node, element, origin.width + (pointer.clientX - origin.x) / viewport.scale,
          origin.height + (pointer.clientY - origin.y) / viewport.scale);
      }
    };
    const finish = pointer => {
      if (pointer.pointerId !== event.pointerId) {
        return;
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (element.offsetWidth !== origin.width || element.offsetHeight !== origin.height) {
        handlers.onResizeNode?.(node);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function resizeWithKeyboard(event, node, element) {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 50 : 10;
    resizeNode(node, element, element.offsetWidth + delta[0] * step, element.offsetHeight + delta[1] * step);
    handlers.onResizeNode?.(node);
  }

  function resizeNode(node, element, width, height) {
    node.width = Math.max(MIN_NODE_WIDTH, Math.round(width));
    node.height = Math.max(MIN_NODE_HEIGHT, Math.round(height));
    element.style.width = `${node.width}px`;
    element.style.height = `${node.height}px`;
    fitLabel(element);
    node.height = element.offsetHeight;
    drawEdges();
  }

  function updateStatus() {
    root.querySelectorAll('[data-state]').forEach(element => {
      element.innerHTML = stateHtml(statuses[element.dataset.state]);
    });
    const hint = document.querySelector('#stage-hint');
    if (hint) {
      hint.textContent = linking ? '已选择起点，点击目标节点左侧端口完成连线（点击空白处取消）。'
        : '拖拽空白处平移；Ctrl / Command + 滚轮缩放。拖拽标题移动节点，拖拽右下角调整大小；点击右侧端口，再点击目标左侧端口连线。';
      hint.classList.toggle('linking', Boolean(linking));
    }
  }

  return { mount, autoLayout };
}

const cssId = value => String(value).replace(/["\\]/g, '\\$&');
