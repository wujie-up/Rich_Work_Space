import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeEngine } from '../src/main/common/claude-engine.js';

test('Claude control protocol normalizes streaming, tool approval and completion without bypassing permissions', async () => {
  const events = [];
  const engine = new ClaudeEngine({ onEvent: event => events.push(event) });
  const writes = [];
  engine.child = { stdin: { write: data => writes.push(JSON.parse(data)) } };
  engine.threadId = 'thread';
  const turn = await engine.request('turn/start', { input: [{ text: 'hello' }] });
  assert.equal(writes[0].type, 'user');
  engine.receive({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } });
  assert.equal(events[0].method, 'item/commandExecution/requestApproval');
  engine.respond('permission', { decision: 'decline' });
  assert.equal(writes[1].response.response.behavior, 'deny');
  assert.throws(() => engine.respond('permission', { decision: 'accept' }), /失效/);
  engine.receive({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } } });
  engine.receive({ type: 'result', subtype: 'success', result: 'answer' });
  assert.equal(events.at(-1).params.turn.id, turn.turn.id);
  assert.equal(events.at(-1).params.turn.status, 'completed');
  assert.equal(events.some(event => event.params?.delta === 'answer'), true);
});

test('Claude clarification returns question answers and cancellation retires approval', () => {
  const events = [];
  const writes = [];
  const engine = new ClaudeEngine({ onEvent: event => events.push(event) });
  engine.child = { stdin: { write: data => writes.push(JSON.parse(data)) } };
  const questions = [{ question: 'Which engine?', header: 'Engine', options: [{ label: 'Codex' }] }];
  engine.receive({ type: 'control_request', request_id: 'question', request: {
    subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions }
  } });
  assert.equal(events[0].method, 'item/tool/requestUserInput');
  engine.respond('question', { answers: { 0: { answers: ['Codex'] } } });
  assert.deepEqual(writes[0].response.response.updatedInput, { questions, answers: { 'Which engine?': 'Codex' } });
  assert.throws(() => engine.respond('question', { answers: {} }), /失效/);
});

test('Claude question denial does not require an answer payload', () => {
  const engine = new ClaudeEngine();
  const writes = [];
  engine.child = { stdin: { write: data => writes.push(JSON.parse(data)) } };
  engine.receive({ type: 'control_request', request_id: 'decline-question', request: {
    subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Continue?' }] }
  } });
  engine.respond('decline-question', { decision: 'decline' });
  assert.equal(writes[0].response.response.behavior, 'deny');
});

test('background authorization allows full access while ordinary Claude plans stay read only', async () => {
  const { AppServer } = await import('../src/main/common/app-server.js');
  const original = AppServer.prototype.start;
  const launches = [];
  AppServer.prototype.start = async input => { launches.push(input); };
  try {
    await new ClaudeEngine().start({ plan: true, fullyAuthorized: true });
    await new ClaudeEngine().start({ plan: false, fullyAuthorized: true });
    await new ClaudeEngine().start({ plan: true, fullyAuthorized: false });
    assert.equal(launches[0].protocolArgs[launches[0].protocolArgs.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.equal(launches[2].protocolArgs[launches[2].protocolArgs.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(launches[1].protocolArgs[launches[1].protocolArgs.indexOf('--permission-mode') + 1], 'bypassPermissions');
  } finally {
    AppServer.prototype.start = original;
  }
});

test('bridge receives the primary native final result with thread and turn identities', async () => {
  const events = [];
  const engine = new ClaudeEngine({ onEvent: event => events.push(event) });
  engine.child = { stdin: { write() {} } };
  engine.threadId = 'primary';
  const { turn } = await engine.request('turn/start', { input: [{ text: 'hello' }] });
  engine.receive({ type: 'assistant', parent_tool_use_id: 'child-tool', message: { content: [{ type: 'text', text: 'child output' }] } });
  engine.receive({ type: 'result', parent_tool_use_id: 'child-tool', result: 'child result' });
  engine.receive({ type: 'result', session_id: 'primary', result: 'final answer' });
  assert.equal(events.length, 1);
  assert.equal(events[0].params.threadId, 'primary');
  assert.equal(events[0].params.turn.id, turn.id);
  assert.equal(events[0].params.turn.items[0].phase, 'final_answer');
  assert.equal(events[0].params.turn.items[0].text, 'final answer');
});
