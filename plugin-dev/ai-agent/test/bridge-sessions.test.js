import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeSessions } from '../src/main/common/bridge/sessions.js';
import { Conversations } from '../src/main/common/conversations.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

const caller = (instanceId = 'one', pluginId = 'message-bridge') => ({ caller: { pluginId, instanceId }, authorizationId: 'approved' });
const key = value => value.repeat(64);
const input = { bindingKey: 'route:channel:chat:sender', sourceScope: { channelId: 'channel', chatId: 'chat', senderIds: ['sender'] },
  target: { mode: 'dedicated', engineId: 'codex' }, executionPolicy: { mode: 'readOnly' } };

class Engine {
  constructor(options) { Object.assign(this, options); this.calls = []; }
  async start() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method.startsWith('thread/')) { return { thread: { id: 'thread' } }; }
    if (method === 'turn/start') { return { turn: { id: `turn-${this.calls.length}`, status: 'inProgress' } }; }
    return {};
  }
  respond(id, value) { this.response = { id, value }; }
  close() {}
}

async function fixture(t) {
  const cleanup = [];
  const storage = await temporaryStore({ after: work => cleanup.push(work) });
  const conversations = new Conversations({ pluginId: 'ai-test', storage, Engine,
    runtime: { launch: async () => ({ engineId: 'codex', runtimeId: 'test', profileId: 'default', args: [], env: { HOME: storage.root } }) },
    createGateway: () => ({ start: async () => {}, close: async () => {}, cancel: async () => {}, refreshCatalog: async () => false }),
    emit() {}, ownProcesses() {} });
  await conversations.load();
  let now = 1000;
  const bridge = new BridgeSessions({ pluginId: 'ai-test', storage, conversations, sessions: { active: new Map() }, now: () => now });
  await bridge.load();
  t.after(async () => {
    await bridge.stop();
    await conversations.stop();
    for (const work of cleanup) { await work(); }
  });
  return { bridge, conversations, storage, advance: ms => { now += ms; } };
}

async function submit(bridge, binding, requestKey = key('a'), text = 'hello') {
  return bridge.submit({ bindingId: binding.bindingId, requestKey, sourceMessageKey: `source:${requestKey}`, text }, caller());
}

function complete(conversations, binding, task, text = 'final') {
  const engine = conversations.engines.get(binding.targetRef.id).engine;
  engine.onEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: 'untagged-secret' } } });
  engine.onEvent({ method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn',
    item: { type: 'agentMessage', phase: 'final_answer', text: 'secret-child' } } });
  engine.onEvent({ method: 'item/completed', params: { threadId: 'thread', turnId: task.turnId,
    item: { type: 'agentMessage', phase: 'commentary', text: 'thinking' } } });
  engine.onEvent({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: task.turnId, status: 'completed',
    items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text }] } } });
}

test('binding reuses dedicated context across caller instances and isolates ownership and conflicts', async t => {
  const { bridge } = await fixture(t);
  const first = await bridge.bind(input, caller());
  const again = await bridge.bind(input, caller('two'));
  assert.equal(again.bindingId, first.bindingId);
  assert.equal(again.targetRef.id, first.targetRef.id);
  assert.equal(again.reused, true);
  await assert.rejects(submit(bridge, first), /实例|instance/);
  const task = await bridge.submit({ bindingId: first.bindingId, requestKey: key('a'), sourceMessageKey: 'source', text: 'hello' }, caller('two'));
  await assert.rejects(bridge.read({ taskId: task.taskId }, caller('two', 'other')), /所属|owner/);
  await assert.rejects(bridge.bind({ ...input, sourceScope: { ...input.sourceScope, chatId: 'other' } }, caller('two')), /conflict/);
  const other = await bridge.bind({ ...input, bindingKey: 'other' }, caller());
  assert.notEqual(other.targetRef.id, first.targetRef.id);
});

test('duplicate requests execute once; queued turns share one scheduler and exact native completion', async t => {
  const { bridge, conversations } = await fixture(t);
  const binding = await bridge.bind(input, caller());
  const first = await submit(bridge, binding);
  assert.equal((await submit(bridge, binding)).taskId, first.taskId);
  await submit(bridge, binding, key('b'), 'second');
  await bridge.pump();
  let task = await bridge.read({ taskId: first.taskId }, caller());
  assert.equal(task.state, 'running');
  const engine = conversations.engines.get(binding.targetRef.id).engine;
  assert.equal(engine.calls.filter(call => call.method === 'turn/start').length, 1);
  complete(conversations, binding, task);
  task = await bridge.read({ taskId: first.taskId }, caller());
  assert.equal(task.state, 'completed');
  assert.equal(task.output, 'final');
  await bridge.pump();
  assert.equal(engine.calls.filter(call => call.method === 'turn/start').length, 2);
  const config = engine.calls.find(call => call.method === 'thread/start').params;
  assert.equal(config.sandbox, 'read-only');
  assert.equal(config.approvalPolicy, 'on-request');
});

test('existing conversations require explicit actual policy, fresh empty composer, and preserve drafts', async t => {
  const { bridge, conversations } = await fixture(t);
  const record = await conversations.create();
  const existing = { ...input, target: { mode: 'existing', targetRef: { kind: 'conversation', id: record.id } } };
  await assert.rejects(bridge.bind(existing, caller()), /权限|policy/);
  const binding = await bridge.bind({ ...existing, executionPolicy: { mode: 'existing', accepted: true } }, caller());
  const task = await submit(bridge, binding);
  await bridge.pump();
  assert.equal((await bridge.read({ taskId: task.taskId }, caller())).queueReason, 'composer_unknown');
  conversations.composer(record.id, { clientId: 'view', version: 1, empty: false });
  await bridge.pump();
  assert.equal((await bridge.read({ taskId: task.taskId }, caller())).queueReason, 'draft');
  conversations.composer(record.id, { clientId: 'view', version: 2, empty: true });
  await bridge.pump();
  assert.equal((await bridge.read({ taskId: task.taskId }, caller())).state, 'running');
});

test('questions preserve native IDs and remote permission approvals are rejected', async t => {
  const { bridge, conversations } = await fixture(t);
  const binding = await bridge.bind(input, caller());
  const task = await submit(bridge, binding);
  await bridge.pump();
  const running = await bridge.read({ taskId: task.taskId }, caller());
  const engine = conversations.engines.get(binding.targetRef.id).engine;
  engine.onEvent({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: running.turnId } });
  await assert.rejects(bridge.respond({ taskId: task.taskId, requestId: 7, answers: {} }, caller()), /本地|local/);
  engine.onEvent({ id: 'native-question', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: running.turnId,
    questions: [{ id: 'scope', question: 'Which scope?' }] } });
  const waiting = await bridge.read({ taskId: task.taskId }, caller());
  assert.equal(waiting.questions[0].requestId, 'native-question');
  await bridge.respond({ taskId: task.taskId, requestId: 'native-question', answers: { scope: 'this' } }, caller());
  assert.deepEqual(engine.response, { id: 'native-question', value: { answers: { scope: { answers: ['this'] } } } });
  await assert.rejects(bridge.respond({ taskId: task.taskId, requestId: 'native-question', answers: { scope: 'again' } }, caller()), /失效|answered/);
});

test('suspend preserves context and closes old output; explicit unbind never reuses the released binding', async t => {
  const { bridge, conversations } = await fixture(t);
  const binding = await bridge.bind(input, caller());
  const task = await submit(bridge, binding);
  await bridge.pump();
  await bridge.suspend({ bindingId: binding.bindingId }, caller());
  const closed = await bridge.read({ taskId: task.taskId }, caller());
  assert.equal(closed.closed, true);
  assert.equal(closed.output, undefined);
  const resumed = await bridge.bind(input, caller('two'));
  assert.equal(resumed.targetRef.id, binding.targetRef.id);
  await bridge.unbind({ bindingId: resumed.bindingId }, caller('two'));
  const next = await bridge.bind(input, caller('two'));
  assert.notEqual(next.bindingId, binding.bindingId);
  assert.notEqual(next.targetRef.id, binding.targetRef.id);
  assert.ok(conversations.records.has(binding.targetRef.id));
});

test('expired runtime lease suspends queued work instead of launching without a live bridge', async t => {
  const { bridge, advance, conversations } = await fixture(t);
  const binding = await bridge.bind(input, caller());
  const task = await submit(bridge, binding);
  advance(61000);
  await bridge.pump();
  assert.equal((await bridge.read({ taskId: task.taskId }, caller())).closed, true);
  assert.equal(conversations.engines.size, 0);
});

test('disk failure prevents native submission and never publishes an uncommitted binding', async t => {
  const { bridge, storage, conversations } = await fixture(t);
  const binding = await bridge.bind(input, caller());
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw Error('disk full'); };
  await assert.rejects(submit(bridge, binding), /disk full/);
  assert.equal(conversations.engines.size, 0);
  storage.writeJson = write;
  assert.equal((await submit(bridge, binding)).state, 'queued');
});

test('restart keeps binding identity but uncertain submission is never replayed', async t => {
  const { bridge, storage, conversations } = await fixture(t);
  const binding = await bridge.bind(input, caller());
  const task = await submit(bridge, binding);
  await bridge.edit(state => { state.tasks[task.taskId].state = 'submitting'; });
  const reopened = new BridgeSessions({ pluginId: 'ai-test', storage, conversations, sessions: { active: new Map() } });
  await reopened.load();
  const resumed = await reopened.bind(input, caller('new'));
  assert.equal(resumed.bindingId, binding.bindingId);
  const read = await reopened.read({ taskId: task.taskId }, caller('new'));
  assert.equal(read.state, 'uncertain');
  await reopened.pump();
  assert.equal(conversations.engines.size, 0);
  await reopened.stop();
});

test('a failed binding commit reconciles its already-created dedicated context on retry', async t => {
  const { bridge, storage, conversations } = await fixture(t);
  const write = storage.writeJson.bind(storage);
  let attempts = 0;
  storage.writeJson = async (path, value) => {
    if (path.endsWith('/bridge-state.json') && ++attempts === 2) { throw Error('binding disk failure'); }
    return write(path, value);
  };
  await assert.rejects(bridge.bind(input, caller()), /disk failure/);
  storage.writeJson = write;
  const binding = await bridge.bind(input, caller());
  assert.equal(conversations.list().length, 1);
  assert.equal(binding.targetRef.id, conversations.list()[0].id);
});

test('opening a dedicated context with a local draft pauses external turns until the draft clears', async t => {
  const { bridge, conversations } = await fixture(t);
  const binding = await bridge.bind(input, caller());
  const task = await submit(bridge, binding);
  conversations.composer(binding.targetRef.id, { clientId: 'local', version: 1, empty: false });
  await bridge.pump();
  assert.equal((await bridge.read({ taskId: task.taskId }, caller())).state, 'queued');
  conversations.composer(binding.targetRef.id, { clientId: 'local', version: 2, empty: true });
  await bridge.pump();
  assert.equal((await bridge.read({ taskId: task.taskId }, caller())).state, 'running');
});
