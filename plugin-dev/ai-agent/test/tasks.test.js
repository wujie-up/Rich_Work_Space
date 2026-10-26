import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Conversations } from '../src/main/common/conversations.js';
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
