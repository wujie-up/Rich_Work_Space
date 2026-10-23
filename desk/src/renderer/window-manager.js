import { el, ask } from './ui.js';
import { mountPluginView } from './plugin-view.js';
import { contextMenu } from './launcher.js';

// Window geometry, chrome and motion belong to the desktop; plugin state stays inside its retained frame.
export function mountWindows(stage, { openPlugin, closePlugin, changed }) {
  const windows = new Map();
  const rail = el('div', { class: 'bubble-rail', 'aria-label': '最小化的窗口' });
  stage.append(rail);
  let sequence = 0;
  let layer = 0;
  let gridSize = 24;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const isMinimized = (view) => ['minimizing', 'minimized'].includes(view.root.dataset.phase);
  const notify = () => changed([...windows.values()].filter((view) => !isMinimized(view)).sort((a, b) => b.layer - a.layer)[0]);
  const snap = (value) => Math.round(value / gridSize) * gridSize;
  const available = () => ({ width: Math.floor(stage.clientWidth / gridSize) * gridSize,
    height: Math.floor(stage.clientHeight / gridSize) * gridSize });

  function constrain(rect) {
    const limit = available();
    const width = Math.min(limit.width, Math.max(Math.min(limit.width, Math.ceil(384 / gridSize) * gridSize), snap(rect.width)));
    const height = Math.min(limit.height, Math.max(Math.min(limit.height, Math.ceil(240 / gridSize) * gridSize), snap(rect.height)));
    return { x: Math.max(0, Math.min(limit.width - width, snap(rect.x))),
      y: Math.max(0, Math.min(limit.height - height, snap(rect.y))), width, height };
  }

  function layout(view) {
    view.rect = constrain(view.rect);
    const rect = view.root.dataset.mode === 'flat'
      ? { x: 0, y: 0, width: stage.clientWidth, height: stage.clientHeight } : view.rect;
    Object.assign(view.root.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  function focus(view) {
    view.layer = ++layer;
    view.root.style.zIndex = view.layer;
    windows.forEach((item) => item.root.classList.toggle('focused', item === view));
    notify();
  }

  function settle(view) {
    view.animation?.cancel();
    view.bubbleFade?.cancel();
    view.animation = null;
    view.root.dataset.phase = isMinimized(view) ? 'minimized' : 'open';
    const hidden = isMinimized(view);
    view.root.style.visibility = hidden ? 'hidden' : 'visible';
    view.root.inert = hidden;
    view.root.setAttribute('aria-hidden', String(hidden));
    view.slot.hidden = !hidden;
    view.slot.style.opacity = '';
    if (hidden && view.root.contains(document.activeElement)) {
      view.bubble.focus({ preventScroll: true });
    }
  }

  function reflowBubbles(action) {
    const before = new Map([...rail.children].filter((slot) => !slot.hidden).map((slot) => [slot, slot.getBoundingClientRect().top]));
    action();
    if (reducedMotion.matches) {
      return;
    }
    for (const slot of rail.children) {
      const delta = before.get(slot) - slot.getBoundingClientRect().top;
      if (!slot.hidden && before.has(slot) && delta) {
        slot.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
          { duration: 380, easing: 'cubic-bezier(.22,.8,.18,1)' });
      }
    }
  }

  function travel(view, phase) {
    view.endGesture?.();
    const reversing = Boolean(view.animation);
    const from = view.root.getBoundingClientRect();
    const windowOpacity = getComputedStyle(view.root).opacity;
    const bubbleOpacity = view.slot.hidden ? 0 : Number(getComputedStyle(view.slot).opacity);
    // Sample the displayed pose before cancelling, so a quick reverse starts without a jump.
    view.animation?.cancel();
    view.bubbleFade?.cancel();
    view.root.dataset.phase = phase;
    view.root.style.visibility = 'visible';
    view.root.inert = phase === 'minimizing';
    view.root.setAttribute('aria-hidden', String(phase === 'minimizing'));
    reflowBubbles(() => { view.slot.hidden = false; });
    // Fade the entire slot so the attachment and satellites cannot outlive the bubble.
    view.slot.style.opacity = '0';
    layout(view);
    const base = view.root.getBoundingClientRect();
    // The destination is the settled rail geometry, independent of entry/stack/hover animation transforms.
    const railRect = rail.getBoundingClientRect();
    const bubble = { x: railRect.x + view.slot.offsetLeft + view.bubble.offsetLeft - rail.scrollLeft,
      y: railRect.y + view.slot.offsetTop + view.bubble.offsetTop - rail.scrollTop,
      width: view.bubble.offsetWidth, height: view.bubble.offsetHeight };
    const start = phase === 'restoring' && !reversing ? view.bubble.getBoundingClientRect() : from;
    const end = phase === 'minimizing' ? bubble : base;
    const pose = (rect) => `translate(${rect.x - base.x}px,${rect.y - base.y}px) scale(${rect.width / base.width},${rect.height / base.height})`;
    const duration = reducedMotion.matches ? 0 : 420;
    // Keep the retained content visible throughout a balanced zoom, fading only at the bubble end.
    const animation = view.root.animate([
      { transform: pose(start), opacity: phase === 'restoring' && !reversing ? 0 : windowOpacity },
      { opacity: phase === 'minimizing' ? windowOpacity : 1, offset: phase === 'minimizing' ? .8 : .2 },
      { transform: pose(end), opacity: phase === 'minimizing' ? 0 : 1 }
    ], { duration, easing: 'cubic-bezier(.42,0,.58,1)', fill: 'both' });
    view.animation = animation;
    view.bubbleFade = view.slot.animate([{ opacity: bubbleOpacity },
      { opacity: phase === 'minimizing' ? bubbleOpacity : 0, offset: phase === 'minimizing' ? .55 : .25 },
      { opacity: phase === 'minimizing' ? 1 : 0 }], { duration, fill: 'both' });
    const finish = () => {
      if (view.animation !== animation || !windows.has(view.id)) {
        return;
      }
      reflowBubbles(() => settle(view));
      if (phase === 'restoring') {
        view.header.focus({ preventScroll: true });
      }
    };
    animation.onfinish = finish;
    if (!duration) {
      finish();
    }
    console.info('[desktop:window-mode]', { pluginId: view.plugin.id, windowId: view.id, mode: phase });
    notify();
  }

  function restore(view) {
    if (!isMinimized(view) && view.root.dataset.phase !== 'restoring') {
      focus(view);
      return;
    }
    travel(view, 'restoring');
    focus(view);
  }

  function minimize(view) {
    if (!isMinimized(view)) {
      travel(view, 'minimizing');
    }
  }

  function setMode(view, mode) {
    view.endGesture?.();
    settle(view);
    view.root.dataset.mode = mode;
    view.flatButton.hidden = mode === 'flat';
    view.normalButton.hidden = mode === 'normal';
    layout(view);
    focus(view);
    console.info('[desktop:window-mode]', { pluginId: view.plugin.id, windowId: view.id, mode });
  }

  function gesture(view, event, kind) {
    if (event.button !== 0 || event.target.closest('button') && kind === 'move' || view.root.dataset.mode !== 'normal') {
      return;
    }
    event.preventDefault();
    focus(view);
    settle(view);
    const origin = { ...view.rect };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    stage.classList.add('grid-active');
    const move = (current) => {
      const dx = current.clientX - event.clientX;
      const dy = current.clientY - event.clientY;
      view.rect = constrain(kind === 'move' ? { ...origin, x: origin.x + dx, y: origin.y + dy }
        : { ...origin, width: origin.width + dx, height: origin.height + dy });
      layout(view);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      stage.classList.remove('grid-active');
      view.endGesture = null;
    };
    view.endGesture = end;
    handle.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      handle.addEventListener(type, end);
    }
  }

  // Display ordinals describe surviving windows; internal IDs remain stable for retained frames.
  function renumber() {
    [...windows.values()].forEach((view, index) => {
      const label = view.label || `${view.plugin.name} · ${index + 1}`;
      view.root.setAttribute('aria-label', label);
      view.header.setAttribute('aria-label', `移动 ${label}`);
      view.header.querySelector('span').textContent = label;
      view.bubble.title = label;
      view.bubble.setAttribute('aria-label', `恢复 ${label}`);
      view.bubble.querySelector('.bubble-number').textContent = index + 1;
    });
  }

  function close(id) {
    const view = windows.get(id);
    view.endGesture?.();
    settle(view);
    view.dispose();
    view.root.remove();
    reflowBubbles(() => view.slot.remove());
    windows.delete(id);
    renumber();
    console.info('[desktop:close]', { pluginId: view.plugin.id, windowId: id });
    notify();
  }

  function open(plugin) {
    const id = String(++sequence);
    const label = `${plugin.name} · ${windows.size + 1}`;
    const root = el('section', { class: 'application-window', 'data-window': id, 'data-mode': 'normal', 'data-phase': 'open',
      role: 'region', 'aria-label': label });
    const body = el('div', { class: 'window-body' });
    const header = el('div', { class: 'window-title', tabindex: 0, 'aria-label': `移动 ${label}` }, el('span', { text: label }));
    const control = (text, title, action) => el('button', { text, title, 'aria-label': title, onclick: action });
    const view = { id, plugin, root, body, header, layer: 0 };
    // Renaming only changes shell chrome; the sandbox frame and live tasks stay mounted.
    const rename = async () => {
      const name = await ask('修改窗口名称', root.getAttribute('aria-label'));
      if (name?.trim()) {
        view.label = name.trim();
        renumber();
        console.info('[desktop:rename]', { pluginId: plugin.id, windowId: id, name: view.label });
      }
    };
    header.title = '右键修改窗口名称';
    header.addEventListener('contextmenu', (event) => contextMenu(event, [['修改名称', rename]]));
    const resize = el('div', { class: 'window-resize', role: 'button', tabindex: 0, 'aria-label': '调整窗口大小' });
    view.flatButton = control('↗', '平铺到桌面', () => setMode(view, 'flat'));
    view.normalButton = control('▣', '普通窗口', () => setMode(view, 'normal'));
    view.normalButton.hidden = true;
    header.append(el('div', { class: 'window-actions' }, control('−', '最小化', () => minimize(view)),
      view.flatButton, view.normalButton, control('×', '关闭窗口', () => closePlugin(plugin.id))));
    header.addEventListener('pointerdown', (event) => gesture(view, event, 'move'));
    header.addEventListener('dblclick', (event) => {
      if (!event.target.closest('button')) {
        setMode(view, root.dataset.mode === 'normal' ? 'flat' : 'normal');
      }
    });
    header.addEventListener('keydown', (event) => keyboard(view, event, 'move'));
    resize.addEventListener('pointerdown', (event) => gesture(view, event, 'resize'));
    resize.addEventListener('keydown', (event) => keyboard(view, event, 'resize'));
    root.addEventListener('pointerdown', () => focus(view));
    // Pointer events inside a sandbox frame do not bubble into its desktop wrapper.
    root.addEventListener('focusin', () => focus(view));
    root.append(header, body, resize);
    stage.append(root);
    view.bubble = el('button', { class: 'session-bubble', 'data-plugin': plugin.id, 'data-window': id,
      title: label, 'aria-label': `恢复 ${label}`, onclick: () => restore(view) },
    el('span', { class: 'bubble-symbol', text: '⌘', 'aria-hidden': true }),
    el('span', { class: 'bubble-number', text: windows.size + 1, 'aria-hidden': true }), el('i', { class: 'bubble-satellites', 'aria-hidden': true }));
    view.bubble.addEventListener('contextmenu', (event) => contextMenu(event, [['打开', () => restore(view)],
      ['新建窗口', () => openPlugin(plugin.id)], ['修改名称', rename], ['关闭窗口', () => closePlugin(plugin.id)]]));
    view.slot = el('div', { class: 'bubble-slot', hidden: true }, view.bubble);
    rail.append(view.slot);
    view.rect = constrain({ x: 72 + (sequence - 1) % 5 * 24, y: 48 + (sequence - 1) % 5 * 24,
      width: stage.clientWidth - 168, height: stage.clientHeight - 120 });
    windows.set(id, view);
    layout(view);
    view.dispose = mountPluginView(body, plugin, plugin.views[0], { focused: () => {
      if (!isMinimized(view)) {
        focus(view);
      }
    } });
    focus(view);
    console.info('[desktop:open]', { pluginId: plugin.id, windowId: id });
  }

  function keyboard(view, event, kind) {
    const delta = { ArrowLeft: [-gridSize, 0], ArrowRight: [gridSize, 0], ArrowUp: [0, -gridSize], ArrowDown: [0, gridSize] }[event.key];
    if (!delta || event.target !== event.currentTarget || view.root.dataset.mode !== 'normal') {
      return;
    }
    event.preventDefault();
    const [dx, dy] = delta;
    view.rect = constrain(kind === 'move' ? { ...view.rect, x: view.rect.x + dx, y: view.rect.y + dy }
      : { ...view.rect, width: view.rect.width + dx, height: view.rect.height + dy });
    layout(view);
  }

  function setGridSize(value) {
    gridSize = value;
    stage.style.setProperty('--grid-size', `${value}px`);
    for (const view of windows.values()) {
      view.endGesture?.();
      settle(view);
      layout(view);
    }
  }
  new ResizeObserver(() => {
    for (const view of windows.values()) {
      settle(view);
      layout(view);
    }
  }).observe(stage);
  reducedMotion.addEventListener('change', () => windows.forEach(settle));
  setGridSize(gridSize);
  return { windows, open, close, home: () => windows.forEach(minimize), setGridSize };
}
