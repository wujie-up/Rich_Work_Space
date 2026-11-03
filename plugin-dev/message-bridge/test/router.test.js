import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, messageKey, bindingKey, splitText } from '../src/main/common/router.js';

const message = { channelId: 'channel', messageId: 'one', chatId: 'room', chatType: 'group', senderId: 'alice', text: '/agent hello' };
const rule = { id: 'rule', enabled: true, channelId: 'channel', chatIds: ['room'], senderIds: ['alice'],
  trigger: { type: 'prefix', value: '/agent' }, priority: 1 };

test('channel rules forward literal @ prefixes and appended transcripts without ID setup', () => {
  const simple = { ...rule, sourceMode: 'channel', chatIds: undefined, senderIds: undefined, trigger: { type: 'prefix', value: '@小微' } };
  for (const text of ['@小微 帮我总结\n甲：你好\n乙：收到', '@小微帮我总结\n甲：你好\n乙：收到']) {
    assert.equal(matchRoute([simple], { ...message, senderId: 'new-user', chatId: 'new-room', text }).text, '帮我总结\n甲：你好\n乙：收到');
  }
  assert.equal(matchRoute([simple], { ...message, text: '聊天中提到 @小微 帮忙' }), null);
  assert.equal(matchRoute([simple], { ...message, channelId: 'another', text: '@小微 hi' }), null);
  assert.equal(matchRoute([simple], { ...message, self: true, text: '@小微 hi' }), null);
  assert.equal(matchRoute([simple], { ...message, text: '@小微' }), null);
});

test('allowlist precedes triggers; own messages and ambiguous priorities never dispatch', () => {
  assert.equal(matchRoute([{ ...rule, senderIds: ['bob'] }], message), null);
  assert.equal(matchRoute([rule], { ...message, self: true }), null);
  assert.equal(matchRoute([rule], { ...message, text: '/agentx hello' }), null);
  assert.equal(matchRoute([rule], message).text, 'hello');
  assert.throws(() => matchRoute([rule, { ...rule, id: 'two' }], message), /优先级/);
  assert.equal(matchRoute([rule, { ...rule, priority: 2, id: 'two' }], message).route.id, 'two');
  assert.equal(matchRoute([{ ...rule, trigger: { type: 'keyword', value: 'error' } }], { ...message, text: 'an error happened' }).text, 'an error happened');
  assert.equal(matchRoute([{ ...rule, trigger: { type: 'mention' } }], { ...message, mentioned: true }).route.id, 'rule');
});

test('stable identities distinguish source accounts and private/group sources without concatenation collisions', () => {
  assert.equal(messageKey(message), messageKey({ ...message, text: 'changed' }));
  assert.notEqual(messageKey(message), messageKey({ ...message, channelId: 'other' }));
  assert.notEqual(bindingKey(rule, message), bindingKey(rule, { ...message, senderId: 'bob' }));
  assert.notEqual(bindingKey(rule, message), bindingKey(rule, { ...message, chatType: 'private' }));
  assert.equal(bindingKey({ ...rule, scope: 'chat' }, message), bindingKey({ ...rule, scope: 'chat' }, { ...message, senderId: 'bob' }));
});

test('fixed Unicode-safe chunks are stable across retries and bounded in UTF-8 bytes', () => {
  const input = '你好🙂'.repeat(1000);
  const chunks = splitText(input, 1000);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 1000));
  assert.deepEqual(splitText(input, 1000), chunks);
});
