import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginMessages } from '../src/main/common/plugin-messages.js';

test('plugin messages queue, deduplicate, answer once and revoke only their owner', async () => {
  const messages = new PluginMessages();
  const owner = { id: 'one', instanceId: 'a' };
  const other = { id: 'two', instanceId: 'b' };
  const first = messages.request(owner, { key: 'q', title: 'Question', question: 'Choose', options: ['A', 'B'] });
  assert.equal(messages.request(owner, { key: 'q', title: 'Question', question: 'Choose' }).id, first.id);
  const second = messages.request(other, { title: 'Other', question: 'Text' });
  assert.equal(messages.list().length, 2);
  assert.throws(() => messages.get(other, first.id), /所属/);
  await messages.respond(first.id, { text: 'A' });
  assert.equal(messages.get(owner, first.id).answer.text, 'A');
  await assert.rejects(messages.respond(first.id, { text: 'B' }), /失效/);
  messages.revoke(other);
  assert.equal(messages.get(other, second.id).state, 'cancelled');
  assert.equal(messages.get(owner, first.id).state, 'answered');
});

test('desktop dismissal is visible to the owner and cannot answer a deferred message', async () => {
  const messages = new PluginMessages();
  const owner = { id: 'flow' };
  const request = messages.request(owner, { title: '问题', question: '请选择' });
  messages.defer(request.id);
  assert.equal(messages.get(owner, request.id).state, 'deferred');
  assert.equal(messages.list().length, 0);
  await assert.rejects(messages.respond(request.id, { text: 'A' }), /失效/);
  assert.equal(messages.defer(request.id).state, 'deferred');
});

test('required structured messages stay pending until answered or revoked', async () => {
  const messages = new PluginMessages();
  const owner = { id: 'flow' };
  const sections = [{ title: '待确认', items: [{ title: '确定范围', detail: '请选择本轮范围', priority: 'P0' }] }];
  let attempts = 0;
  const request = messages.request(owner, { title: '问题', question: '原文', required: true, placement: 'center', sections }, () => {
    if (++attempts === 1) { throw new Error('重试'); }
  });
  assert.equal(request.required, true);
  assert.deepEqual(request.sections, sections);
  assert.throws(() => messages.defer(request.id), /必须/);
  await assert.rejects(messages.respond(request.id, { text: 'A' }), /重试/);
  assert.equal(messages.get(owner, request.id).state, 'pending');
  await messages.respond(request.id, { text: 'A' });
  assert.equal(messages.get(owner, request.id).state, 'answered');
  const next = messages.request(owner, { title: '问题', question: '原文', required: true });
  assert.equal(messages.cancel(owner, next.id).state, 'cancelled');
  const last = messages.request(owner, { title: '问题', question: '原文', required: true });
  messages.revoke(owner);
  assert.equal(messages.get(owner, last.id).state, 'cancelled');
});

test('message presentation accepts only bounded text sections and known placement', () => {
  const messages = new PluginMessages();
  const owner = { id: 'flow' };
  for (const extra of [{ placement: 'bad' }, { required: 'yes' }, { sections: [{}] },
    { sections: [{ title: '标题', items: [{ title: '标题', detail: {} }] }] }]) {
    assert.throws(() => messages.request(owner, { title: '标题', question: '原文', ...extra }), /无效/);
  }
});


test('owner revocation during delivery cannot resurrect a required prompt or accept a second response', async () => {
  const messages = new PluginMessages();
  const owner = { id: 'flow' };
  let release;
  const request = messages.request(owner, { title: '授权', question: '允许？', required: true },
    () => new Promise(resolve => { release = resolve; }));
  const sending = messages.respond(request.id, { text: '允许' });
  assert.equal(messages.list().length, 1, 'keep prompt live while delivery is pending');
  await assert.rejects(messages.respond(request.id, { text: '拒绝' }), /失效/);
  messages.revoke(owner);
  release();
  await sending;
  assert.equal(messages.get(owner, request.id).state, 'cancelled');
  assert.equal(messages.list().length, 0);
});
