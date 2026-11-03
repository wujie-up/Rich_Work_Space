import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Conversations } from '../src/main/common/conversations.js';
import { matchesSchema } from '../../../desk/src/main/common/capability-schema.js';
const module = await import('../src/main/common/tasks.js').catch(() => ({}));
class Native {
  constructor(options) { Object.assign(this, options); this.calls = []; }
  async start() {}
  async request(method, params) {
    this.calls.push({ method, params });
    return method === 'thread/start' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } };
  }
  respond(id, result) { this.response = { id, result }; }
  close() { this.closed = true; }
}
async function fixture(t) {
  assert.equal(typeof module.AgentTasks, 'function');
  let cleanup;
  const storage = await temporaryStore({ after: handler => { cleanup = handler; } });
  const conversations = new Conversations({ storage, pluginId: 'ai-test', Engine: Native, ownProcesses: () => {}, emit: () => {},
    runtime: { launch: async () => ({ env: { HOME: storage.root }, args: [], runtimeId: 'test' }) },
    createGateway: () => ({ token: 'token', url: 'http://localhost/mcp', start: async () => {}, refreshCatalog: async () => false,
      close: async () => {}, cancel: async () => {} }) });
  await conversations.load();
  const tasks = new module.AgentTasks({ conversations, storage, pluginId: 'ai-test' });
  await tasks.load();
  t.after(async () => { await tasks.stop(); await conversations.stop(); await cleanup(); });
  return { tasks, conversations, storage };
}
const wait = async predicate => {
  for (let n = 0; n < 100; n++) {
    const result = await predicate();
    if (result) { return result; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('timeout');
};

test('长文任务不受字符上限拦截，原样交给原生会话并保留压缩事件', async t => {
  const { tasks, conversations } = await fixture(t);
  const registrations = new Map();
  await module.registerTasks({ register: async (descriptor, handler) => registrations.set(descriptor.id, { descriptor, handler }) }, tasks);
  const prompt = '需求设计'.repeat(37500);
  const input = { taskKey: '4'.repeat(64), prompt };
  const entry = registrations.get('agent.task.start.v1');
  assert.equal(matchesSchema(input, entry.descriptor.inputSchema), true);
  await entry.handler(input);
  const active = await wait(() => [...conversations.engines.values()].find(item =>
    item.engine.calls.some(call => call.method === 'turn/start')));
  assert.equal(active.engine.calls.find(call => call.method === 'turn/start').params.input[0].text, prompt);
  active.engine.onEvent({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'compact' } } });
  assert.equal((await tasks.read(input)).state, 'running');
  const record = [...conversations.records.values()][0];
  assert.ok(record.events.some(event => event.params?.item?.type === 'contextCompaction'));
  active.engine.onEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '审核完成' } } });
  active.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  const result = await wait(async () => { const task = await tasks.read(input); return task.state === 'succeeded' && task; });
  assert.equal(result.output, '审核完成');
  await assert.rejects(tasks.start('plan', { taskKey: '5'.repeat(64), prompt: '  ' }), /任务文本/);
});

test('MCP debug capability preserves read-only sandbox and carries only target service scope', async t => {
  const { tasks, conversations } = await fixture(t);
  const registrations = new Map();
  await module.registerTasks({ register: async (descriptor, handler) => registrations.set(descriptor.id, { descriptor, handler }) }, tasks);
  const entry = registrations.get('agent.mcp.debug.start.v1');
  assert.ok(entry);
  await entry.handler({ taskKey: '7'.repeat(64), serviceId: 'debug-target', providerId: 'mcp-services', prompt: 'verify MCP' });
  const active = await wait(() => [...conversations.engines.values()][0]?.engine.calls.length && [...conversations.engines.values()][0]);
  assert.equal(active.engine.calls[0].params.sandbox, 'read-only');
  const record = [...conversations.records.values()][0];
  assert.deepEqual(record.task.mcpDebug, { serviceId: 'debug-target', pluginId: 'mcp-services' });
  assert.equal(record.task.kind, 'plan');
});

test('MCP debug user answers use the existing conversation contract and cannot approve native writes', async t => {
  const { tasks, conversations } = await fixture(t);
  const input = { taskKey: '6'.repeat(64), serviceId: 'debug-target', providerId: 'mcp-services', prompt: 'verify MCP' };
  const { active } = await activeTask(tasks, conversations, input, 'mcp-debug');
  active.engine.onEvent({ id: 31, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'project', question: '项目名称？' }] } });
  await tasks.respond({ taskKey: input.taskKey, requestId: 31, answers: { project: 'test-project' } });
  assert.deepEqual(active.engine.response, { id: 31, result: { answers: { project: { answers: ['test-project'] } } } });
  active.engine.onEvent({ id: 32, method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: 'write' } } });
  await assert.rejects(tasks.respond({ taskKey: input.taskKey, requestId: 32, decision: 'accept' }), /只读/);
});
async function activeTask(tasks, conversations, input, kind = 'plan') {
  const task = await tasks.start(kind, input);
  const active = await wait(() => [...conversations.engines.values()][0]);
  return { task, active, record: [...conversations.records.values()][0] };
}

test('read-only tasks expose MCP input and URL requests without weakening native write approvals', async t => {
  const { tasks, conversations } = await fixture(t);
  const input = { taskKey: 'd'.repeat(64), prompt: 'native input' };
  const { active } = await activeTask(tasks, conversations, input);
  await wait(() => tasks.get(input.taskKey).state === 'running');
  active.engine.onEvent({ id: 0, method: 'mcpServer/elicitation/request', params: {
    mode: 'form', requestedSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }
  } });
  assert.equal((await tasks.read(input)).requests[0].id, 0);
  await tasks.respond({ ...input, requestId: 0, answers: { enabled: false } });
  assert.deepEqual(active.engine.response, { id: 0, result: { action: 'accept', content: { enabled: false } } });
  assert.equal((await tasks.read(input)).requests.length, 0);
  for (const [id, decision] of ['accept', 'decline', 'cancel'].entries()) {
    active.engine.onEvent({ id: id + 1, method: 'mcpServer/elicitation/request', params: { mode: 'url', url: 'https://example.com' } });
    await tasks.respond({ ...input, requestId: id + 1, decision });
    assert.deepEqual(active.engine.response, { id: id + 1, result: { action: decision } });
  }
  active.engine.onEvent({ id: 4, method: 'mcpServer/elicitation/request', params: { mode: 'url' } });
  active.engine.onEvent({ method: 'serverRequest/resolved', params: { requestId: 4 } });
  assert.equal((await tasks.read(input)).requests.length, 0);
  await assert.rejects(tasks.respond({ ...input, requestId: 4, decision: 'accept' }), /失效/);
  active.engine.onEvent({ id: 5, method: 'mcpServer/elicitation/request', params: { _meta: { codex_approval_kind: 'mcp_tool_call' } } });
  await assert.rejects(tasks.respond({ ...input, requestId: 5, decision: 'accept' }), /只读/);
});

test('native MCP tool elicitation is exposed for explicit authorization and maps accept, decline and cancel', async t => {
  const { tasks, conversations } = await fixture(t);
  const input = { taskKey: '3'.repeat(64), prompt: 'inspect desktop' };
  const { active, record } = await activeTask(tasks, conversations, input);
  await wait(() => tasks.get(input.taskKey).state === 'running');
  record.task.background = { authorizationId: 'test-authorization' };
  tasks.get(input.taskKey).execution = { background: record.task.background };
  for (const [index, decision] of ['accept', 'decline', 'cancel'].entries()) {
    active.engine.onEvent({ id: index, method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread', turnId: 'turn', mode: 'form', message: 'Allow computer tool?',
      requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' }
    } });
    assert.equal((await tasks.read(input)).requests.length, 1);
    await tasks.respond({ ...input, requestId: index, decision });
    assert.deepEqual(active.engine.response, { id: index, result: { action: decision,
      ...(decision === 'accept' ? { content: {} } : {}) } });
    assert.equal((await tasks.read(input)).requests.length, 0);
  }
});

test('child final answers do not finish a workflow task or contaminate its parent JSON result', async t => {
  const { tasks, conversations } = await fixture(t);
  const input = { taskKey: '8'.repeat(64), prompt: 'delegate, then return JSON' };
  const { active } = await activeTask(tasks, conversations, input);
  await wait(() => tasks.get(input.taskKey).state === 'running');
  const emit = (threadId, turnId, phase, text) => active.engine.onEvent({ method: 'item/completed', params: {
    threadId, turnId, item: { type: 'agentMessage', phase, text }
  } });
  emit('thread', 'turn', 'commentary', '正在检查');
  emit('child', 'child-turn', 'final_answer', '子任务完成，尚未整体完成');
  active.engine.onEvent({ method: 'turn/completed', params: {
    threadId: 'child', turn: { id: 'child-turn', rootTurnId: 'turn', status: 'completed' }
  } });
  assert.equal((await tasks.read(input)).state, 'running');
  emit('thread', 'old-turn', 'final_answer', '{"stale":true}');
  emit('thread', 'turn', 'final_answer', '{"passed":true}');
  active.engine.onEvent({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
  const result = await tasks.read(input);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.output, '{"passed":true}');
});

test('delta-only results exclude child and commentary text, and completion items recover a missing final event', async t => {
  for (const fromCompletion of [false, true]) {
    const { tasks, conversations } = await fixture(t);
    const input = { taskKey: (fromCompletion ? '9' : '0').repeat(64), prompt: 'return JSON' };
    const { active } = await activeTask(tasks, conversations, input);
    await wait(() => active.engine.calls.some(call => call.method === 'turn/start'));
    active.engine.onEvent({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
      item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '处理中' } } });
    for (const [threadId, itemId, delta] of [['child', 'child-answer', '子任务'], ['thread', 'progress', '处理中'],
      ['thread', 'answer', '{"passed":'], ['thread', 'answer', 'true}']]) {
      active.engine.onEvent({ method: 'item/agentMessage/delta', params: { threadId, turnId: threadId === 'child' ? 'child-turn' : 'turn', itemId, delta } });
    }
    active.engine.onEvent({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed',
      items: fromCompletion ? [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '{"recovered":true}' }] : [] } } });
    assert.equal((await tasks.read(input)).output, fromCompletion ? '{"recovered":true}' : '{"passed":true}');
  }
});
test('短启动、只读计划、原生回复输出和不可猜测任务句柄', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  const { active, record } = await activeTask(tasks, conversations, { taskKey: 'a'.repeat(64), cwd: storage.root, prompt: 'draft' });
  assert.equal(active.engine.calls[0].params.sandbox, 'read-only');
  await assert.rejects(tasks.read({ taskKey: 'b'.repeat(64) }), /任务/);
  active.engine.onEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '{"additions":[]}' } } });
  active.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  const result = await wait(async () => { const r = await tasks.read({ taskKey: 'a'.repeat(64) }); return r.state === 'succeeded' && r; });
  assert.equal(result.output, '{"additions":[]}');
  assert.equal(record.task.kind, 'plan');
});
test('代码任务只允许确认文件，检测越界写入并阻止同目录并发', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  await writeFile(join(storage.root, 'Registry.java'), 'before');
  // Use a separate workspace: plugin history must not count as Agent edits.
  const { mkdir } = await import('node:fs/promises');
  const cwd = join(storage.root, 'repo');
  await mkdir(cwd);
  await writeFile(join(cwd, 'Registry.java'), 'before');
  const input = { taskKey: 'c'.repeat(64), cwd, prompt: 'code', files: ['Registry.java'] };
  const { active } = await activeTask(tasks, conversations, input, 'code');
  await assert.rejects(tasks.start('code', { ...input, taskKey: 'd'.repeat(64) }), /正在/);
  await writeFile(join(cwd, 'Registry.java'), 'after');
  await writeFile(join(cwd, 'Other.java'), 'unexpected');
  active.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  const result = await wait(async () => { const r = await tasks.read({ taskKey: input.taskKey }); return r.state === 'failed' && r; });
  assert.match(result.error, /范围/);
  assert.equal(await readFile(join(cwd, 'Other.java'), 'utf8'), 'unexpected');
});
test('取消会中断实际原生任务，重启不重放', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  const input = { taskKey: 'e'.repeat(64), cwd: storage.root, prompt: 'draft' };
  const { active } = await activeTask(tasks, conversations, input);
  await wait(() => active.engine.calls.some(call => call.method === 'turn/start'));
  await tasks.cancel(input);
  assert.equal(active.engine.calls.at(-1).method, 'turn/interrupt');
  assert.equal(active.engine.closed, true);
  assert.equal((await tasks.read(input)).state, 'cancelled');
  const reopened = new module.AgentTasks({ conversations, storage, pluginId: 'ai-test' });
  await reopened.load();
  assert.equal((await reopened.read(input)).state, 'cancelled');
});
test('代码路径规范化、嵌套目录互斥、审查后文件变化使摘要失效', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  const cwd = join(storage.root, 'repo');
  await mkdir(join(cwd, 'nested'), { recursive: true });
  await writeFile(join(cwd, 'Registry.java'), 'before');
  const input = { taskKey: 'f'.repeat(64), cwd, prompt: 'code', files: ['./Registry.java'] };
  const { active } = await activeTask(tasks, conversations, input, 'code');
  await assert.rejects(tasks.start('code', { ...input, cwd: join(cwd, 'nested'), files: ['New.java'], taskKey: '9'.repeat(64) }), /正在/);
  await wait(() => active.engine.calls.some(call => call.method === 'turn/start'));
  await writeFile(join(cwd, 'Registry.java'), 'after');
  active.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  const result = await wait(async () => { const r = await tasks.read(input); return r.state === 'succeeded' && r; });
  assert.deepEqual(result.diff, [{ file: 'Registry.java', before: 'before', after: 'after' }]);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  await writeFile(join(cwd, 'Registry.java'), 'later');
  assert.equal((await tasks.read(input)).state, 'failed');
});
test('同一任务句柄并发启动只创建一个原生会话；启动前取消不会重放', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  const input = { taskKey: '1'.repeat(64), cwd: storage.root, prompt: 'draft' };
  await Promise.all([tasks.start('plan', input), tasks.start('plan', input)]);
  await wait(() => [...conversations.engines.values()][0]?.engine.calls.some(call => call.method === 'turn/start'));
  assert.equal(conversations.records.size, 1);
  const cancelled = { ...input, taskKey: '2'.repeat(64) };
  await tasks.cancel(cancelled);
  assert.equal((await tasks.start('plan', cancelled)).state, 'cancelled');
  assert.equal(conversations.records.size, 1);
});

test('通用 Agent 启动能力由 AI 插件发布，复用只读任务及插件默认工作目录', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  const registrations = new Map();
  await module.registerTasks({ register: async (descriptor, handler) => registrations.set(descriptor.id, { descriptor, handler }) }, tasks);
  const entry = registrations.get('agent.task.start.v1');
  assert.ok(entry, 'AI 插件应发布通用任务启动能力');
  assert.deepEqual(entry.descriptor.effects, ['workspace.read']);
  assert.equal(entry.descriptor.inputSchema.required.includes('cwd'), false);
  await entry.handler({ taskKey: '8'.repeat(64), prompt: '归纳输入' });
  const active = await wait(() => [...conversations.engines.values()][0]);
  const record = [...conversations.records.values()][0];
  assert.equal(record.cwd, await realpath(storage.root));
  assert.equal(active.engine.calls[0].params.sandbox, 'read-only');
  assert.ok(registrations.has('agent.menu.code.start.v1'));
  await tasks.cancel({ taskKey: '8'.repeat(64) });
});


test('background reuse keeps native user questions and reads only the new turn', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  const first = { taskKey: '1'.repeat(64), cwd: storage.root, prompt: 'first' };
  await tasks.start('plan', first, { background: { authorizationId: 'lease' } });
  const active = await wait(() => [...conversations.engines.values()][0]?.engine.calls.length && [...conversations.engines.values()][0]);
  assert.deepEqual(active.engine.calls[0].params.approvalPolicy, { granular: { sandbox_approval: false, rules: false,
    skill_approval: false, request_permissions: false, mcp_elicitations: true } });
  assert.equal(active.engine.calls[0].params.sandbox, 'danger-full-access');
  active.engine.onEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'old output' } } });
  active.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  const completed = await wait(async () => { const value = await tasks.read(first); return value.state === 'succeeded' && value; });
  await tasks.start('plan', { ...first, taskKey: '2'.repeat(64), prompt: 'second' }, {
    conversationId: tasks.get(first.taskKey).conversationId, background: { authorizationId: 'lease' }
  });
  await wait(() => active.engine.calls.filter(call => call.method === 'turn/start').length === 2);
  const second = await tasks.read({ taskKey: '2'.repeat(64) });
  assert.notEqual(second.state, 'succeeded');
  assert.notEqual(second.output, 'old output');
  active.engine.onEvent({ id: 88, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', question: 'Choose?' }] } });
  const waiting = await tasks.read({ taskKey: '2'.repeat(64) });
  assert.equal(waiting.requests[0].id, 88);
  await tasks.respond({ taskKey: '2'.repeat(64), requestId: 88, answers: { q: 'yes' } });
  active.engine.onEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'new output' } } });
  active.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  const result = await wait(async () => { const value = await tasks.read({ taskKey: '2'.repeat(64) }); return value.state === 'succeeded' && value; });
  assert.equal(result.output, 'new output');
  assert.equal(conversations.records.size, 1);
});


test('background plans wait for explicit approval instead of silently answering', async t => {
  const { tasks, conversations, storage } = await fixture(t);
  const input = { taskKey: '9'.repeat(64), cwd: storage.root, prompt: 'plan' };
  await tasks.start('plan', input, { background: { authorizationId: 'lease' } });
  const active = await wait(() => [...conversations.engines.values()][0]?.engine.calls.length && [...conversations.engines.values()][0]);
  active.engine.onEvent({ id: 19, method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: 'write' } } });
  assert.equal(active.engine.response, undefined);
  assert.equal((await tasks.read({ taskKey: input.taskKey })).requests[0].id, 19);
  await tasks.respond({ taskKey: input.taskKey, requestId: 19, decision: 'accept' });
  assert.deepEqual(active.engine.response.result.permissions, { fileSystem: 'write' });
});
