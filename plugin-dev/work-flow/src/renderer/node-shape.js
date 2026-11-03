// Shapes keep their left/right midpoint on the existing ports, preserving edge routing when resized.
export function nodeShape(type = {}) {
  if (['start', 'end'].includes(type.role)) { return 'terminal'; }
  if (type.type === 'flow.user-input') { return 'interaction'; }
  return { flow: 'route', input: 'input', output: 'document', invoke: 'agent' }[type.kind] || 'process';
}

export function shapeOutline(shape) {
  const paths = {
    route: 'M50 1L99 50 50 99 1 50Z',
    input: 'M12 1H99V88L88 99H1V12Z',
    document: 'M1 1H99V88Q75 75 50 88T1 88Z',
    interaction: 'M1 14 14 1H86L99 14V99H1Z',
    terminal: 'M24 1H76Q99 1 99 25V75Q99 99 76 99H24Q1 99 1 75V25Q1 1 24 1Z',
    agent: 'M9 1H91Q99 1 99 9V91Q99 99 91 99H9Q1 99 1 91V9Q1 1 9 1Z',
    process: 'M1 1H99V99H1Z'
  };
  return `<svg class="node-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${paths[shape]}"/></svg>`;
}
