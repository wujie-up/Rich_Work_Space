import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { SessionCoordination } from '../src/main/common/session-coordination.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const group = { collaboration: true, id: 'team', name: '开发组', coordinatorId: 'a' };
  const sent = [];
  const sessions = { active: new Map(['a', 'b'].map(id => [id, { id, pluginId: 'test', groupId: 'team', activity: 'done' }])),
    groups: { isCollaborative: id => id === group.id && group.collaboration && !group.archivedAt, list: () => [group], get: () => group, isCoordinator: session => (session.restoredFrom || session.id) === 'a', ensureCoordinator: async () => {} }, publish() {} };
  const messages = { peer: id => sessions.active.get(id), channels: { send: async input => { sent.push(input); return { ...input, messageId: `m${sent.length}`, status: 'pending' }; },
    inbox: async () => [{ status: 'delivered' }] }, sameGroup: (session, id) => sessions.active.get(id)?.groupId === session.groupId,
    reason: session => session.blocked ? 'confirmation' : session.exited ? 'offline' : session.activity === 'working' ? 'busy' : null };
  const coordination = new SessionCoordination({ pluginId: 'test', sessions, storage, messages });
  await coordination.load();
  return { storage, group, sessions, messages, coordination, sent };
}

test('routine progress is saved locally, deduplicated and readable after restart without a model message', async t => {
  const { coordination, sessions, storage, messages, sent } = await setup(t);
  await coordination.start(sessions.active.get('a'));
  const input = { targetId: 'a', requestId: 'progress-1', text: '接口完成一半', kind: 'progress' };
  const receipt = await coordination.progress(sessions.active.get('b'), input);
  assert.equal(receipt.local, true);
  assert.equal(receipt.status, 'recorded');
  assert.deepEqual(await coordination.progress(sessions.active.get('b'), input), receipt);
  await coordination.progress(sessions.active.get('b'), { ...input, requestId: 'progress-2', text: '接口已完成' });
  assert.deepEqual(await coordination.progress(sessions.active.get('b'), input), receipt);
  assert.equal(coordination.snapshot('team').progress[0].text, '接口已完成');
  assert.equal(sent.length, 0);
  const reloaded = new SessionCoordination({ pluginId: 'test', sessions, storage, messages });
  await reloaded.load();
  assert.equal(reloaded.snapshot('team').progress[0].text, '接口已完成');
  assert.deepEqual(await reloaded.progress(sessions.active.get('b'), input), receipt);
  assert.equal(reloaded.snapshot('team').active, true);
});

test('late task updates cannot reopen supervision after group archive', async t => {
  const { coordination, sessions, group, storage, messages } = await setup(t);
  const coordinator = sessions.active.get('a');
  await coordination.task(coordinator, { action: 'start', terminationCondition: '用户验收' });
  group.archivedAt = new Date().toISOString();
  await coordination.stop(group.id);
  await coordination.sent(coordinator, { targetId: 'b', kind: 'task' }, { messageId: 'late-send', status: 'pending' });
  await coordination.task(coordinator, { action: 'start', terminationCondition: '迟到的任务' });
  await coordination.submitted(sessions.active.get('b'));
  await coordination.start(coordinator);
  const reloaded = new SessionCoordination({ pluginId: 'test', sessions, storage, messages });
  await reloaded.load();
  delete group.archivedAt;
  assert.equal(reloaded.isActive(group.id), false);
  assert.deepEqual(reloaded.snapshot(group.id).outstanding, []);
  assert.equal(reloaded.snapshot(group.id).terminationCondition, undefined);
});

test('queued task starts check group suspension when their state write executes', async t => {
  const { coordination, sessions, group } = await setup(t);
  const pending = coordination.start(sessions.active.get('a'));
  group.archivedAt = new Date().toISOString();
  await pending;
  delete group.archivedAt;
  assert.equal(coordination.isActive(group.id), false);
});

test('collaborative instructions keep exchanges local and concise without hiding evidence or uncertainty', async t => {
  const { coordination } = await setup(t);
  for (const sessionId of ['a', 'b']) {
    const instructions = coordination.instructions({ groupId: 'team', sessionId });
    assert.match(instructions, /kind=progress 只保存本地摘要，不触发模型/);
    assert.doesNotMatch(instructions, /不接受用户直接输入|由组管理员向用户确认/);
    assert.match(instructions, /agent_session_send 向该成员交接/);
    assert.match(instructions, /详细日志和长内容留在本地文件/);
    assert.match(instructions, /实际验证结果及未解决项/);
    assert.match(instructions, /不得为精简省略关键限制、风险、失败或不确定性/);
  }
});

test('coordinator user input waits for an explicit termination condition before starting a task', async t => {
  const { coordination, sessions, storage, messages } = await setup(t);
  const coordinator = sessions.active.get('a');
  await coordination.submitted(coordinator);
  assert.equal(coordination.isActive('team'), false);
  for (const terminationCondition of [undefined, '', '   ', 42, 'x'.repeat(2001)]) {
    await assert.rejects(coordination.task(coordinator, { action: 'start', terminationCondition }), /终止条件/);
    assert.equal(coordination.isActive('team'), false);
  }
  const task = await coordination.task(coordinator, { action: 'start', terminationCondition: '  测试全部通过并由用户验收后停止  ' });
  assert.equal(task.active, true);
  assert.equal(task.terminationCondition, '测试全部通过并由用户验收后停止');
  const reloaded = new SessionCoordination({ pluginId: 'test', sessions, storage, messages });
  await reloaded.load();
  assert.equal(reloaded.summary(coordinator).terminationCondition, '测试全部通过并由用户验收后停止');
  await reloaded.submitted(coordinator);
  assert.equal(reloaded.summary(coordinator).terminationCondition, '测试全部通过并由用户验收后停止');
  await reloaded.task(coordinator, { action: 'complete' });
  await reloaded.submitted(coordinator);
  assert.equal(reloaded.isActive('team'), false);
  assert.equal(reloaded.summary(coordinator).terminationCondition, undefined);
  await assert.rejects(reloaded.task(coordinator, { action: 'start' }), /终止条件/);
});

test('model discovery returns short role-specific progress without the internal queue ledger', async t => {
  const { coordination, sessions } = await setup(t);
  const a = sessions.active.get('a');
  const b = sessions.active.get('b');
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'job' });
  await coordination.progress(b, { targetId: 'a', requestId: 'p', text: '正在验证' });
  await coordination.progress({ id: 'c', groupId: 'team' }, { targetId: 'a', requestId: 'q', text: '等待接口' });
  const coordinator = coordination.summary(a);
  assert.equal(coordinator.active, true);
  assert.deepEqual(coordinator.waitingFor, ['b']);
  assert.deepEqual(coordinator.progress.map(report => report.text), ['正在验证', '等待接口']);
  assert.equal(coordinator.outstanding, undefined);
  assert.equal(coordinator.progress[0].receipt, undefined);
  assert.equal(coordinator.progress[0].requestId, undefined);
  assert.deepEqual(coordination.summary(b).progress.map(report => report.text), ['正在验证']);
});

test('the local watchdog queries a silent member once, pauses for confirmation and completes explicitly', async t => {
  const { coordination, sessions, sent } = await setup(t);
  await coordination.start(sessions.active.get('a'));
  const assignment = { messageId: 'assignment', recipient: 'b', sender: 'a', requestId: 'task', status: 'pending', createdAt: Date.now() };
  await coordination.sent(sessions.active.get('a'), { targetId: 'b', kind: 'task' }, assignment);
  const now = Date.now() + 61000;
  sessions.active.get('b').blocked = 'question';
  await coordination.tick(now);
  assert.equal(sent.length, 0);
  sessions.active.get('b').blocked = null;
  sessions.active.get('b').activity = 'working';
  await coordination.tick(now + 1000);
  assert.equal(sent.length, 1, 'busy recipients get a queue entry rather than interrupted input');
  assert.match(sent[0].text, /简短进度/);
  await coordination.tick(now + 122000);
  assert.equal(sent.length, 1, 'unchanged state never triggers a model polling loop');
  await assert.rejects(coordination.task(sessions.active.get('b'), { action: 'complete' }), /组管理员/);
  await coordination.task(sessions.active.get('a'), { action: 'complete' });
  assert.equal(coordination.snapshot('team').active, false);
  assert.equal(coordination.superseded({ requestId: sent[0].requestId, recipient: 'b' }), true);
});

test('local progress supersedes a queued query, result clears outstanding work, and storage failures retain prior state', async t => {
  const { coordination, sessions, storage, sent } = await setup(t);
  const a = sessions.active.get('a');
  const b = sessions.active.get('b');
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'job', sender: 'a', recipient: 'b' });
  await coordination.tick(Date.now() + 61000);
  assert.equal(sent.length, 1);
  await coordination.progress(b, { targetId: 'a', requestId: 'p', text: '正在验证', kind: 'progress' });
  assert.ok(coordination.superseded({ requestId: sent[0].requestId, recipient: 'b' }));
  await coordination.sent(b, { targetId: 'a', kind: 'result', replyTo: 'job' }, { messageId: 'result', recipient: 'a', sender: 'b' });
  assert.equal(coordination.snapshot('team').outstanding.length, 0);
  const previous = coordination.snapshot('team');
  storage.writeJson = async () => { throw Error('disk failure'); };
  await assert.rejects(coordination.task(a, { action: 'complete' }), /disk failure/);
  assert.deepEqual(coordination.snapshot('team'), previous);
});

test('failed local follow-ups retry the same identity after restart and never forward the user prompt', async t => {
  const { coordination, sessions, storage, messages, sent } = await setup(t);
  const b = sessions.active.get('b');
  await coordination.submitted(b);
  const state = coordination.snapshot('team');
  assert.equal(state.active, true);
  assert.equal(state.outstanding.length, 1);
  assert.equal(state.outstanding[0].source, 'user');
  const send = messages.channels.send;
  const attempts = [];
  messages.channels.send = async input => { attempts.push(input.requestId); throw Error('transport unavailable'); };
  await coordination.tick(Date.now() + 61000);
  assert.equal(sent.length, 0);
  const reloaded = new SessionCoordination({ pluginId: 'test', sessions, storage, messages });
  await reloaded.load();
  messages.channels.send = async input => { attempts.push(input.requestId); return send(input); };
  await reloaded.tick(Date.now() + 62000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyTo, undefined, 'a local user task has no transport message to reply to');
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
  await reloaded.tick(Date.now() + 120000);
  assert.equal(sent.length, 1);
  await reloaded.sent(b, { targetId: 'a', kind: 'result', replyTo: 'some-message' }, { messageId: 'result' });
  assert.equal(reloaded.snapshot('team').outstanding.length, 0);
});

test('pending tasks and members moved out of the group never trigger follow-ups', async t => {
  const { coordination, sessions, messages, sent } = await setup(t);
  messages.channels.inbox = async () => [{ status: 'pending' }];
  await coordination.sent(sessions.active.get('a'), { targetId: 'b', kind: 'task' }, { messageId: 'job' });
  await coordination.tick(Date.now() + 61000);
  assert.equal(sent.length, 0);
  sessions.active.get('b').groupId = 'another';
  messages.channels.inbox = async () => [{ status: 'delivered' }];
  await coordination.tick(Date.now() + 62000);
  assert.equal(sent.length, 0);
});

test('retries of delivered task and result receipts do not reopen completed work or clear a newer assignment', async t => {
  const { coordination, sessions } = await setup(t);
  const a = sessions.active.get('a');
  const b = sessions.active.get('b');
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'old' });
  await coordination.task(a, { action: 'complete' });
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'old', status: 'pending' });
  assert.equal(coordination.snapshot('team').active, false);
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'old', status: 'delivered' });
  assert.equal(coordination.snapshot('team').active, false);
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'new' });
  await coordination.sent(b, { targetId: 'a', kind: 'result' }, { messageId: 'old-result', status: 'delivered' });
  assert.deepEqual(coordination.snapshot('team').outstanding.map(job => job.messageId), ['new']);
});

test('a result replying to a watchdog inquiry completes its original assignment and retains other assignments', async t => {
  const { coordination, sessions, sent, messages } = await setup(t);
  const a = sessions.active.get('a');
  const b = sessions.active.get('b');
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'original' });
  await coordination.tick(Date.now() + 61000);
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'new' });
  messages.channels.inbox = async ({ messageId }) => messageId === 'followup'
    ? [{ ...sent[0], messageId, sender: 'a', recipient: 'b' }] : [{ status: 'delivered' }];
  await coordination.sent(b, { targetId: 'a', kind: 'result', replyTo: 'followup' }, { messageId: 'result' });
  assert.deepEqual(coordination.snapshot('team').outstanding.map(job => job.messageId), ['new']);
});

test('a direct peer handoff transfers only the referenced assignment and survives restart without a coordinator message', async t => {
  const { coordination, sessions, storage, messages, sent } = await setup(t);
  const a = sessions.active.get('a');
  const b = sessions.active.get('b');
  sessions.active.set('c', { ...b, id: 'c' });
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'original' });
  await coordination.sent(a, { targetId: 'b', kind: 'task' }, { messageId: 'parallel' });
  const input = { targetId: 'c', kind: 'task', replyTo: 'original' };
  await coordination.sent(b, input, { messageId: 'handoff', status: 'pending' });
  await coordination.sent(b, input, { messageId: 'handoff', status: 'pending' });
  assert.deepEqual(coordination.snapshot('team').outstanding.map(job => job.messageId), ['parallel', 'handoff']);
  assert.deepEqual(coordination.summary(a).waitingFor, ['b', 'c']);
  assert.equal(sent.length, 0, 'bookkeeping never forwards the handoff to the coordinator model');
  const reloaded = new SessionCoordination({ pluginId: 'test', sessions, storage, messages });
  await reloaded.load();
  const job = reloaded.snapshot('team').outstanding.find(job => job.messageId === 'handoff');
  assert.equal(job.sender, 'b');
  await reloaded.sent(sessions.active.get('c'), { targetId: 'b', kind: 'result', replyTo: 'handoff' }, { messageId: 'result' });
  assert.deepEqual(reloaded.snapshot('team').outstanding.map(job => job.messageId), ['parallel']);
});

test('peer task supervision checks the actual sender receipt and accepts a watchdog reply without clearing unrelated work', async t => {
  const { coordination, sessions, messages, sent } = await setup(t);
  const b = sessions.active.get('b');
  const c = { ...b, id: 'c' };
  sessions.active.set('c', c);
  sessions.active.set('d', { ...b, id: 'd' });
  await coordination.sent(b, { targetId: 'c', kind: 'task' }, { messageId: 'peer-job' });
  messages.channels.inbox = async ({ endpointId, messageId }) => endpointId === 'b' && messageId === 'peer-job'
    ? [{ status: 'pending' }] : [];
  await coordination.tick(Date.now() + 61000);
  assert.equal(sent.length, 0);
  messages.channels.inbox = async ({ endpointId, messageId }) => endpointId === 'b' && messageId === 'peer-job'
    ? [{ status: 'delivered' }] : [];
  await coordination.tick(Date.now() + 62000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetId, 'c');
  assert.equal(sent[0].replyTo, 'peer-job');
  await coordination.sent(c, { targetId: 'd', kind: 'result', replyTo: 'peer-job' }, { messageId: 'unrelated-result' });
  assert.equal(coordination.snapshot('team').outstanding.length, 1);
  await coordination.sent(b, { targetId: 'c', kind: 'task' }, { messageId: 'another-job' });
  messages.channels.inbox = async ({ messageId }) => messageId === 'query'
    ? [{ ...sent[0], sender: 'a', recipient: 'c' }] : [];
  await coordination.sent(c, { targetId: 'b', kind: 'result', replyTo: 'query' }, { messageId: 'result' });
  assert.deepEqual(coordination.snapshot('team').outstanding.map(job => job.messageId), ['another-job']);
  assert.equal(coordination.superseded({ requestId: sent[0].requestId, recipient: 'c' }), true);
});

test('ordinary groups do not receive role prompts, task activation or watchdog leaders', async t => {
  const { coordination, group, sessions, sent } = await setup(t);
  group.collaboration = false;
  let launches = 0;
  sessions.groups.ensureCoordinator = async () => { launches++; };
  await coordination.submitted(sessions.active.get('b'));
  await coordination.start(sessions.active.get('a'));
  await coordination.tick();
  assert.equal(coordination.instructions({ groupId: group.id }), '');
  assert.equal(coordination.isActive(group.id), false);
  assert.equal(launches, 0);
  assert.equal(sent.length, 0);
});
