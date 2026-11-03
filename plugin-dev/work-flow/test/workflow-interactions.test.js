import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowInteractions } from '../src/main/common/workflow-interactions.js';
import { manualQuestions, answerQuestion } from '../src/main/common/interaction-questions.js';

test('工作台问题逐项展示内联选项，执行记录保留原文', async () => {
  const prompt = '请选择：A，进入下一阶段；B，等待补充材料。';
  const batch = manualQuestions({ id: 'batch', interaction: 'text', prompt });
  const run = { id: 'run', status: 'waiting', pending: { kind: 'manual', interaction: batch } };
  let request;
  const pump = new WorkflowInteractions({ engine: { records: new Map([['run', run]]) }, logger: () => {}, messages: {
    request: async input => { request = { ...input, id: 'message', state: 'pending' }; return request; },
    get: async () => request
  } });
  await pump.tick();
  assert.equal(request.question, '请选择：\n\nA，进入下一阶段；\n\nB，等待补充材料。');
  assert.equal(batch.questions[0].question, prompt);
});

test('host interaction pump queues one question, advances without a view and cancels on stop', async () => {
  const batch = manualQuestions({ id: 'batch', interaction: 'text', prompt: '["first","second"]' });
  const run = { id: 'run', workflowName: 'Flow', status: 'waiting', pending: { kind: 'manual', interaction: batch } };
  const records = new Map();
  let resumed = 0;
  const engine = { records: new Map([['run', run]]), resume: async () => { resumed++; },
    answer: async (_id, input) => {
      if (answerQuestion(batch, input.questionId, input.text)) { run.status = 'succeeded'; run.pending = null; }
    } };
  const messages = { request: async input => {
    const value = { ...input, id: String(records.size), state: 'pending' };
    records.set(value.id, value);
    return value;
  }, get: async id => records.get(id), cancel: async id => { records.get(id).state = 'cancelled'; } };
  const pump = new WorkflowInteractions({ engine, messages, logger: () => {} });
  await pump.tick();
  await pump.tick();
  assert.equal(records.size, 1);
  assert.equal(records.get('0').question, 'first');
  Object.assign(records.get('0'), { state: 'answered', answer: { text: 'one' } });
  await pump.tick();
  await pump.tick();
  assert.equal(records.size, 2);
  assert.equal(records.get('1').question, 'second');
  assert.equal(batch.currentIndex, 1);
  await pump.stop();
  assert.equal(records.get('1').state, 'cancelled');
  run.pending = { kind: 'service' };
  const background = new WorkflowInteractions({ engine, messages, logger: () => {} });
  await background.tick();
  assert.equal(resumed, 1);
});


test('native question IDs reused by another node or turn never inherit previous answers', async () => {
  const { PluginMessages } = await import('../../../desk/src/main/common/plugin-messages.js');
  const { questionBatch } = await import('../src/main/common/interaction-questions.js');
  const store = new PluginMessages();
  const owner = { id: 'flow', instanceId: 'one' };
  const messages = { request: input => store.request(owner, input), get: id => store.get(owner, id),
    cancel: id => store.cancel(owner, id) };
  const pending = (nodeId, taskKey) => ({ nodeId, kind: 'service', request: { taskKey },
    interaction: questionBatch('1', [{ id: 'decision', question: 'Choose?' }]) });
  const answers = [];
  const run = { id: 'run', status: 'waiting', pending: pending('product', 'turn-one') };
  const pump = new WorkflowInteractions({ engine: { records: new Map([['run', run]]), answer: async (_id, input) => {
    answers.push(input.text); run.pending = null;
  } }, messages, logger: () => {} });
  await pump.tick();
  await store.respond(store.list()[0].id, { text: 'first' });
  await pump.tick();
  for (const [nodeId, taskKey] of [['developer', 'turn-one'], ['product', 'turn-two']]) {
    run.pending = pending(nodeId, taskKey);
    await pump.tick();
    assert.equal(store.list().length, 1);
    assert.deepEqual(answers, ['first']);
    await store.respond(store.list()[0].id, { text: 'next' });
    await pump.stop();
    break;
  }
});

test('dismissal interrupts once and continue creates a fresh host question', async () => {
  const { PluginMessages } = await import('../../../desk/src/main/common/plugin-messages.js');
  const store = new PluginMessages();
  const owner = { id: 'flow' };
  const run = { id: 'run', status: 'waiting', pending: { nodeId: 'human', kind: 'manual',
    interaction: manualQuestions({ id: 'batch', prompt: '问题', interaction: 'text' }) } };
  let interrupted = 0;
  const engine = { records: new Map([['run', run]]), interrupt: async () => { interrupted++; run.status = 'interrupted'; } };
  const pump = new WorkflowInteractions({ engine, logger: () => {}, messages: {
    request: input => store.request(owner, input), get: id => store.get(owner, id), cancel: id => store.cancel(owner, id) } });
  await pump.tick();
  const first = store.list()[0];
  store.defer(first.id);
  await pump.tick();
  await pump.tick();
  assert.equal(interrupted, 1);
  run.status = 'waiting';
  run.resumeCount = 1;
  await pump.tick();
  assert.equal(store.list().length, 1);
  assert.notEqual(store.list()[0].id, first.id);
});

test('native approvals require a popup and only explicit human choices reach Agent', async () => {
  const records = new Map();
  const request = { id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } };
  const run = { id: 'run', workflowName: 'Flow', status: 'waiting', pending: { nodeId: 'dev', kind: 'service',
    request: { taskKey: 'turn' }, task: { requests: [request] } } };
  const answers = [];
  const pump = new WorkflowInteractions({ engine: { records: new Map([['run', run]]), resume: async () => {},
    respond: async (_id, input) => answers.push(input) }, logger: () => {}, messages: {
    request: async input => { const value = { ...input, id: String(records.size), state: 'pending' }; records.set(value.id, value); return value; },
    get: async id => records.get(id), cancel: async id => { records.get(id).state = 'cancelled'; } } });
  await pump.tick();
  assert.equal(records.size, 1);
  assert.equal(records.get('0').required, true);
  assert.equal(records.get('0').placement, 'center');
  assert.deepEqual(answers, []);
  Object.assign(records.get('0'), { state: 'answered', answer: { text: '拒绝' } });
  await pump.tick();
  await pump.tick();
  assert.deepEqual(answers, [{ requestId: 'approval', decision: 'decline' }]);
  assert.equal(records.size, 1);
});
