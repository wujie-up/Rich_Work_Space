const overlaps = (a, b) => a.col < b.col + b.width && b.col < a.col + a.width
  && a.row < b.row + b.height && b.row < a.row + a.height;

// Prefer nearby card edges over grid rounding so a small resize keeps rows and columns aligned.
export function snapSessionSize(rectangle, neighbors) {
  const snap = (value, targets) => {
    const closest = targets.filter(target => target > 0 && Math.abs(target - value) <= 12)
      .sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0];
    return closest ?? Math.round((value + 12) / 24) * 24 - 12;
  };
  return {
    width: snap(rectangle.width, neighbors.flatMap(other => [other.width,
      other.left + other.width - rectangle.left, other.left - 12 - rectangle.left])),
    height: snap(rectangle.height, neighbors.flatMap(other => [other.height,
      other.top + other.height - rectangle.top, other.top - 12 - rectangle.top]))
  };
}

export function placeSessions(items, preferences, columns, previous = {}) {
  const placed = {};
  // Reflow in visual order, including automatic cards; saved positions remain the baseline when cards shrink again.
  const anchors = { ...previous, ...preferences };
  const ordered = [...items].sort((a, b) => Number(!!anchors[b.id]) - Number(!!anchors[a.id])
    || (anchors[a.id]?.row || 0) - (anchors[b.id]?.row || 0)
    || (anchors[a.id]?.col || 0) - (anchors[b.id]?.col || 0));
  for (const item of ordered) {
    const width = Math.min(columns, item.width);
    const saved = anchors[item.id];
    const position = { col: Math.max(0, Math.min(columns - width, saved?.col || 0)),
      row: Math.max(0, saved?.row || 0), width, height: item.height };
    while (Object.values(placed).some(other => overlaps(position, other))) {
      // Saved columns remain stable during resizing; only new cards search horizontally for a free cell.
      if (saved) {
        position.row++;
        continue;
      }
      position.col++;
      if (position.col + width > columns) { position.col = 0; position.row++; }
    }
    placed[item.id] = position;
  }
  return placed;
}

export function moveSession(start, id, target, columns) {
  const draft = Object.fromEntries(Object.entries(start).map(([key, position]) => [key, { ...position }]));
  const moving = draft[id];
  const direction = target.col < moving.col ? -1 : 1;
  Object.assign(moving, { col: Math.max(0, Math.min(columns - moving.width, target.col)), row: Math.max(0, target.row) });
  const settled = new Set([id]);
  const pending = Object.entries(draft).filter(([key, position]) => key !== id && overlaps(moving, position));
  for (const [key] of pending) { delete draft[key]; }
  // Resolve each preview from the original snapshot, as the desktop shelf does.
  while (pending.length) {
    const [key, original] = pending.shift();
    const position = { ...original };
    do {
      position.col += direction;
      if (position.col + position.width > columns) { position.col = 0; position.row += position.height; }
      if (position.col < 0) { position.col = columns - position.width; position.row -= position.height; }
      if (position.row < 0) { return start; }
    } while (Object.entries(draft).some(([other, rectangle]) => settled.has(other) && overlaps(position, rectangle)));
    const displaced = Object.entries(draft).filter(([other, rectangle]) => !settled.has(other) && overlaps(position, rectangle));
    for (const [other] of displaced) { delete draft[other]; }
    pending.push(...displaced);
    draft[key] = position;
    settled.add(key);
  }
  return draft;
}

export function savePositions(preferences, start, preview, movingId) {
  const saved = { ...preferences };
  for (const [id, position] of Object.entries(preview)) {
    const original = start[id];
    saved[id] ||= { col: original.col, row: original.row };
    if (id === movingId || position.col !== original.col || position.row !== original.row) {
      saved[id] = { col: position.col, row: position.row };
    }
  }
  return saved;
}
