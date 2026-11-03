import { placeSessions, moveSession, savePositions, snapSessionSize } from './session-layout.js';

const cell = 24;
export function sessionArrangement(container, layout, save, pluginId) {
  layout.positions ||= {};
  let placed = {};
  let gesture;
  const columns = () => Math.max(1, Math.floor(container.clientWidth / cell));
  // The last card needs no trailing gutter; retain partial cells so the visible edge remains reachable.
  const boundary = () => (container.clientWidth + 12) / cell;
  // Older layouts have no viewport metadata; infer their horizontal extent before clamping cards.
  layout.columns ||= Math.max(columns(), ...Object.entries(layout.positions).map(([id, position]) =>
    position.col + Math.ceil(((layout.sizes?.[id]?.width || 0) + 12) / cell)));
  layout.viewportHeight ||= innerHeight;
  // A later drag changes the position grid, so migrate legacy size baselines independently.
  for (const size of Object.values(layout.sizes || {})) {
    size.viewportWidth ||= layout.columns * cell;
    size.viewportHeight ||= layout.viewportHeight;
  }
  const preferences = () => Object.fromEntries(Object.entries(layout.positions).map(([id, position]) =>
    [id, { ...position, col: Math.round(position.col * columns() * cell / layout.columns) / cell }]));
  function paint(draft) {
    for (const node of container.children) {
      const position = draft[node.dataset.layout || node.dataset.session];
      if (!position) { continue; }
      node.style.left = `${position.col * cell}px`;
      node.style.top = `${position.row * cell}px`;
    }
    container.style.height = `${Math.max(0, ...Object.values(draft).map(position => (position.row + position.height) * cell))}px`;
  }
  function refresh() {
    // The overlay must not move siblings or replace their normal grid dimensions.
    if (gesture || !container.clientWidth || container.querySelector('.session.maximized')) { return; }
    for (const node of container.children) {
      const size = layout.sizes?.[node.dataset.layout || node.dataset.session];
      if (size) {
        const width = Math.floor((size.width + 12) * columns() * cell / (size.viewportWidth || layout.columns * cell) / cell) * cell - 12;
        node.style.setProperty('--session-width', `${Math.max(0, width)}px`);
        node.style.setProperty('--session-height', `${Math.round(size.height * innerHeight / (size.viewportHeight || layout.viewportHeight))}px`);
      }
    }
    const items = [...container.children].filter(node => !node.hidden).map(node => ({ id: node.dataset.layout || node.dataset.session,
      width: (node.offsetWidth + 12) / cell, height: Math.ceil((node.offsetHeight + 12) / cell) }));
    placed = placeSessions(items, preferences(), boundary());
    // Anchor automatic cards once in the saved coordinate system; temporary reflow must not become the next baseline.
    for (const [id, position] of Object.entries(placed)) {
      layout.positions[id] ||= { col: position.col * layout.columns / columns(), row: position.row };
    }
    paint(placed);
  }
  const observer = new ResizeObserver(refresh);
  observer.observe(container);
  window.addEventListener('resize', refresh);
  function snapSize(node) {
    const rectangle = element => ({ left: element.offsetLeft, top: element.offsetTop,
      width: element.offsetWidth, height: element.offsetHeight });
    const original = rectangle(node);
    try {
      return snapSessionSize(original, [...container.children].filter(other => other !== node && !other.hidden).map(rectangle));
    } catch (error) {
      console.error('[session:resize-snap-failed]', { pluginId, sessionId: node.dataset.session, error: error.stack });
      return original;
    }
  }
  function bind(node, header) {
    observer.observe(node);
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button') || node.classList.contains('maximized')) { return; }
      event.preventDefault();
      gesture = { id: node.dataset.layout || node.dataset.session, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        start: placed, preview: placed, moved: false };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => {
      if (!gesture || event.pointerId !== gesture.pointerId) { return; }
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 5) { return; }
      gesture.moved = true;
      node.classList.add('dragging');
      const start = gesture.start[gesture.id];
      gesture.preview = moveSession(gesture.start, gesture.id,
        { col: start.col + Math.round(dx / cell), row: start.row + Math.round(dy / cell) }, boundary());
      paint(gesture.preview);
    });
    function finish(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) { return; }
      if (gesture.moved && event.type === 'pointerup') {
        layout.positions = savePositions(preferences(), gesture.start, gesture.preview, gesture.id);
        layout.columns = columns();
        placed = gesture.preview;
        console.info('[session:position-saved]', { pluginId, sessionId: gesture.id });
        save();
      }
      gesture = null;
      node.classList.remove('dragging');
      refresh();
    }
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) { header.addEventListener(event, finish); }
  }
  return { bind, refresh, snapSize, remove: node => observer.unobserve(node),
    dispose: () => { observer.disconnect(); window.removeEventListener('resize', refresh); } };
}
