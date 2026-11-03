import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';
import { PluginChannels } from '../../../desk/src/main/common/plugin-channels.js';
import { Sessions } from '../src/main/common/sessions.js';
import { McpRelay } from '../src/main/common/mcp-relay.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sessionTools } from '../src/main/common/session-messages.js';
import { SessionMessages } from '../src/main/common/session-messages.js';
import { SessionGroups } from '../src/main/common/session-groups.js';
import { SessionCoordination } from '../src/main/common/session-coordination.js';

async function fixture(t, ids = ['a', 'b']) {
  const storage = await temporaryStore(t);
  const source = { id: 'one', instanceId: 'runtime' };
  const broker = new PluginChannels({ storage, usable: () => true });
  const channels = Object.fromEntries(['register', 'unregister', 'list', 'send', 'inbox', 'claim', 'settle']
    .map(action => [action, input => broker.request(source, action, input)]));
  channels.subscribe = () => () => {};
  const sessions = new Sessions({ storage });
  sessions.groups = new SessionGroups({ pluginId: 'one', storage, sessions });
  sessions.groups.records = [{ id: 'team', collaboration: true }];
  const writes = [];
  for (const id of ids) {
    sessions.active.set(id, { id, groupId: 'team', pluginId: 'one', adapterId: 'codex', protocol: 'managed-terminal', name: id,
      activity: 'done', blocked: null, sequence: 1, terminal: { write: data => writes.push({ id, data }) } });
  }
  const manager = new SessionMessages({ pluginId: 'one', sessions, channels });
  sessions.messages = manager;
  t.after(() => manager.stop());
  let version = 0;
  const empty = (id, extra = {}) => manager.composer(id, { clientId: 'view', version: ++version, sequence: 1,
    inputRevision: sessions.active.get(id).inputRevision || 0, empty: true, ...extra });
  await manager.sync();
  empty('b');
  return { storage, source, broker, channels, sessions, manager, writes, empty };
}

test('local progress bypasses host delivery and invalidates an already queued model follow-up', async t => {
  const { storage, sessions, manager, channels, writes, empty } = await fixture(t);
  sessions.groups = new SessionGroups({ pluginId: 'one', storage, sessions });
  sessions.groups.records = [{ id: 'team', name: 'Team', collaboration: true, coordinatorId: 'a' }];
  const coordination = new SessionCoordination({ pluginId: 'one', sessions, storage, messages: manager });
  sessions.coordination = coordination;
  await coordination.load();
  await manager.call('a', 'agent_group_task', { action: 'start', terminationCondition: '评审完成并回传结果' });
  const task = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'assignment', text: 'review', kind: 'task' });
  await manager.flush();
  assert.equal(writes.length, 1);
  await coordination.tick(Date.now() + 61000);
  const before = await channels.inbox({ endpointId: 'a' });
  assert.equal(before.filter(message => message.status === 'pending').length, 1);
  const report = await manager.call('b', 'agent_session_send', { targetId: 'a', requestId: 'progress', text: '正在验证', kind: 'progress' });
  assert.equal(report.status, 'recorded');
  assert.equal(report.local, true);
  assert.deepEqual(await channels.inbox({ endpointId: 'a' }), before, 'routine progress never enters model transport');
  assert.equal((await manager.call('a', 'agent_sessions_list')).coordination.progress[0].text, '正在验证');
  const b = sessions.active.get('b');
  b.activity = 'done';
  b.sequence++;
  empty('b', { sequence: b.sequence });
  await manager.flush();
  assert.equal(writes.length, 1, 'obsolete follow-up must not cause another model turn');
  assert.equal((await channels.inbox({ endpointId: 'a' })).find(message => message.requestId.startsWith('desk-followup:')).status, 'failed');
  await manager.call('b', 'agent_session_send', { targetId: 'a', requestId: 'result', text: '验证完成', kind: 'result', replyTo: task.messageId });
  assert.equal(coordination.snapshot('team').outstanding.length, 0);
  assert.equal(writes.length, 1, 'coordinator without a fresh composer report retains the result in the queue');
  empty('a');
  await manager.flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].id, 'a');
  assert.match(writes[1].data, /验证完成/);
});

test('coordinator cannot dispatch a task until the user termination condition is recorded locally', async t => {
  const { storage, sessions, manager, channels, writes } = await fixture(t);
  sessions.groups = new SessionGroups({ pluginId: 'one', storage, sessions });
  sessions.groups.records = [{ id: 'team', name: 'Team', collaboration: true, coordinatorId: 'a' }];
  sessions.coordination = new SessionCoordination({ pluginId: 'one', sessions, storage, messages: manager });
  await sessions.coordination.load();
  for (const kind of [undefined, 'task']) {
    await assert.rejects(manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'blocked', text: 'review', kind }), /终止条件/);
  }
  assert.deepEqual(await channels.inbox({ endpointId: 'b' }), []);
  assert.equal(writes.length, 0);
  await manager.call('a', 'agent_group_task', { action: 'start', terminationCondition: '全部测试通过后停止' });
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'allowed', text: 'review', kind: 'task' });
  await manager.flush();
  assert.equal(writes.length, 1);
  await manager.call('a', 'agent_group_task', { action: 'complete' });
  await assert.rejects(manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'next', text: 'next task' }), /终止条件/);
  assert.equal((await channels.inbox({ endpointId: 'b' })).length, 1);
});

test('members hand off tasks and files directly into a busy Codex turn without waking the coordinator', async t => {
  const { storage, sessions, manager, channels, writes, empty } = await fixture(t, ['a', 'b', 'c']);
  sessions.groups = new SessionGroups({ pluginId: 'one', storage, sessions });
  sessions.groups.records = [{ id: 'team', name: 'Team', collaboration: true, coordinatorId: 'a' }];
  sessions.coordination = new SessionCoordination({ pluginId: 'one', sessions, storage, messages: manager });
  await sessions.coordination.load();
  empty('a');
  await manager.call('a', 'agent_group_task', { action: 'start', terminationCondition: '联调通过后停止' });
  const assignment = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'backend', text: '完成接口后交给前端', kind: 'task' });
  await manager.flush();
  const path = `${storage.root}/api.md`;
  await writeFile(path, 'API contract');
  const c = sessions.active.get('c');
  c.activity = 'working';
  empty('c');
  const handoff = await manager.call('b', 'agent_session_send', { targetId: 'c', requestId: 'frontend',
    text: '接口就绪，请按附件联调', files: [path], kind: 'task', replyTo: assignment.messageId });
  await manager.flush();
  assert.equal(writes.length, 2, 'busy next executor receives the handoff as steering');
  assert.equal((await channels.inbox({ endpointId: 'c', messageId: handoff.messageId }))[0].status, 'delivered');
  assert.deepEqual(sessions.coordination.summary(sessions.active.get('a')).waitingFor, ['c']);
  assert.equal(c.activity, 'working');
  assert.deepEqual(writes.map(write => write.id), ['b', 'c']);
  assert.match(writes[1].data, /接口就绪/);
  const received = (await channels.inbox({ endpointId: 'c', messageId: handoff.messageId }))[0];
  assert.equal(received.status, 'delivered');
  assert.equal(await readFile(received.attachments[0].path, 'utf8'), 'API contract');
  const result = await manager.call('c', 'agent_session_send', { targetId: 'b', requestId: 'frontend-result',
    text: '联调通过', kind: 'result', replyTo: handoff.messageId });
  await manager.flush();
  assert.equal(writes.length, 2, 'requester is still busy');
  const b = sessions.active.get('b');
  b.activity = 'done';
  b.sequence++;
  empty('b', { sequence: b.sequence });
  await manager.flush();
  assert.equal((await channels.inbox({ endpointId: 'b', messageId: result.messageId }))[0].status, 'delivered');
  assert.deepEqual(writes.map(write => write.id), ['b', 'c', 'b']);
  assert.equal(sessions.coordination.snapshot('team').outstanding.length, 0);
  assert.equal((await channels.inbox({ endpointId: 'a' })).some(message => message.recipient === 'a'), false);
});

test('idle recipient submits one round, busy FIFO resumes only with a fresh empty composer', async t => {
  const { manager, sessions, writes, empty } = await fixture(t);
  const first = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'one', text: 'review' });
  await manager.flush();
  const second = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'two', text: 'next' });
  await manager.flush();
  assert.equal(writes.length, 1);
  assert.match(writes[0].data, /review/);
  assert.match(writes[0].data, /不代表用户授权/);
  assert.equal((await manager.call('a', 'agent_messages_read', { messageId: first.messageId }))[0].status, 'delivered');
  assert.equal(second.status, 'pending');
  const b = sessions.active.get('b');
  b.activity = 'done';
  b.sequence++;
  empty('b', { sequence: b.sequence });
  await manager.flush();
  assert.equal(writes.length, 2);
});

test('busy Codex receives successive messages as native steering with fresh empty composer acknowledgements', async t => {
  const { manager, sessions, channels, writes, empty } = await fixture(t);
  sessions.groups.records[0].coordinatorId = 'a';
  const b = sessions.active.get('b');
  b.activity = 'working';
  const first = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'steer-one', text: '先处理新的任务', kind: 'task' });
  await manager.flush();
  assert.equal(writes.length, 1, 'the running turn must receive the task without becoming idle');
  assert.match(writes[0].data, /先处理新的任务/);
  assert.ok(writes[0].data.endsWith('\x1b[201~\r'), 'Enter steers the current Codex turn; Tab would queue it');
  assert.equal((await channels.inbox({ endpointId: 'b', messageId: first.messageId }))[0].status, 'delivered');
  const second = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'steer-two', text: '补充验收条件', kind: 'task' });
  await manager.flush();
  assert.equal(writes.length, 1, 'stale composer acknowledgement cannot accept another paste');
  empty('b');
  await manager.flush();
  assert.equal(writes.length, 2);
  assert.equal(b.activity, 'working');
  assert.equal((await channels.inbox({ endpointId: 'b', messageId: second.messageId }))[0].status, 'delivered');
});

test('steering a running submitted user turn still preserves an unsent user draft', async t => {
  const { manager, sessions, writes, empty, channels } = await fixture(t);
  const b = sessions.active.get('b');
  sessions.write('one', 'b', '原任务\r');
  b.activity = 'working';
  manager.observeActivity(b);
  empty('b');
  const message = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'steer-user-turn', text: '新的任务' });
  await manager.flush();
  assert.equal(writes.length, 2, 'submitted user turn must not hold steering until completion');
  sessions.write('one', 'b', '未发送草稿');
  empty('b');
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'protect-draft', text: '等待草稿' });
  await manager.flush();
  assert.equal(writes.length, 3, 'an unsent user draft still blocks automatic input');
  assert.equal((await channels.inbox({ endpointId: 'b', messageId: message.messageId }))[0].status, 'delivered');
});

test('busy Codex steering still waits for approval and fresh composer state', async t => {
  const { manager, sessions, writes, empty, channels } = await fixture(t);
  const b = sessions.active.get('b');
  b.activity = 'working';
  b.blocked = 'permission';
  const message = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'approval', text: 'new task' });
  await manager.flush();
  assert.equal(writes.length, 0);
  assert.equal(manager.reason(b), 'confirmation');
  b.blocked = null;
  empty('b', { empty: false, composing: true });
  await manager.flush();
  assert.equal(writes.length, 0);
  assert.equal(manager.reason(b), 'draft');
  empty('b');
  await manager.flush();
  assert.equal(writes.length, 1);
  assert.equal(b.activity, 'working');
  assert.equal((await channels.inbox({ endpointId: 'b', messageId: message.messageId }))[0].status, 'delivered');
});

test('confirmation, unknown, offline, draft, composition and another view all hold the queue', async t => {
  const { manager, sessions, writes, empty } = await fixture(t);
  const b = sessions.active.get('b');
  for (const patch of [{ blocked: 'question' }, { activity: 'unknown' }, { exited: true }]) {
    Object.assign(b, { activity: 'done', blocked: null, exited: false }, patch);
    assert.ok(manager.reason(b));
  }
  Object.assign(b, { activity: 'done', blocked: null, exited: false });
  empty('b', { empty: false, composing: true, clientId: 'second' });
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'draft', text: 'queued' });
  await manager.flush();
  assert.equal(writes.length, 0);
  manager.composer('b', { clientId: 'second', version: Date.now() + 1, detached: true });
  await manager.flush();
  assert.equal(writes.length, 1);
});

for (const activity of ['done', 'working']) {
  test(`a user keystroke racing with claim while ${activity} returns message to pending without overwriting input`, async t => {
    const { channels, manager, sessions, writes, empty } = await fixture(t);
    sessions.active.get('b').activity = activity;
    const claim = channels.claim;
    channels.claim = async input => {
      const result = await claim(input);
      void sessions.write('one', 'b', 'my draft');
      return result;
    };
    empty('b');
    const message = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'race', text: 'queued' });
    await manager.flush();
    assert.deepEqual(writes, [{ id: 'b', data: 'my draft' }]);
    assert.equal((await channels.inbox({ endpointId: 'b', messageId: message.messageId }))[0].status, 'pending');
  });
}

test('membership persistence blocks peer delivery and failure never exposes the proposed group', async t => {
  const { storage, manager, sessions, writes, empty } = await fixture(t);
  const recipient = sessions.active.get('b');
  recipient.activity = 'unknown';
  const message = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'membership-race', text: 'queued' });
  await manager.flush();
  recipient.groupId = 'old';
  recipient.activity = 'done';
  empty('b');
  await manager.flush();
  const groups = new SessionGroups({ pluginId: 'one', storage, sessions });
  groups.records = [{ id: 'team', name: 'Team', collaboration: true }];
  let rejectWrite;
  let started;
  const saving = new Promise(resolve => { started = resolve; });
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async (path, value) => {
    if (path !== sessions.key(recipient)) { return write(path, value); }
    started();
    await new Promise((_resolve, reject) => { rejectWrite = reject; });
  };
  const assignment = groups.assign('b', 'team');
  const failure = assert.rejects(assignment, /disk failure/);
  await saving;
  await manager.flush();
  assert.equal(writes.length, 0);
  assert.equal(recipient.groupId, 'old');
  rejectWrite(Error('disk failure'));
  await failure;
  await manager.flush();
  assert.equal(writes.length, 0);
  assert.equal(recipient.groupId, 'old');
  assert.equal((await manager.call('a', 'agent_messages_read', { messageId: message.messageId }))[0].status, 'pending');
});

test('file transfer is a host snapshot and archive pauses stable endpoint until restore', async t => {
  const { storage, manager, sessions, writes, channels, empty } = await fixture(t);
  const path = `${storage.root}/brief.md`;
  await writeFile(path, 'original');
  sessions.active.get('b').activity = 'working';
  const message = await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'file', text: 'read', files: [path] });
  assert.equal(await readFile(message.attachments[0].path, 'utf8'), 'original');
  sessions.active.delete('b');
  await manager.sync();
  assert.equal((await channels.list({})).some(e => e.endpointId === 'b'), false);
  sessions.active.set('new-b', { id: 'new-b', restoredFrom: 'b', groupId: 'team', pluginId: 'one', adapterId: 'claude', protocol: 'managed-terminal',
    activity: 'done', sequence: 2, terminal: { write: data => writes.push({ id: 'new-b', data }) } });
  await manager.sync();
  empty('new-b', { sequence: 2 });
  await manager.flush();
  assert.match(writes[0].data, /brief.md/);
  assert.match(writes[0].data, new RegExp(message.messageId));
  await manager.deleted(sessions.active.get('new-b'));
  assert.equal((await channels.list({})).some(e => e.endpointId === 'b'), false);
});

test('permanent deletion never re-registers a still-listed native context', async t => {
  const { manager, sessions, channels } = await fixture(t);
  const session = sessions.active.get('b');
  session.nativeDeleted = true;
  await manager.deleted(session);
  await manager.flush();
  assert.equal((await channels.list({})).some(entry => entry.endpointId === 'b'), false);
});

test('authenticated Codex and Claude relay clients discover peers and exchange file-backed messages', async t => {
  const { manager, storage, writes, empty } = await fixture(t);
  const clients = [];
  for (const [index, engine] of ['codex', 'claude'].entries()) {
    const sessionId = index ? 'b' : 'a';
    const relay = new McpRelay({ pluginId: 'one', sessionId,
      builtin: { tools: sessionTools, call: (name, args) => manager.call(sessionId, name, args) } });
    await relay.start(engine, engine === 'claude' ? { mcpServers: {} } : []);
    const client = new Client({ name: `fixture-${engine}`, version: '1' });
    t.after(async () => { await client.close(); await relay.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${relay.url}/desk_agent_sessions`),
      { requestInit: { headers: { Authorization: `Bearer ${relay.token}` } } }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), sessionTools.map(tool => tool.name));
    clients.push(async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text));
  }
  const [a, b] = clients;
  assert.deepEqual((await a('agent_sessions_list')).sessions.map(entry => entry.endpointId), ['b']);
  assert.deepEqual((await b('agent_sessions_list')).sessions.map(entry => entry.endpointId), ['a']);
  const path = `${storage.root}/handoff.md`;
  await writeFile(path, 'handoff bytes');
  const input = { targetId: 'b', requestId: 'integration-file', text: 'please review', files: [path] };
  const first = await a('agent_session_send', input);
  assert.equal((await a('agent_session_send', input)).messageId, first.messageId);
  await manager.flush();
  assert.equal(writes.filter(write => write.id === 'b').length, 1);
  assert.match(writes[0].data, /handoff.md/);
  assert.equal(await readFile(first.attachments[0].path, 'utf8'), 'handoff bytes');
  assert.equal((await a('agent_messages_read', { messageId: first.messageId }))[0].status, 'delivered');
  empty('a');
  const reply = await b('agent_session_send', { targetId: 'a', requestId: 'integration-reply', text: 'review complete', replyTo: first.messageId });
  await manager.flush();
  assert.equal(writes.filter(write => write.id === 'a').length, 1);
  assert.equal((await b('agent_messages_read', { messageId: reply.messageId }))[0].replyTo, first.messageId);
});


test('an unrelated repaint cannot acknowledge a user draft; observed native clear releases it', async t => {
  const { manager, sessions, writes, empty } = await fixture(t);
  const b = sessions.active.get('b');
  sessions.write('one', 'b', 'draft');
  b.sequence++;
  empty('b', { sequence: b.sequence, nativeEmpty: true });
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'repaint', text: 'peer' });
  await manager.flush();
  assert.equal(writes.length, 1);
  empty('b', { sequence: b.sequence, empty: false, nativeEmpty: false, nativeDraft: true });
  empty('b', { sequence: b.sequence, nativeEmpty: true });
  await manager.flush();
  assert.equal(writes.length, 2);
});

test('a reconnected view can replace an expired lease while backend draft protection remains', async t => {
  const { manager, sessions, empty } = await fixture(t);
  const b = sessions.active.get('b');
  manager.views.get('b').get('view').receivedAt -= 6000;
  empty('b', { clientId: 'reconnected', nativeEmpty: true });
  assert.equal(manager.reason(b), null);
  sessions.write('one', 'b', 'draft');
  manager.views.get('b').get('reconnected').receivedAt -= 6000;
  empty('b', { clientId: 'again', nativeEmpty: true });
  assert.equal(manager.reason(b), 'input_pending');
  await manager.flush();
});


test('a completed submitted user round releases input protection but an unfinished draft does not', async t => {
  const { sessions, manager, empty } = await fixture(t);
  const b = sessions.active.get('b');
  sessions.write('one', 'b', 'question\r');
  b.activity = 'working';
  manager.observeActivity(b);
  b.activity = 'done';
  manager.observeActivity(b);
  empty('b');
  assert.equal(manager.reason(b), null);
  sessions.write('one', 'b', 'unfinished');
  b.activity = 'working';
  manager.observeActivity(b);
  b.activity = 'done';
  manager.observeActivity(b);
  empty('b');
  assert.equal(manager.reason(b), 'input_pending');
  await manager.flush();
});

test('terminal negotiation replies never become pending user input or delay peer delivery', async t => {
  const { sessions, manager, writes, empty } = await fixture(t);
  const b = sessions.active.get('b');
  const replies = ['\x1b[I', '\x1b[O', '\x1b[1;1R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[?25;1$y',
    '\x1b[8;28;110t', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'];
  for (const reply of replies) {
    await sessions.write('one', 'b', reply);
  }
  assert.equal(b.pendingUserInput, undefined);
  assert.equal(b.inputRevision, undefined);
  assert.equal(b.lastInputAt, undefined);
  empty('b', { nativeEmpty: true });
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'negotiation', text: 'start now' });
  await manager.flush();
  assert.equal(writes.length, replies.length + 1);
  assert.match(writes.at(-1).data, /start now/);
  assert.ok(writes.at(-1).data.endsWith('\x1b[201~\r'));
  await sessions.write('one', 'b', 'real user draft');
  const pending = b.pendingUserInput;
  const revision = b.inputRevision;
  const inputAt = b.lastInputAt;
  await sessions.write('one', 'b', '\x1b[O');
  assert.equal(b.pendingUserInput, pending);
  assert.equal(b.inputRevision, revision);
  assert.equal(b.lastInputAt, inputAt);
});

test('native mouse reports never create a draft guard or replace an existing submitted turn', async t => {
  const { sessions, manager, writes, empty } = await fixture(t);
  const b = sessions.active.get('b');
  const reports = ['\x1b[<64;30;10M', '\x1b[<65;30;10M', '\x1b[<0;30;10M', '\x1b[<0;30;10m', '\x1b[M !!'];
  for (const report of reports) {
    await sessions.write('one', 'b', report);
  }
  assert.equal(b.pendingUserInput, undefined);
  assert.equal(b.inputRevision, undefined);
  assert.equal(b.lastInputAt, undefined);
  empty('b', { nativeEmpty: true });
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'mouse', text: 'execute after scrolling' });
  await manager.flush();
  assert.equal(writes.length, reports.length + 1);
  assert.match(writes.at(-1).data, /execute after scrolling/);
  await sessions.write('one', 'b', 'user question\r');
  const pending = b.pendingUserInput;
  const revision = b.inputRevision;
  await sessions.write('one', 'b', reports[0]);
  assert.equal(b.pendingUserInput, pending);
  assert.equal(b.inputRevision, revision);
});

test('clearing an observed native draft by keyboard releases the queue without losing a subsequent new draft', async t => {
  const { sessions, manager, writes, empty } = await fixture(t);
  const b = sessions.active.get('b');
  await sessions.write('one', 'b', 'draft');
  empty('b', { empty: false, nativeDraft: true });
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'clear-draft', text: 'peer after clear' });
  await sessions.write('one', 'b', '\x15');
  empty('b', { nativeEmpty: true });
  await manager.flush();
  assert.match(writes.at(-1).data, /peer after clear/);
  b.activity = 'done';
  await sessions.write('one', 'b', 'another draft');
  empty('b', { empty: false, nativeDraft: true });
  await sessions.write('one', 'b', '\x7f');
  await sessions.write('one', 'b', 'new text before repaint');
  empty('b', { nativeEmpty: true });
  assert.equal(manager.reason(b), 'input_pending', 'new text cannot inherit an old draft acknowledgement');
});

test('native activity callbacks release a Claude submitted turn and automatically drain its queued peer message', async t => {
  const { sessions, manager, storage, writes, empty } = await fixture(t);
  const pty = fakePty();
  let activity;
  sessions.spawn = pty.spawn;
  sessions.guard = (_id, action) => action();
  sessions.readGit = null;
  sessions.processControl = async session => session.terminal.kill();
  sessions.adapter = () => ({
    prepareActivity: changed => { activity = changed; },
    buildLaunch: () => ({ command: 'fixture', args: [], env: {}, isolated: true })
  });
  const record = await sessions.create('one', { adapterId: 'claude', groupId: 'team', cwd: storage.root });
  t.after(() => sessions.archive('one', record.id));
  const recipient = sessions.get('one', record.id);
  recipient.terminal.write = data => writes.push({ id: recipient.id, data });
  activity({ activity: 'done' });
  await sessions.write('one', record.id, 'user question\r');
  activity({ activity: 'working' });
  empty(record.id, { sequence: recipient.sequence });
  const message = await manager.call('a', 'agent_session_send', { targetId: record.id, requestId: 'callback', text: 'continue automatically' });
  await manager.flush();
  assert.equal(writes.length, 1, 'busy recipient queues without interrupting the user turn');
  activity({ activity: 'done' });
  await manager.flush();
  assert.equal(writes.length, 2, 'native completion must drain the queue without another terminal output or user action');
  assert.match(writes.at(-1).data, /continue automatically/);
  assert.equal((await manager.call('a', 'agent_messages_read', { messageId: message.messageId }))[0].status, 'delivered');
});


test('discovery and sending enforce group membership even with a known endpoint ID', async t => {
  const { manager, sessions, writes } = await fixture(t);
  sessions.active.set('c', { ...sessions.active.get('b'), id: 'c', groupId: 'another' });
  assert.deepEqual((await manager.call('a', 'agent_sessions_list')).sessions.map(entry => entry.endpointId), ['b']);
  await assert.rejects(manager.call('a', 'agent_session_send', { targetId: 'c', requestId: 'cross', text: 'cross group' }), { code: 'GROUP_MISMATCH' });
  sessions.active.get('a').groupId = undefined;
  await assert.rejects(manager.call('a', 'agent_sessions_list'), { code: 'COLLABORATION_DISABLED' });
  await assert.rejects(manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'ungrouped', text: 'old session' }),
    { code: 'COLLABORATION_DISABLED' });
  await manager.flush();
  assert.equal(writes.length, 0);
});

test('a queued message stops at the group boundary after membership changes', async t => {
  const { manager, sessions, writes, empty } = await fixture(t);
  const b = sessions.active.get('b');
  b.activity = 'working';
  await manager.call('a', 'agent_session_send', { targetId: 'b', requestId: 'before-move', text: 'old group work' });
  b.groupId = 'another';
  b.activity = 'done';
  empty('b');
  await manager.flush();
  assert.equal(writes.length, 0);
});

test('an assigned historical member restores into group discovery and automatically drains messages', async t => {
  const { sessions, manager, storage, writes, empty } = await fixture(t);
  const pty = fakePty();
  sessions.spawn = pty.spawn;
  sessions.guard = (_id, action) => action();
  sessions.readGit = null;
  sessions.processControl = async session => session.terminal.kill();
  sessions.adapter = () => ({ capabilities: {}, buildLaunch: () => ({ command: 'fixture', args: [], env: {}, isolated: true }) });
  const groups = new SessionGroups({ pluginId: 'one', storage, sessions });
  groups.records = [{ id: 'team', name: '短剧开发', collaboration: true }];
  sessions.groups = groups;
  const original = await sessions.create('one', { name: '历史后端', adapterId: 'codex', cwd: storage.root });
  await sessions.archive('one', original.id);
  await assert.rejects(manager.call('a', 'agent_session_send', { targetId: original.id, requestId: 'before-group', text: 'handoff' }),
    { code: 'GROUP_MISMATCH' });
  await groups.assign(original.id, 'team');
  const restored = await sessions.restore('one', original.id);
  t.after(() => sessions.archive('one', restored.id));
  const recipient = sessions.get('one', restored.id);
  recipient.terminal.write = data => writes.push({ id: restored.id, data });
  recipient.activity = 'done';
  empty(restored.id, { sequence: recipient.sequence });
  const peers = (await manager.call('a', 'agent_sessions_list')).sessions;
  assert.equal(peers.find(peer => peer.endpointId === original.id).metadata.name, '历史后端');
  const first = await manager.call('a', 'agent_session_send', { targetId: original.id, requestId: 'restored-handoff', text: 'execute handoff' });
  await manager.flush();
  assert.equal(writes.length, 1);
  assert.match(writes[0].data, /execute handoff/);
  assert.equal((await manager.call('a', 'agent_messages_read', { messageId: first.messageId }))[0].status, 'delivered');
  await manager.call('a', 'agent_session_send', { targetId: original.id, requestId: 'restored-queue', text: 'queued followup' });
  await manager.flush();
  assert.equal(writes.length, 1, 'a busy restored member retains the queued message');
  recipient.activity = 'done';
  recipient.sequence++;
  empty(restored.id, { sequence: recipient.sequence });
  await manager.flush();
  assert.equal(writes.length, 2);
  assert.match(writes[1].data, /queued followup/);
});

test('ordinary groups expose no tools, endpoints or automatic delivery', async t => {
  const { manager, sessions, channels, writes } = await fixture(t);
  sessions.groups.records[0].collaboration = false;
  assert.deepEqual(manager.tools('a'), []);
  await manager.sync();
  assert.deepEqual(await channels.list({}), []);
  for (const tool of sessionTools) {
    await assert.rejects(manager.call('a', tool.name), { code: 'COLLABORATION_DISABLED' });
  }
  await manager.deliver(sessions.active.get('b'));
  assert.equal(writes.length, 0);
  sessions.groups.records[0].collaboration = true;
  assert.equal(manager.tools('a').length, sessionTools.length);
  await manager.sync();
  assert.equal((await channels.list({})).length, 2);
});
