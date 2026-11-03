import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/main/common/adapters/codex.js';
import { prepareClaudeActivity } from '../src/main/common/adapters/claude-activity.js';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

const question = '需要确认“内容相同”的范围：\n- 固定返回截图信息：可以保持 Mock。\n'
  + '- 每次与上传证件一致：需要真实 OCR。\n\n你希望按哪一种修改？';
const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const event = (type, payload = {}) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg',
  payload: { type, ...payload } }) + '\n';
const status = state => `\x1b]7501;app=codex:state=${state}\x07`;

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), 'session status should update from the completed native reply');
}

test('Codex plain questions become confirmation waits and the next native turn clears them', async t => {
  const storage = await temporaryStore(t);
  const dataRoot = await storage.path('plugin-data/test');
  const directory = join(dataRoot, 'profiles/default/codex/sessions/2026/10/29');
  await mkdir(directory, { recursive: true });
  const rollout = join(directory, `rollout-2026-10-29T13-00-00-${thread}.jsonl`);
  await writeFile(rollout, event('task_started') + event('agent_message', { message: '工具输出：你选哪个？' }));
  const adapter = createCodexAdapter({ dataRoot });
  const pty = fakePty();
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => adapter,
    guard: (_id, work) => work(), processControl: async session => session.terminal.kill() });
  const record = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, contextId: thread });
  t.after(() => sessions.archive('test', record.id));
  const session = sessions.get('test', record.id);
  pty.terminals[0].data(status('working') + question);
  assert.equal(session.blocked, null, 'commentary while working does not request confirmation');
  await appendFile(rollout, event('task_complete', { last_agent_message: question }));
  await until(() => session.blocked === 'question');
  assert.equal(sessions.list('test').sessions[0].question, question, 'only the completed assistant question reaches the view');
  pty.terminals[0].data(status('idle') + 'terminal redraw');
  assert.equal(session.blocked, 'question', 'idle redraws preserve the outstanding question');
  sessions.write('test', record.id, '选择固定返回\r');
  pty.terminals[0].data(status('working') + question);
  assert.equal(session.blocked, null, 'native working clears the previous confirmation');
  assert.equal(session.question, null);
  await appendFile(rollout, event('task_started'));
  pty.terminals[0].data(status('done') + status('idle'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(session.blocked, null, 'an unfinished new turn must not reuse the previous question');
  await appendFile(rollout, event('task_complete', { last_agent_message: '已按固定返回方案修改，验证通过。' }));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(session.blocked, null);
  assert.equal(session.activity, 'idle');
  const delayed = event('task_complete', { last_agent_message: '请确认目标环境。' });
  await appendFile(rollout, event('task_started') + delayed.slice(0, -1));
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(session.blocked, null, 'partial native writes wait for a complete JSONL record');
  await appendFile(rollout, '\n');
  await until(() => session.blocked === 'question');
  pty.terminals[0].data('\x1b]7501;app=codex:state=blocked:kind=permission\x07');
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(session.blocked, 'permission', 'native permission state takes precedence over prose');
  assert.equal(session.question, null, 'native permissions cannot reuse a free-text question');
});

test('Codex completion clears working even when a background terminal reports more activity', async t => {
  const storage = await temporaryStore(t);
  const dataRoot = await storage.path('plugin-data/test');
  const directory = join(dataRoot, 'profiles/default/codex/sessions');
  await mkdir(directory, { recursive: true });
  const rollout = join(directory, `rollout-${thread}.jsonl`);
  await writeFile(rollout, event('task_started'));
  const adapter = createCodexAdapter({ dataRoot });
  const pty = fakePty();
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => adapter,
    guard: (_id, work) => work(), processControl: async session => session.terminal.kill() });
  const record = await sessions.create('test', { adapterId: 'codex', cwd: storage.root, contextId: thread });
  t.after(() => sessions.archive('test', record.id));
  const session = sessions.get('test', record.id);
  const output = data => pty.terminals[0].data(data);
  output(status('working'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(session.activity, 'working', 'silence during an unfinished native turn is not completion');
  await appendFile(rollout, event('task_complete', { last_agent_message: '已确认授权信息保存成功。' }));
  await until(() => session.activity === 'done');
  assert.equal(sessions.list('test').sessions[0].blocked, null);

  await appendFile(rollout, event('item_completed', { item: { type: 'command_execution', status: 'completed' } }));
  output(status('working') + '1 background terminal running · /ps to view · /stop to close');
  await until(() => session.activity === 'done');
  output('\x1b]7501;app=codex:state=blocked:kind=permission\x07');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(session.blocked, 'permission', 'native permission waits take precedence over an older completion');

  sessions.write('test', record.id, '继续执行\r');
  output(status('working'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(session.activity, 'working', 'a previous completion cannot finish newly submitted input');
  await appendFile(rollout, event('task_started'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(session.activity, 'working', 'the latest started turn blocks an earlier completion');
  const final = event('task_complete', { last_agent_message: '已完成后续任务。' });
  await appendFile(rollout, final.slice(0, -1));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(session.activity, 'working', 'partial completion records cannot end the turn');
  await appendFile(rollout, '\n');
  await until(() => session.activity === 'done');
});

test('Claude completed text asks for confirmation without changing native permission decisions', async t => {
  const states = [];
  const monitor = await prepareClaudeActivity(state => states.push(state));
  t.after(() => monitor.close());
  const url = monitor.settings.hooks.Stop[0].hooks[0].url;
  const send = async (hook_event_name, last_assistant_message) => {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ hook_event_name,
      session_id: 'text-confirmation', last_assistant_message }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
    return states.at(-1);
  };
  for (const text of [question, '请选择方案 A 或方案 B。', '请告诉我目标环境。', '还需要继续吗？',
    '你倾向哪个方案', '需要你确认后再继续。', '目标环境是 DEV 还是 FAT？', '麻烦告知目标环境。',
    '两个方案，你选一个。', 'Which approach do you prefer?', 'Please confirm the target environment.',
    'Let me know which option you prefer.']) {
    const state = await send('Stop', text);
    assert.equal(state.blocked, 'question', text);
    assert.equal(state.question, text);
  }
  for (const text of ['已修复并验证通过。', '为什么这样修复？因为旧状态没有清理。',
    '> 你希望按哪一种修改？\n\n已按选定方案完成。', '```js\nconsole.log("请选择方案");\n```\n已完成。',
    '按钮文案为“请选择方案”。', '文档示例：`你希望按哪一种修改？`',
    '文档链接：https://example.test/?question=选择方案', 'I confirmed the selected approach and finished the change.']) {
    const state = await send('Stop', text);
    assert.equal(state.blocked, null, text);
    assert.equal(state.question, null);
  }
  assert.equal((await send('PermissionRequest', question)).blocked, 'permission');
  assert.equal(states.at(-1).question, null);
  assert.equal((await send('UserPromptSubmit', question)).activity, 'working');
  assert.equal(states.at(-1).blocked, null);
});
