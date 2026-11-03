import { fail } from './errors.js';

// Explicit boundaries keep the existing serial scheduler unchanged outside a parallel review group.
export function parallelGroup(workflow, node) {
  const branches = workflow.edges.filter(edge => edge.from === node.id).map(edge => workflow.nodes.find(item => item.id === edge.to));
  const join = workflow.nodes.find(item => item.id === node.params.joinNodeId && item.type === 'flow.join');
  const valid = join && branches.length >= 2 && branches.every(branch => branch.type === 'agent.review'
    && workflow.edges.filter(edge => edge.to === branch.id).length === 1
    && workflow.edges.filter(edge => edge.from === branch.id).length === 1
    && workflow.edges.some(edge => edge.from === branch.id && edge.to === join.id))
    && workflow.edges.filter(edge => edge.to === join.id).length === branches.length;
  if (!valid) {
    throw fail('INVALID_WORKFLOW', `${node.title || node.id}：至少连接两个独立 Agent 节点，每个分支须直接连接到指定的同一汇合节点`);
  }
  return { branches, join };
}

export function parallelTypes() {
  return [
    { type: 'flow.parallel', label: '并行评审', summary: '同时启动相邻的多个 Agent；每个分支直接连接同一汇合节点。',
      io: 'transform', kind: 'flow', role: 'step', timeoutMs: 5000,
      params: [{ name: 'joinNodeId', label: '汇合节点 ID', kind: 'text', default: '' }],
      async resolve() { return { parallel: true }; } },
    { type: 'flow.join', label: '全员汇合', summary: '等待并行组内全部 Agent 成功后汇总结果；失败或停止时不继续下游。',
      io: 'transform', kind: 'flow', role: 'step', timeoutMs: 5000, params: [],
      async resolve(context) {
        return { results: Object.fromEntries(context.parents.map(parent => [parent.nodeId, parent.output])) };
      } }
  ];
}
