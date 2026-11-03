// Share the kettle silhouette so only heat and steam change with the session state.
const kettle = `<g class="kettle-body">
    <path d="M23 23h17l5 13q2 6-5 6H23q-7 0-5-6l2-6-9-8h10"/>
    <path d="M42 26h5a5 5 0 0 1 0 10h-2"/>
  </g>
  <g class="kettle-lid"><path d="M21 23h21m-17-3q7-5 13 0m-7-4v-2h3v2"/></g>`;
const water = '<path class="kettle-water" d="M24 35h14"/>';
const drawings = {
  working: `<g transform="translate(0 -6)">${kettle}<path class="kettle-water" d="M24 35q3-2 7 0t7 0"/></g>
    <g class="kettle-heat">
      <path d="M24 46c-5 0-3-5 0-8 0 4 5 8 0 8Z"/>
      <path d="M32 46c-6 0-4-6 0-10 0 5 6 10 0 10Z"/>
      <path d="M40 46c-5 0-3-5 0-8 0 4 5 8 0 8Z"/>
    </g>`,
  waiting: `${kettle}${water}<path d="M20 45h23" opacity=".3"/>`,
  blocked: `${kettle}<path class="kettle-water" d="M24 35q3-3 7 0t7 0"/>
    <path class="kettle-steam" d="M23 13c-4-4 4-5 0-9"/>
    <path class="kettle-steam" d="M31 11c-4-4 4-5 0-9"/>
    <path class="kettle-steam" d="M39 13c-4-4 4-5 0-9"/>`,
  offline: `${kettle}${water}<g class="kettle-plug"><path d="M44 43h5l3-4m0-2 5 5m-3-7 2-2m1 5 2-2M58 27l-5 5"/></g>`,
  unknown: '<circle cx="16" cy="16" r="10"/><path d="M16 10v7m0 5h.01"/>'
};

// One SVG per transition keeps streaming output from restarting animations or replacing terminal nodes.
export function sessionStatus(node, state, label) {
  const kind = state === 'offline' ? 'offline' : state === 'working' ? 'working' : state === 'blocked' ? 'blocked'
    : ['idle', 'done'].includes(state) ? 'waiting' : 'unknown';
  if (node.dataset.kind !== kind) {
    node.innerHTML = `<svg viewBox="0 0 ${kind === 'unknown' ? '32 34' : '64 48'}" aria-hidden="true">${drawings[kind]}</svg>`;
    node.dataset.kind = kind;
  }
  node.dataset.state = state;
  node.setAttribute('aria-label', label);
  node.title = label;
}
