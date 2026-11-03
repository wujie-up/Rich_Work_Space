// Waiting for a person is distinct from executing; parallel branches may still be doing Agent work.
export function workflowActivity(run) {
  if (!run) { return null; }
  if (run?.status === 'running') { return 'running'; }
  if (run?.status !== 'waiting') { return null; }
  const pending = run.pending;
  if (pending?.kind === 'service') {
    const tasks = pending.tasks || (pending.interaction ? [] : [pending.task || {}]);
    if (tasks.some(task => !task.requests?.length && !['succeeded', 'failed', 'canceled', 'cancelled'].includes(task.state))) {
      return 'agent';
    }
  }
  return 'waiting';
}

// A working sibling must not hide the fact that another branch needs a human decision.
export function workflowActivityInfo(run) {
  const state = workflowActivity(run);
  if (!state) { return null; }
  const pending = run.pending;
  const waiting = pending?.interaction || pending?.tasks?.some(task => task.requests?.length);
  const label = { running: '流程运行中', agent: 'Agent 处理中', waiting: '等待用户确认' }[state];
  return { state, label: state === 'agent' && waiting ? `${label} · 等待用户确认` : label };
}
