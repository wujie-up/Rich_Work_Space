import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function declaration(name, next) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, source.indexOf(`function ${next}(`));
}
function fixture(confirmed) {
  const workflow = { id: 'workflow', nodes: [{ id: 'first', title: '<开始>' }, { id: 'second', title: '结束' }],
    edges: [{ from: 'first', to: 'second' }] };
  const state = { dirty: false, selectedNodeId: 'first', selectedEdge: 'first>second' };
  const prompts = [];
  const context = vm.createContext({ state, current: () => workflow, render() {}, document: { activeElement: {} },
    confirmConfigurationDelete: async (...args) => { prompts.push(args); return confirmed; } });
  vm.runInContext(declaration('removeNode', 'linkNodes') + declaration('removeEdge', 'createsCycle'), context);
  return { workflow, state, prompts, context };
}
for (const [name, args] of [['removeNode', ['first']], ['removeEdge', ['first>second']]]) {
  test(`${name}: cancel preserves the configuration and dirty state`, async () => {
    const { workflow, state, prompts, context } = fixture(false);
    await context[name](...args);
    assert.equal(workflow.nodes.length, 2);
    assert.equal(workflow.edges.length, 1);
    assert.equal(state.dirty, false);
    assert.equal(prompts.length, 1);
  });
  test(`${name}: confirmation removes only the captured target`, async () => {
    const { workflow, state, prompts, context } = fixture(true);
    await context[name](...args);
    assert.equal(workflow.nodes.length, name === 'removeNode' ? 1 : 2);
    assert.equal(workflow.edges.length, 0);
    assert.equal(state.dirty, true);
    assert.equal(prompts.length, 1);
  });
}
