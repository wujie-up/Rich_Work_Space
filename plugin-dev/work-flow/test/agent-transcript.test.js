import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTranscript } from '../src/renderer/agent-transcript.js';

test('stream deltas merge across pages, deduplicate sequences and replace with final text', () => {
  const transcript = new AgentTranscript();
  let entry;
  for (let sequence = 1; sequence <= 1000; sequence++) {
    entry = transcript.add({ sequence, method: 'item/agentMessage/delta', params: { itemId: 'one', delta: '字' } });
  }
  assert.equal(entry.text.length, 1000);
  assert.equal(entry.id, 1);
  assert.equal(transcript.add({ sequence: 1000, method: 'item/agentMessage/delta', params: { delta: '重复' } }), null);
  assert.equal(transcript.add({ sequence: 1001, method: 'item/completed', params: { item: { id: 'one', type: 'agentMessage', text: '完整内容' } } }).text, '完整内容');
  transcript.add({ sequence: 1002, method: 'user/message', params: { text: '下轮' } });
  const next = transcript.add({ sequence: 1003, method: 'item/agentMessage/delta', params: { itemId: 'one', delta: '新的' } });
  assert.notEqual(next.id, entry.id);
  assert.equal(next.round, 1);
});

test('fallback chunks merge only until a tool, final message or turn boundary', () => {
  const transcript = new AgentTranscript();
  const event = (sequence, method, params) => transcript.add({ sequence, method, params });
  const first = event(1, 'item/agentMessage/delta', { delta: '你' });
  assert.equal(event(2, 'item/agentMessage/delta', { delta: '好' }).text, '你好');
  event(3, 'item/completed', { item: { type: 'agentMessage', text: '你好！' } });
  assert.equal(first.text, '你好！');
  const next = event(4, 'item/completed', { item: { type: 'agentMessage', text: '另一条' } });
  assert.notEqual(next.id, first.id);
  event(5, 'tool/call', { command: 'test' });
  assert.notEqual(event(6, 'item/agentMessage/delta', { delta: '完成' }).id, next.id);
});
