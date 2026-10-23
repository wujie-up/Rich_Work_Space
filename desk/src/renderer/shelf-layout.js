// Keep launcher placement separate from plugin windows and their lifecycle.
export function mountShelfLayout(shelf) {
  let positions;
  try {
    const saved = localStorage.getItem('plugin-shelf-fine-layout');
    // Keep the original layout intact while mapping its larger cells to the finer grid.
    positions = saved ? JSON.parse(saved) : Object.fromEntries(
      Object.entries(JSON.parse(localStorage.getItem('plugin-shelf-layout') || '{}')).map(([id, position]) => [id,
        { col: position.col * 2, row: position.row * (shelf.dataset.names === 'hidden' ? 2 : 3), span: position.span * 2 }]));
  } catch (error) {
    console.error('[shelf:layout-read]', error);
    positions = {};
  }
  let gesture;
  let placed = new Map();

  function geometry() {
    const size = Number.parseFloat(getComputedStyle(shelf).getPropertyValue('--shelf-icon-size')) || 36;
    const width = Math.max(size + 8, shelf.clientWidth - 8);
    const columns = Math.max(2, Math.floor((width + 4) / ((size + 12) / 2)));
    const column = (width + 4) / columns;
    return { size, columns, column, row: column };
  }

  function layout(preview, priority) {
    const grid = geometry();
    const nodes = [...shelf.children];
    const occupied = new Set();
    placed = new Map();
    shelf.style.gridTemplateColumns = `repeat(${grid.columns},minmax(0,1fr))`;
    shelf.style.gap = '4px';
    shelf.style.gridAutoRows = `${grid.row - 4}px`;
    shelf.style.setProperty('--shelf-cell-width', `${grid.column}px`);
    shelf.style.setProperty('--shelf-cell-height', `${grid.row}px`);
    const labelRows = shelf.dataset.names === 'hidden' ? 0 : 1;
    const fits = (col, row, span) => Array.from({ length: span + labelRows }, (_, y) =>
      Array.from({ length: span }, (_, x) => !occupied.has(`${col + x}:${row + y}`))).flat().every(Boolean);
    // Explicit placements claim cells first; automatic icons fill the remaining spaces.
    const savedOrder = Object.keys(positions);
    const ordered = [...nodes].sort((a, b) => Number(b.dataset.plugin === priority) - Number(a.dataset.plugin === priority)
      || Number(Boolean(positions[b.dataset.plugin])) - Number(Boolean(positions[a.dataset.plugin]))
      || savedOrder.indexOf(a.dataset.plugin) - savedOrder.indexOf(b.dataset.plugin));
    for (const node of ordered) {
      const id = node.dataset.plugin;
      const saved = id === priority ? preview : positions[id];
      const span = Math.max(2, Math.min(grid.columns, saved?.span || 2));
      let col = Math.max(0, Math.min(grid.columns - span, saved?.col || 0));
      let row = Math.max(0, saved?.row || 0);
      while (!fits(col, row, span)) {
        col++;
        if (col + span > grid.columns) {
          col = 0;
          row++;
        }
      }
      for (let y = row; y < row + span + labelRows; y++) {
        for (let x = col; x < col + span; x++) {
          occupied.add(`${x}:${y}`);
        }
      }
      placed.set(id, { col, row, span });
      node.style.gridArea = `${row + 1}/${col + 1}/span ${span + labelRows}/span ${span}`;
      node.style.setProperty('--shelf-item-size', `${grid.size + (span - 2) * grid.column}px`);
    }
  }

  // Persist only the edited icon; narrow viewport adaptations must not replace other preferred placements.
  function save(id, position) {
    positions = Object.fromEntries([[id, position], ...Object.entries(positions).filter(([key]) => key !== id)]);
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(positions));
    console.info('[shelf:layout-save]', { pluginId: id, ...position });
  }

  function finish(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    const current = gesture;
    gesture = null;
    shelf.classList.remove('shelf-arranging');
    if (current.moved && event.type === 'pointerup') {
      const position = placed.get(current.id);
      save(current.id, { ...position, span: current.resize ? position.span : positions[current.id]?.span || position.span });
    }
    layout();
  }

  function bind(node) {
    const handle = document.createElement('span');
    handle.className = 'shelf-icon-resize';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', '调整图标大小');
    handle.tabIndex = 0;
    node.append(handle);
    // A completed drag emits click too; consume it before the launcher opens a window.
    let suppressClick = false;
    node.addEventListener('click', event => {
      if (suppressClick || event.target === handle) {
        event.stopImmediatePropagation();
        event.preventDefault();
        suppressClick = false;
      }
    }, true);
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0) {
        return;
      }
      suppressClick = false;
      gesture = { id: node.dataset.plugin, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        start: placed.get(node.dataset.plugin), resize: event.target === handle, moved: false };
      node.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    node.addEventListener('pointermove', event => {
      if (!gesture || gesture.id !== node.dataset.plugin) {
        return;
      }
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 5) {
        return;
      }
      gesture.moved = true;
      suppressClick = true;
      shelf.classList.add('shelf-arranging');
      const grid = geometry();
      const { col, row, span } = gesture.start;
      const next = gesture.resize
        ? { col, row, span: Math.max(2, Math.min(grid.columns - col, span + Math.round(Math.max(dx / grid.column, dy / grid.row)))) }
        : { col: Math.max(0, Math.min(grid.columns - span, col + Math.round(dx / grid.column))),
          row: Math.max(0, row + Math.round(dy / grid.row)), span };
      layout(next, gesture.id);
    });
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
    node.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const id = node.dataset.plugin;
      const current = placed.get(id);
      const span = Math.max(2, Math.min(geometry().columns - current.col,
        current.span + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1)));
      layout({ ...current, span }, id);
      save(id, placed.get(id));
    });
  }

  new ResizeObserver(() => layout()).observe(shelf);
  return { bind, layout: () => layout() };
}
