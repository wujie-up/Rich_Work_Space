const COLUMN_GAP = 180;
const ROW_GAP = 80;
const CLEARANCE = 24;

// Back edges do not determine ranks: a return to an earlier step must not push every step into a cycle.
export function layoutNodes(nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (byId.has(edge.from) && byId.has(edge.to) && !(byId.get(edge.from).type === 'flow.loop' && edge.branch === 'continue')) {
      outgoing.get(edge.from).push(edge.to);
    }
  }
  const visited = new Set();
  const active = new Set();
  const ordered = [];
  function visit(id) {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    active.add(id);
    for (const target of outgoing.get(id)) {
      if (active.has(target)) {
        continue;
      }
      incoming.get(target).push(id);
      if (!visited.has(target)) {
        visit(target);
      }
    }
    active.delete(id);
    ordered.unshift(id);
  }
  nodes.filter(node => !edges.some(edge => edge.to === node.id)).forEach(node => visit(node.id));
  nodes.filter(node => !visited.has(node.id)).forEach(node => visit(node.id));
  const ranks = new Map();
  const layers = [];
  for (const id of ordered) {
    const rank = Math.max(0, ...incoming.get(id).map(parent => (ranks.get(parent) ?? -1) + 1));
    ranks.set(id, rank);
    (layers[rank] ||= []).push(byId.get(id));
  }
  const positions = new Map();
  const heights = layers.map(layer => layer.reduce((sum, node) => sum + node.height + ROW_GAP, -ROW_GAP));
  const maxHeight = Math.max(0, ...heights);
  const top = 80 + edges.length * 14;
  let x = 80;
  for (const [rank, layer] of layers.entries()) {
    // Order peers by their parents to keep parallel review branches together at the merge.
    const parentCenter = node => {
      const parents = incoming.get(node.id).map(id => positions.get(id)).filter(Boolean);
      return parents.length ? parents.reduce((sum, point) => sum + point.y, 0) / parents.length : nodes.indexOf(node);
    };
    layer.sort((a, b) => parentCenter(a) - parentCenter(b));
    let y = top + (maxHeight - heights[rank]) / 2;
    for (const node of layer) {
      positions.set(node.id, { x, y });
      y += node.height + ROW_GAP;
    }
    x += Math.max(...layer.map(node => node.width)) + COLUMN_GAP;
  }
  return positions;
}

export function routeEdges(nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const top = Math.min(...nodes.map(node => node.y));
  const bottom = Math.max(...nodes.map(node => node.y + node.height));
  return edges.flatMap((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      return [];
    }
    const start = { x: from.x + from.width, y: from.y + from.height / 2 };
    const end = { x: to.x, y: to.y + to.height / 2 };
    const out = { x: start.x + CLEARANCE, y: start.y };
    const entry = { x: end.x - CLEARANCE, y: end.y };
    const middle = (out.x + entry.x) / 2 + (index % 5 - 2) * 12;
    const lane = top - 40 - index * 14;
    const candidates = [
      [start, out, { x: middle, y: out.y }, { x: middle, y: entry.y }, entry, end],
      ...[...(lane >= CLEARANCE ? [lane] : []), bottom + 40 + index * 14].map(y => [start, out, { x: out.x, y }, { x: entry.x, y }, entry, end])
    ];
    const points = candidates.find(path => path.every((point, offset) => !offset || segmentClear(path[offset - 1], point, nodes)))
      || [start, ...findRoute(out, entry, nodes), end];
    const clean = simplify(points);
    const segments = clean.slice(1).map((point, offset) => ({ a: clean[offset], b: point,
      length: Math.abs(point.x - clean[offset].x) + Math.abs(point.y - clean[offset].y) }));
    const label = segments.reduce((longest, segment) => segment.length > longest.length ? segment : longest);
    return [{ edge, points: clean, label: { x: (label.a.x + label.b.x) / 2, y: (label.a.y + label.b.y) / 2 - 8 } }];
  });
}

function segmentClear(a, b, nodes) {
  return !nodes.some(node => a.y === b.y
    ? a.y > node.y && a.y < node.y + node.height && Math.max(a.x, b.x) > node.x && Math.min(a.x, b.x) < node.x + node.width
    : a.x > node.x && a.x < node.x + node.width && Math.max(a.y, b.y) > node.y && Math.min(a.y, b.y) < node.y + node.height);
}

// Manual arrangements can obstruct a column gutter; search only obstacle boundaries in that case.
function findRoute(start, end, nodes) {
  const xs = [...new Set([start.x, end.x, ...nodes.flatMap(node => [node.x - CLEARANCE, node.x + node.width + CLEARANCE])])]
    .sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...nodes.flatMap(node => [node.y - CLEARANCE, node.y + node.height + CLEARANCE])])]
    .sort((a, b) => a - b);
  const key = (x, y) => y * xs.length + x;
  const first = key(xs.indexOf(start.x), ys.indexOf(start.y));
  const target = key(xs.indexOf(end.x), ys.indexOf(end.y));
  const previous = new Map([[first, null]]);
  const queue = [first];
  for (let index = 0; index < queue.length && !previous.has(target); index++) {
    const current = queue[index];
    const x = current % xs.length;
    const y = Math.floor(current / xs.length);
    for (const [nextX, nextY] of [[x + 1, y], [x, y + 1], [x, y - 1], [x - 1, y]]) {
      if (nextX < 0 || nextX >= xs.length || nextY < 0 || nextY >= ys.length) {
        continue;
      }
      const next = key(nextX, nextY);
      if (!previous.has(next) && segmentClear({ x: xs[x], y: ys[y] }, { x: xs[nextX], y: ys[nextY] }, nodes)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  if (!previous.has(target)) {
    // Overlapping cards can enclose a port; keep the edge visible until the user separates them.
    return [start, { x: start.x, y: end.y }, end];
  }
  const points = [];
  for (let current = target; current !== null; current = previous.get(current)) {
    points.unshift({ x: xs[current % xs.length], y: ys[Math.floor(current / xs.length)] });
  }
  return points;
}

function simplify(points) {
  return points.filter((point, index) => {
    const before = points[index - 1];
    const after = points[index + 1];
    return !before || !after || !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}
