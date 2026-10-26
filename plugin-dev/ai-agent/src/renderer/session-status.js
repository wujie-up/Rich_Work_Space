const drawings = {
  working: '<rect x="2" y="11" width="28" height="16" rx="3"/><path d="M6 16h2m3 0h2m3 0h2m3 0h3M7 21h2m3 0h2m3 0h2m3 0h2M10 24h12"/><path class="typing" d="M7 3v5m9-6v6m9-5v5"/>',
  waiting: '<path d="M6 15h18v9a5 5 0 0 1-5 5h-8a5 5 0 0 1-5-5zm18 1h2a4 4 0 0 1 0 8h-2M3 30h24"/><path class="steam" d="M10 12c-5-4 5-5 0-10m6 10c-5-4 5-5 0-10m6 10c-5-4 5-5 0-10"/>',
  blocked: '<path d="M8 15 4 27a2 2 0 0 0 2 3h20a2 2 0 0 0 2-3l-4-12M11 14v4m10-4v4"/><circle cx="16" cy="23" r="4"/><path class="ringing" d="M5 11V8c0-5 22-5 22 0v3h-7V8h-8v3z"/><path class="ring-lines" d="m2 3 2 2m26-2-2 2M1 8h2m26 0h2"/>',
  unknown: '<circle cx="16" cy="16" r="10"/><path d="M16 10v7m0 5h.01"/>'
};

// One SVG per transition keeps streaming output from restarting animations or replacing terminal nodes.
export function sessionStatus(node, state, label) {
  const kind = state === 'working' ? 'working' : state === 'blocked' ? 'blocked'
    : ['idle', 'done'].includes(state) ? 'waiting' : 'unknown';
  if (node.dataset.kind !== kind) {
    node.innerHTML = `<svg viewBox="0 0 32 34" aria-hidden="true">${drawings[kind]}</svg>`;
    node.dataset.kind = kind;
  }
  node.dataset.state = state;
  node.setAttribute('aria-label', label);
  node.title = label;
}
