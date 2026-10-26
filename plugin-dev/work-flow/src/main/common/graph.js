// Node categories come from the registry; storage and canvas apply the same rules so a flow stays well formed.
export const IO_TAGS = ['source', 'transform', 'sink'];
export const KIND_TAGS = ['text', 'extract', 'route', 'invoke', 'output', 'flow'];
export const ROLE_TAGS = ['start', 'step', 'end'];

// issue blocks saving, warning is a compat hint for flows built before start and end nodes existed.
export function graphIssues({ nodes, edges, classify }) {
  const issues = [];
  const warnings = [];
  const meta = new Map(nodes.map(node => [node.id, classify(node.type) || {}]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    incoming.get(edge.to)?.push(edge.from);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const roleOf = id => meta.get(id)?.role;
  for (const node of nodes) {
    const tag = meta.get(node.id);
    const name = node.title || tag.label || node.type;
    const parents = incoming.get(node.id);
    if (tag.role === 'start' && parents.length) {
      issues.push(`${name}：开始节点不能有上游`);
    }
    // An input node takes no data from upstream, but it may follow the start node as a control-flow entry.
    if (tag.io === 'source' && parents.some(parent => roleOf(parent) !== 'start')) {
      issues.push(`${name}：输入节点只能接在开始节点之后`);
    }
    if ((tag.role === 'end' || tag.io === 'sink') && outgoing.get(node.id).length) {
      issues.push(`${name}：${tag.role === 'end' ? '终止节点' : '输出节点'}不能有下游`);
    }
    if ((tag.io === 'transform' || tag.io === 'sink') && !parents.length) {
      issues.push(`${name}：需要上游输入，请先连线`);
    }
  }
  if (!nodes.some(node => meta.get(node.id)?.role === 'start')) {
    warnings.push('缺少开始节点，运行时将按“无上游的节点”推断入口（旧工作流兼容）');
  }
  if (!nodes.some(node => meta.get(node.id)?.role === 'end')) {
    warnings.push('缺少终止节点，建议补一个终止或输出节点作为流程终点');
  }
  return { issues, warnings };
}
