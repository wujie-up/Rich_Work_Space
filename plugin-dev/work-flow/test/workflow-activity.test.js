import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowActivity, workflowActivityInfo } from '../src/renderer/workflow-activity.js';

test('workflow activity distinguishes live execution, Agent work and waiting', () => {
  assert.equal(workflowActivity({ status: 'running' }), 'running');
  assert.equal(workflowActivity({ status: 'waiting', pending: { kind: 'manual' } }), 'waiting');
  assert.equal(workflowActivity({ status: 'waiting', pending: { kind: 'service', task: { state: 'running' } } }), 'agent');
  assert.equal(workflowActivity({ status: 'waiting', pending: { kind: 'service', interaction: {}, task: { state: 'running' } } }), 'waiting');
  assert.equal(workflowActivity({ status: 'waiting', pending: { kind: 'service', task: { requests: [{ id: 'q' }] } } }), 'waiting');
  assert.equal(workflowActivity({ status: 'waiting', pending: { kind: 'service', interaction: {},
    tasks: [{ state: 'waiting', requests: [{ id: 'q' }] }, { state: 'running' }] } }), 'agent');
  assert.equal(workflowActivity({ status: 'interrupted' }), null);
  assert.equal(workflowActivity({ status: 'succeeded' }), null);
});


test('parallel activity describes both Agent work and a pending human decision', () => {
  assert.deepEqual(workflowActivityInfo({ status: 'waiting', pending: { kind: 'service', interaction: {},
    tasks: [{ state: 'waiting', requests: [{ id: 'q' }] }, { state: 'running' }] } }),
  { state: 'agent', label: 'Agent 处理中 · 等待用户确认' });
  assert.deepEqual(workflowActivityInfo({ status: 'running' }), { state: 'running', label: '流程运行中' });
  assert.equal(workflowActivityInfo({ status: 'succeeded' }), null);
});
