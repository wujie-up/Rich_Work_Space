import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionTranscript, transcriptMessages } from '../src/main/common/session-transcript.js';

const message = (role, text) => ({ role, text });
const record = (type, payload) => JSON.stringify({ type, payload });
test('concise transcript keeps user input and assistant output while excluding reasoning and tool payloads', () => {
  const lines = [
    record('response_item', { role: 'user', content: [{ type: 'text', text: '用户的问题' }] }),
    record('response_item', { role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'reasoning' }] }),
    record('response_item', { type: 'function_call', arguments: 'tool secret' }),
    record('response_item', { role: 'assistant', content: [{ type: 'output_text', text: '**完成**\n- 已验证' }] }),
    record('event_msg', { type: 'agent_message', message: '**完成**\n- 已验证' }),
    'incomplete json'
  ];
  assert.deepEqual(transcriptMessages(lines, 'codex'), [message('user', '用户的问题'), message('assistant', '**完成**\n- 已验证')]);
  assert.deepEqual(transcriptMessages([
    JSON.stringify({ type: 'assistant', uuid: 'one', message: { content: [
      { type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', input: 'hidden' }, { type: 'text', text: '结果' }
    ] } }), JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '追问' }] } })
  ], 'claude'), [message('assistant', '结果'), message('user', '追问')]);
});

test('concise transcript reads isolated engine profiles, updates cached files and ignores incomplete records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'profiles', 'default', 'codex', 'sessions', '2026');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rollout-context.jsonl');
  const first = record('event_msg', { type: 'agent_message', message: '第一条' });
  await writeFile(path, `${first}\n{`);
  const read = sessionTranscript(root);
  const session = { id: 'window', adapterId: 'codex', contextId: 'context' };
  assert.deepEqual((await read(session)).messages, [message('assistant', '第一条')]);
  await writeFile(path, `${first}\n`);
  await appendFile(path, `${record('event_msg', { type: 'task_complete', last_agent_message: '第二条' })}\n`);
  assert.deepEqual((await read(session)).messages, [message('assistant', '第一条'), message('assistant', '第二条')]);
  assert.equal((await read({ ...session, contextId: 'missing' })).available, false);
  assert.equal((await read({ ...session, adapterId: 'unsupported' })).available, false);
  const claude = join(root, 'engines', 'claude', 'profiles', 'account', 'claude', 'projects', 'project');
  await mkdir(claude, { recursive: true });
  await writeFile(join(claude, 'context.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Claude结果' }] } })}\n`);
  assert.deepEqual((await read({ ...session, adapterId: 'claude', profileId: 'account' })).messages, [message('assistant', 'Claude结果')]);
  await writeFile(path, `${'x'.repeat(600000)}\n${first}\n`);
  const tail = await read(session);
  assert.equal(tail.truncated, true);
  assert.deepEqual(tail.messages, [message('assistant', '第一条')]);
});

test('concise transcript preserves repeated turns and event-only user input', () => {
  assert.deepEqual(transcriptMessages([
    record('event_msg', { type: 'user_message', message: '继续' }),
    record('event_msg', { type: 'agent_message', message: '完成' }),
    record('event_msg', { type: 'task_complete', last_agent_message: '完成' }),
    record('event_msg', { type: 'user_message', message: '继续' }),
    record('event_msg', { type: 'agent_message', message: '完成' })
  ], 'codex'), [message('user', '继续'), message('assistant', '完成'), message('user', '继续'), message('assistant', '完成')]);
  assert.deepEqual(transcriptMessages([
    record('response_item', { role: 'user', content: [{ type: 'input_text', text: '继续' }] }),
    record('response_item', { role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }),
    record('response_item', { role: 'user', content: [{ type: 'input_text', text: '继续' }] }),
    record('response_item', { role: 'assistant', content: [{ type: 'output_text', text: '完成' }] })
  ], 'codex'), [message('user', '继续'), message('assistant', '完成'), message('user', '继续'), message('assistant', '完成')]);
});
