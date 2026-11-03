import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutNodes, routeEdges } from '../src/renderer/canvas-layout.js';

const node = (id, width = 210, height = 130, type = 'agent.task') => ({ id, type, x: 0, y: 0, width, height, params: {} });
const graph = () => ({ nodes: [node('requirements'), node('design', 360), node('product'), node('developer', 280, 240),
  node('tester'), node('review'), node('code'), node('test'), node('retry', 210, 130, 'flow.loop'), node('acceptance')],
  edges: [['requirements', 'design'], ['design', 'product'], ['design', 'developer'], ['design', 'tester'],
    ['product', 'review'], ['developer', 'review'], ['tester', 'review'], ['review', 'code'], ['code', 'test'],
    ['test', 'retry'], ['retry', 'code', 'continue'], ['retry', 'acceptance', 'exit']]
    .map(([from, to, branch]) => ({ from, to, ...(branch ? { branch } : {}) })) });

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function assertClearRoutes(workflow) {
  const routes = routeEdges(workflow.nodes, workflow.edges);
  assert.equal(routes.length, workflow.edges.length);
  for (const { points } of routes) {
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      assert.ok(a.x === b.x || a.y === b.y, '连线使用正交路径');
      for (const rect of workflow.nodes) {
        const horizontal = a.y === b.y && a.y > rect.y && a.y < rect.y + rect.height
          && Math.max(a.x, b.x) > rect.x && Math.min(a.x, b.x) < rect.x + rect.width;
        const vertical = a.x === b.x && a.x > rect.x && a.x < rect.x + rect.width
          && Math.max(a.y, b.y) > rect.y && Math.min(a.y, b.y) < rect.y + rect.height;
        assert.ok(!horizontal && !vertical, `连线不能穿过节点 ${rect.id}`);
      }
    }
  }
}

test('研发分支和汇合分层布局，保留尺寸、参数和连线，重复布局结果稳定', () => {
  const workflow = graph();
  const original = structuredClone(workflow);
  const positions = layoutNodes(workflow.nodes, workflow.edges);
  workflow.nodes.forEach(item => Object.assign(item, positions.get(item.id)));
  for (const [index, item] of workflow.nodes.entries()) {
    for (const other of workflow.nodes.slice(index + 1)) {
      assert.ok(!overlaps(item, other), `${item.id} 和 ${other.id} 不重叠`);
    }
    assert.equal(item.width, original.nodes[index].width);
    assert.deepEqual(item.params, original.nodes[index].params);
  }
  for (const edge of workflow.edges.filter(item => item.branch !== 'continue')) {
    const from = workflow.nodes.find(item => item.id === edge.from);
    const to = workflow.nodes.find(item => item.id === edge.to);
    assert.ok(to.x > from.x + from.width, `${edge.from} → ${edge.to} 从左到右`);
  }
  assert.deepEqual(layoutNodes(workflow.nodes, workflow.edges), positions);
  assert.deepEqual(workflow.edges, original.edges);
  assertClearRoutes(workflow);
});

test('孤立节点、空画布和未完成的循环草稿可以布局', () => {
  assert.equal(layoutNodes([], []).size, 0);
  assert.deepEqual(routeEdges([], []), []);
  const nodes = [node('a'), node('b'), node('isolated')];
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'missing' }];
  const positions = layoutNodes(nodes, edges);
  assert.equal(positions.size, 3);
  nodes.forEach(item => Object.assign(item, positions.get(item.id)));
  assert.ok(!overlaps(nodes[0], nodes[2]));
  assertClearRoutes({ nodes, edges: edges.slice(0, 2) });
});

test('长距离分支和返工连线避开中间节点，平行分支标签位置独立', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  nodes.forEach((item, index) => Object.assign(item, { x: 100 + index * 400, y: 150 }));
  const edges = [{ from: 'a', to: 'd', branch: 'pass' }, { from: 'd', to: 'a', branch: 'retry' },
    { from: 'a', to: 'd', branch: 'skip' }];
  assertClearRoutes({ nodes, edges });
  const routes = routeEdges(nodes, edges);
  assert.notDeepEqual(routes[0].points, routes[2].points);
});
