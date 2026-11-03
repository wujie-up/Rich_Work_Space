import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundSessions, registerBackgroundSessions } from '../src/main/common/background-sessions.js';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { matchesSchema } from '../../../desk/src/main/common/capability-schema.js';

test('后台会话入口允许超过十万字符的输入，空文本仍被 Schema 拒绝', async () => {
  const registrations = new Map();
  await registerBackgroundSessions({ register: async descriptor => registrations.set(descriptor.id, descriptor) }, {});
  const schema = registrations.get('agent.session.start.v1').inputSchema;
  const input = { bindingKey: 'run:node', taskKey: 'a'.repeat(64), prompt: '文'.repeat(150000), mode: 'plan' };
  assert.equal(matchesSchema(input, schema), true);
  assert.equal(matchesSchema({ ...input, prompt: '' }, schema), false);
});

test('background binding reuses conversation, rejects another caller, archives in place and retains history', async t => {
  const storage = await temporaryStore(t);
  const records = new Map();
  const tasks = { records, async start(kind, input, execution) {
    records.set(input.taskKey, { ...input, kind, conversationId: execution.conversationId || 'conversation-one', state: 'running' });
    return { state: 'running' };
  }, get: key => records.get(key), read: async ({ taskKey }) => records.get(taskKey), cancel: async () => {},
    respond: async () => ({ accepted: true }) };
  const record = { events: [{ sequence: 1, method: 'user/message' }], state: 'idle' };
  const conversations = { read: () => record, async archive() { record.archivedAt = 'now'; } };
  const sessions = new BackgroundSessions({ tasks, conversations, storage, pluginId: 'ai' });
  await sessions.load();
  const context = { caller: { pluginId: 'flow', instanceId: 'one' }, authorizationId: 'host-lease' };
  const input = { bindingKey: 'run:node', taskKey: 'a'.repeat(64), prompt: 'one', mode: 'plan' };
  await assert.rejects(sessions.start(input, { ...context, authorizationId: undefined }), /授权/);
  const first = await sessions.start(input, context);
  records.get(input.taskKey).state = 'succeeded';
  const second = await sessions.start({ ...input, taskKey: 'b'.repeat(64), sessionId: first.sessionId }, context);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(tasks.get('b'.repeat(64)).conversationId, 'conversation-one');
  assert.throws(() => sessions.get(first.sessionId, { caller: { pluginId: 'other' } }), /所属/);
  await sessions.close({ sessionId: first.sessionId }, context);
  assert.equal((await sessions.history({ sessionId: first.sessionId, limit: 1 }, context)).events.length, 1);
  assert.equal(record.archivedAt, 'now');
  await assert.rejects(sessions.start({ ...input, sessionId: first.sessionId }, context), /归档/);
  const retry = await sessions.start({ ...input, taskKey: 'c'.repeat(64) }, context);
  assert.notEqual(retry.sessionId, first.sessionId, 'retry creates a fresh conversation while retaining old archive');
});
