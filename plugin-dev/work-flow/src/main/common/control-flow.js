import { fail } from './errors.js';
import { stringify } from './template.js';

export const isBranch = type => ['flow.route', 'flow.loop'].includes(type);
export const isReturn = (edge, nodes) => edge.branch === 'continue' && nodes.some(node => node.id === edge.from && node.type === 'flow.loop');

export function forwardEdges(workflow) {
  return workflow.edges.filter(edge => !isReturn(edge, workflow.nodes));
}

export function descendants(edges, nodeId) {
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const id = queue.shift();
    for (const edge of edges.filter(entry => entry.from === id)) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

// Only explicit loop continue edges may go backwards; every other dependency stays a DAG.
export function executionOrder(workflow) {
  const edges = forwardEdges(workflow);
  const remaining = new Set(workflow.nodes.map(node => node.id));
  const order = [];
  while (remaining.size) {
    const ready = workflow.nodes.filter(node => remaining.has(node.id)
      && !edges.some(edge => edge.to === node.id && remaining.has(edge.from)));
    if (!ready.length) {
      throw fail('WORKFLOW_CYCLE', '工作流存在循环依赖；返回连线只能来自循环节点的 continue 分支');
    }
    for (const node of ready) {
      remaining.delete(node.id);
      order.push(node);
    }
  }
  for (const node of workflow.nodes.filter(node => isBranch(node.type))) {
    const outgoing = workflow.edges.filter(edge => edge.from === node.id);
    const labels = outgoing.map(edge => edge.branch);
    if (!outgoing.length || labels.some(label => typeof label !== 'string' || !label.trim()) || new Set(labels).size !== labels.length) {
      throw fail('INVALID_WORKFLOW', `${node.title}：分支连线必须填写不同的分支值`);
    }
    if (node.type === 'flow.loop') {
      const limit = Number(node.params.maxIterations ?? 3);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw fail('INVALID_ARGUMENT', `${node.title}：最大轮次必须为 1–100 的整数`);
      }
      const back = outgoing.find(edge => edge.branch === 'continue');
      const target = workflow.nodes.find(item => item.id === back?.to);
      if (outgoing.length !== 2 || !back || !labels.includes('exit') || back.to === node.id
        || ['flow.start', 'text.input', 'mail.fetch'].includes(target?.type) || target?.type.startsWith('message.')
        || !descendants(edges, back.to).has(node.id)) {
        throw fail('INVALID_WORKFLOW', `${node.title}：需要 continue 返回循环体和 exit 退出两条分支，返回目标必须能到达当前循环节点`);
      }
    }
  }
  for (const edge of workflow.edges) {
    const source = workflow.nodes.find(node => node.id === edge.from);
    if (edge.branch && !isBranch(source.type)) {
      throw fail('INVALID_WORKFLOW', '只有条件路由与循环节点的连线可以配置分支值');
    }
  }
  return order;
}

function condition(context) {
  const input = context.value('input');
  const raw = String(context.params.expected ?? '').trim();
  let expected = raw;
  try {
    expected = JSON.parse(raw);
  } catch (error) {
    // Plain text is a valid comparison value; JSON spelling preserves boolean and number types.
  }
  switch (context.params.operator || 'equals') {
    case 'equals': return JSON.stringify(input) === JSON.stringify(expected);
    case 'not-equals': return JSON.stringify(input) !== JSON.stringify(expected);
    case 'contains': return stringify(input).includes(String(expected));
    case 'not-empty': return input !== null && input !== undefined && stringify(input).trim() !== '';
    default: throw fail('INVALID_ARGUMENT', '未知路由条件');
  }
}

export function controlTypes() {
  const conditions = [
    { name: 'input', label: '判断值 / Agent 路由输出', kind: 'textarea', rows: 2, default: '', placeholder: '{{review.output.passed}}' },
    { name: 'operator', label: '条件', kind: 'select', default: 'equals', options: [
      { value: 'equals', label: '等于' }, { value: 'not-equals', label: '不等于' },
      { value: 'contains', label: '包含' }, { value: 'not-empty', label: '非空' }
    ] },
    { name: 'expected', label: '比较值（true / false / 数字 / 文本）', kind: 'text', default: 'true' }
  ];
  return [
    { type: 'flow.route', label: '条件路由', summary: '按条件选择 true / false 分支，或按 Agent 输出的固定分支值路由。',
      io: 'transform', kind: 'flow', role: 'step', timeoutMs: 5000,
      params: [{ name: 'mode', label: '路由方式', kind: 'select', default: 'condition', options: [
        { value: 'condition', label: '条件判断 → true / false' }, { value: 'value', label: '直接使用分支值（如 Agent 的 route）' }
      ] }, ...conditions],
      async resolve(context) {
        return { route: context.params.mode === 'value' ? stringify(context.value('input')) : String(condition(context)) };
      } },
    { type: 'flow.loop', label: '条件循环', summary: '条件满足时走 continue 返回循环体，否则走 exit；达到最大轮次后等待人工决定。',
      io: 'transform', kind: 'flow', role: 'step', timeoutMs: 5000,
      params: [...conditions, { name: 'maxIterations', label: '最大轮次（1–100，达到后等待确认）', kind: 'number', default: 3 }],
      async resolve(context) {
        return { route: condition(context) ? 'continue' : 'exit' };
      } }
  ];
}
