import { message } from './i18n.js';
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
    const rows = Math.max(0, Math.floor((shelf.clientHeight - 12) / column));
    return { size, columns, rows, column, row: column };
  }

  // Resolve each preview from pointer-down positions so hovering cannot cascade through the shelf.
  function movePreview(next) {
    const grid = geometry();
    const labelRows = shelf.dataset.names === 'hidden' ? 0 : 1;
    const overlaps = (a, b) => a.col < b.col + b.span && b.col < a.col + a.span
      && a.row < b.row + b.span + labelRows && b.row < a.row + a.span + labelRows;
    const draft = new Map(gesture.placements);
    const direction = next.col < gesture.start.col ? -1 : 1;
    const forwardOrder = ([, a], [, b]) => direction * (a.row - b.row || a.col - b.col);
    const pending = [...draft].filter(([id, position]) => id !== gesture.id && overlaps(next, position)).sort(forwardOrder);
    draft.set(gesture.id, next);
    pending.forEach(([id]) => draft.delete(id));
    const settled = new Set([gesture.id]);
    // Only direct collisions propagate; edge crossings continue on the adjacent icon row.
    while (pending.length) {
      const [id, position] = pending.shift();
      const candidate = { ...position, col: position.col + direction };
      while (true) {
        if (candidate.col + candidate.span > grid.columns) {
          candidate.col = 0;
          candidate.row += candidate.span + labelRows;
        } else if (candidate.col < 0) {
          candidate.col = grid.columns - candidate.span;
          candidate.row -= candidate.span + labelRows;
        }
        // Reject the whole chain when it cannot fit on screen; never push a neighbor out of reach.
        if (candidate.row < 0 || candidate.row + candidate.span + labelRows > grid.rows) {
          return gesture.placements;
        }
        if (![...draft].some(([key, other]) => settled.has(key) && overlaps(candidate, other))) {
          break;
        }
        candidate.col += direction;
      }
      const displaced = [...draft].filter(([key, other]) => !settled.has(key) && overlaps(candidate, other)).sort(forwardOrder);
      displaced.forEach(([key]) => draft.delete(key));
      pending.push(...displaced);
      draft.set(id, candidate);
      settled.add(id);
    }
    return draft;
  }

  function layout(preview, priority, draft) {
    const grid = geometry();
    const nodes = [...shelf.children];
    const occupied = new Set();
    const previous = placed;
    placed = new Map();
    shelf.style.gridTemplateColumns = `repeat(${grid.columns},minmax(0,1fr))`;
    shelf.style.gap = '4px';
    shelf.style.gridAutoRows = `${grid.row - 4}px`;
    shelf.style.setProperty('--shelf-cell-width', `${grid.column}px`);
    shelf.style.setProperty('--shelf-cell-height', `${grid.row}px`);
    const labelRows = shelf.dataset.names === 'hidden' ? 0 : 1;
    const fits = (col, row, span) => row + span + labelRows <= grid.rows
      && Array.from({ length: span + labelRows }, (_, y) =>
        Array.from({ length: span }, (_, x) => !occupied.has(`${col + x}:${row + y}`))).flat().every(Boolean);
    // Explicit placements claim cells first; automatic icons fill the remaining spaces.
    const savedOrder = Object.keys(positions);
    const ordered = [...nodes].sort((a, b) => Number(a.dataset.plugin === priority) - Number(b.dataset.plugin === priority)
      || Number(Boolean(positions[b.dataset.plugin])) - Number(Boolean(positions[a.dataset.plugin]))
      || savedOrder.indexOf(a.dataset.plugin) - savedOrder.indexOf(b.dataset.plugin));
    for (const node of ordered) {
      const id = node.dataset.plugin;
      if ((draft && !draft.has(id)) || (priority && !previous.has(id))) {
        node.hidden = true;
        continue;
      }
      const saved = draft ? draft.get(id) : id === priority ? preview : priority ? previous.get(id) : positions[id];
      let span = Math.max(2, Math.min(grid.columns, grid.rows - labelRows, saved?.span || 2));
      let col = Math.max(0, Math.min(grid.columns - span, saved?.col || 0));
      let row = Math.max(0, Math.min(grid.rows - span - labelRows, saved?.row || 0));
      // Resizing reserves neighbors; moving uses the collision preview instead.
      if (id === priority && !fits(col, row, span)) {
        ({ col, row, span } = previous.get(id));
      }
      let remaining = grid.columns * grid.rows;
      while (!fits(col, row, span) && remaining > 0) {
        col++;
        if (col + span > grid.columns) {
          col = 0;
          row++;
        }
        if (row + span + labelRows > grid.rows) {
          row = 0;
        }
        remaining--;
      }
      // Temporary viewport limits must not overwrite the user's preferred positions.
      node.hidden = !fits(col, row, span);
      if (node.hidden) {
        continue;
      }
      for (let y = row; y < row + span + labelRows; y++) {
        for (let x = col; x < col + span; x++) {
          occupied.add(`${x}:${y}`);
        }
      }
      placed.set(id, { col, row, span });
      const before = draft && id !== gesture.id ? node.getBoundingClientRect() : null;
      node.style.gridArea = `${row + 1}/${col + 1}/span ${span + labelRows}/span ${span}`;
      node.style.setProperty('--shelf-item-size', `${grid.size + (span - 2) * grid.column}px`);
      if (before && JSON.stringify(previous.get(id)) !== JSON.stringify(placed.get(id))
        && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        node.getAnimations().forEach(animation => animation.cancel());
        const after = node.getBoundingClientRect();
        node.animate([{ transform: `translate(${before.x - after.x}px,${before.y - after.y}px)` }, { transform: 'translate(0,0)' }],
          { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' });
      }
    }
  }

  // Pin automatic neighbors once; preserve saved preferences when the shelf temporarily narrows.
  function save(id, position) {
    for (const [key, placement] of placed) {
      positions[key] ||= placement;
    }
    positions[id] = position;
    localStorage.setItem('plugin-shelf-fine-layout', JSON.stringify(positions));
    console.info('[shelf:layout-save]', { pluginId: id, ...position });
  }

  function finish(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    const current = gesture;
    gesture = null;
    if (event.type !== 'pointerup') {
      [...shelf.children].forEach(node => node.getAnimations().forEach(animation => animation.cancel()));
    }
    shelf.classList.remove('shelf-arranging');
    if (current.moved && event.type === 'pointerup') {
      // Commit only participating icons; temporary viewport clamping keeps its original preference.
      for (const [id, position] of placed) {
        const original = current.placements.get(id);
        if (id !== current.id && (position.col !== original.col || position.row !== original.row)) {
          positions[id] = { ...position, span: positions[id]?.span || position.span };
        }
      }
      const position = placed.get(current.id);
      save(current.id, { ...position, span: current.resize ? position.span : positions[current.id]?.span || position.span });
    }
    layout();
  }

  function bind(node) {
    const handle = document.createElement('span');
    handle.className = 'shelf-icon-resize';
    handle.setAttribute('role', 'button');
    message(handle, '调整图标大小', 'aria-label');
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
        placements: new Map(placed), start: placed.get(node.dataset.plugin), resize: event.target === handle, moved: false };
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
      const labelRows = shelf.dataset.names === 'hidden' ? 0 : 1;
      const next = gesture.resize
        ? { col, row, span: Math.max(2, Math.min(grid.columns - col, grid.rows - row - labelRows,
          span + Math.round(Math.max(dx / grid.column, dy / grid.row)))) }
        : { col: Math.max(0, Math.min(grid.columns - span, col + Math.round(dx / grid.column))),
          row: Math.max(0, Math.min(grid.rows - span - labelRows, row + Math.round(dy / grid.row))), span };
      if (gesture.resize) {
        layout(next, gesture.id);
      } else {
        layout(undefined, undefined, movePreview(next));
      }
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
      const grid = geometry();
      const labelRows = shelf.dataset.names === 'hidden' ? 0 : 1;
      const span = Math.max(2, Math.min(grid.columns - current.col, grid.rows - current.row - labelRows,
        current.span + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1)));
      layout({ ...current, span }, id);
      save(id, placed.get(id));
    });
  }

  new ResizeObserver(() => layout()).observe(shelf);
  return { bind, layout: () => layout() };
}
