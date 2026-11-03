import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSessions } from '../src/main/common/agent-sessions.js';

function fixture() {
  const calls = [];
  let granted = false;
  const tasks = { providers: async () => [{ pluginId: 'ai' }], capabilities: {
    discover: async () => ({ providers: ['start', 'read', 'respond', 'cancel', 'close', 'history'].map(method => ({ state: 'ready',
      descriptor: { id: `agent.session.${method}.v1` }, handle: { pluginId: 'ai', capabilityId: method } })) }),
    authorize: async input => { calls.push({ auth: input }); return { id: 'lease', state: 'pending' }; },
    authorization: async () => ({ id: 'lease', state: granted ? 'granted' : 'pending' }),
    revoke: async id => calls.push({ revoke: id })
  }, call: async (id, input, options) => {
    calls.push({ id, input, options });
    if (id === 'agent.session.start.v1') { return { sessionId: input.sessionId || `session-${calls.length}` }; }
    if (id === 'agent.session.close.v1') { return { archivedAt: 123 }; }
    return { state: 'succeeded', output: 'done' };
  } };
  return { sessions: new AgentSessions(tasks), calls, grant: () => { granted = true; } };
}

test('host consent precedes start; loop turns reuse binding and history stays read-only', async () => {
  const { sessions, calls, grant } = fixture();
  const options = { runId: 'run', nodeId: 'node', workflowId: 'flow', name: '产品' };
  const request = { prompt: 'analyze' };
  assert.equal((await sessions.run(request, options)).state, 'starting');
  assert.equal(calls.filter(call => call.id).length, 0);
  grant();
  const first = await sessions.run(request, options);
  const second = await sessions.run({ prompt: 'again' }, options);
  assert.equal(first.binding.sessionId, second.binding.sessionId);
  assert.equal(second.binding.iteration, 2);
  const starts = calls.filter(call => call.id === 'agent.session.start.v1');
  assert.notEqual(starts[0].input.taskKey, starts[1].input.taskKey);
  assert.equal(starts[1].options.authorizationId, 'lease');
  assert.equal(calls.filter(call => call.auth).length, 1);
  await sessions.release('run', new Set(['node']));
  assert.equal(calls.some(call => call.revoke), false);
  const archived = await sessions.release('run');
  assert.equal(archived[0].archivedAt, 123);
  assert.equal(calls.filter(call => call.revoke).length, 1);
  await sessions.history(archived[0], { afterSequence: 7 });
  assert.equal(calls.at(-1).options.authorizationId, undefined);
  assert.equal(calls.at(-1).input.afterSequence, 7);
});

test('canceling while consent is pending revokes lease without creating an Agent', async () => {
  const { sessions, calls } = fixture();
  await sessions.run({ prompt: 'p' }, { runId: 'run', nodeId: 'node', workflowId: 'flow', name: 'Agent' });
  await sessions.release('run');
  assert.equal(calls.some(call => call.id), false);
  assert.equal(calls.at(-1).revoke, 'lease');
});

test('a lease arriving after cancellation is revoked and never starts a session', async () => {
  const { sessions, calls } = fixture();
  let finish;
  sessions.tasks.capabilities.authorize = () => new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const work = sessions.run({ prompt: 'p' }, { runId: 'run', nodeId: 'node', workflowId: 'flow', signal: controller.signal });
  while (!finish) { await new Promise(resolve => setImmediate(resolve)); }
  controller.abort();
  await sessions.release('run');
  finish({ id: 'late-lease' });
  await assert.rejects(work, /abort/i);
  assert.ok(calls.some(call => call.revoke === 'late-lease'));
  assert.equal(sessions.runs.get('run').authorizations.size, 0);
  assert.equal(calls.some(call => call.id), false);
});

test('parallel reviewers share one host authorization request', async () => {
  const { sessions, calls, grant } = fixture();
  grant();
  await Promise.all(['product', 'architecture', 'development', 'testing'].map(nodeId => sessions.run({ prompt: nodeId },
    { runId: 'parallel', workflowId: 'flow', nodeId, name: nodeId })));
  assert.equal(calls.filter(call => call.auth).length, 1);
  assert.equal(calls.filter(call => call.id === 'agent.session.start.v1').length, 4);
});
