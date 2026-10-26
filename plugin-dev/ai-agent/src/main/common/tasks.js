import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const terminal = state => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
const assertTask = (condition, message) => {
  if (!condition) {
    throw Error(message);
  }
};
async function fileHash(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    return `link:${await readlink(path)}`;
  }
  const hash = createHash('sha256');
  assertTask(info.isFile(), '代码目录包含非普通文件，请选择更小的目录');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return `${info.mode}:${hash.digest('hex')}`;
}
// Hash actual files, including untracked/ignored files; git status alone misses edits to an existing untracked file.
async function snapshot(cwd) {
  const files = {};
  let count = 0;
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') {
        continue;
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        assertTask(++count <= 100000, '目录超过 100000 个文件，请选择更小的代码工作目录');
        files[relative(cwd, path)] = await fileHash(path);
      }
    }
  }
  await visit(cwd);
  return files;
}
async function contents(cwd, files) {
  return Object.fromEntries(await Promise.all(files.map(async file => {
    try {
      const path = resolve(cwd, file);
      const info = await lstat(path);
      assertTask(info.isFile() && info.size < 200000, `代码文件过大或不是普通文件：${file}`);
      return [file, await readFile(path, 'utf8')];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [file, null];
      }
      throw error;
    }
  })));
}
export class AgentTasks {
  constructor(options) {
    Object.assign(this, options);
    this.records = new Map();
    this.active = new Map();
    this.starts = new Map();
    this.writes = Promise.resolve();
  }
  key() { return `plugin-data/${this.pluginId}/agent-tasks.json`; }
  async load() {
    for (const task of await this.storage.readJson(this.key(), [])) {
      if (!terminal(task.state)) {
        task.state = 'interrupted';
        task.error = '插件已重启，请重新发起任务';
      }
      delete task.stopping;
      this.records.set(task.taskKey, task);
    }
    await this.persist();
  }
  persist() {
    const records = structuredClone([...this.records.values()]);
    const write = this.writes.then(() => this.storage.writeJson(this.key(), records));
    this.writes = write.catch(() => {});
    return write;
  }
  get(taskKey) {
    const task = this.records.get(taskKey);
    assertTask(task, '任务不存在或句柄已失效');
    return task;
  }
  start(kind, input) {
    // Coalesce retries before asynchronous path validation can yield to another start.
    if (this.starts.has(input.taskKey)) { return this.starts.get(input.taskKey); }
    const work = this.startOnce(kind, input).finally(() => this.starts.delete(input.taskKey));
    this.starts.set(input.taskKey, work);
    return work;
  }
  async startOnce(kind, input) {
    assertTask(/^[a-f0-9]{64}$/.test(input.taskKey), '无效任务句柄');
    assertTask(typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= 90000, '任务文本必须为 1–90000 字符');
    if (kind === 'mcp-debug') {
      assertTask(/^[a-zA-Z0-9_-]{1,64}$/.test(input.serviceId) && typeof input.providerId === 'string' && input.providerId,
        'MCP 调试需要目标服务及提供方');
    }
    const previous = this.records.get(input.taskKey);
    if (previous) {
      return { state: previous.state };
    }
    // Omitted directories use this plugin's isolated runtime, never the system Agent environment.
    const requestedCwd = input.cwd ?? (await this.conversations.runtime.launch()).env.HOME;
    assertTask(isAbsolute(requestedCwd), '请选择绝对路径工作目录');
    const cwd = await realpath(requestedCwd);
    let files = kind === 'code' ? [...new Set(input.files || [])] : [];
    if (kind === 'code') {
      assertTask(files.length > 0 && files.length <= 30, '代码范围必须为 1–30 个文件');
      for (const file of files) {
        const path = resolve(cwd, file);
        assertTask(typeof file === 'string' && !isAbsolute(file) && relative(cwd, path) !== ''
          && !relative(cwd, path).startsWith('..') && !file.split(/[\\/]/).includes('.git'), '代码文件必须在工作目录内');
        // Resolve existing ancestors to reject symlink escapes, including new files beneath a symlink directory.
        let ancestor = path;
        while (true) {
          try {
            const actual = await realpath(ancestor);
            assertTask(actual === cwd || !relative(cwd, actual).startsWith('..') && !isAbsolute(relative(cwd, actual)), '代码路径包含越界符号链接');
            break;
          } catch (error) {
            if (error.code !== 'ENOENT') { throw error; }
            ancestor = resolve(ancestor, '..');
          }
        }
      }
      files = [...new Set(files.map(file => relative(cwd, resolve(cwd, file))))];
      const contains = (parent, child) => child === parent || !relative(parent, child).startsWith('..') && !isAbsolute(relative(parent, child));
      assertTask(![...this.records.values()].some(task => task.kind === 'code' && (contains(task.cwd, cwd) || contains(cwd, task.cwd))
        && (!terminal(task.state) || task.stopping)),
        '该工作目录正在执行代码任务');
    }
    // A cancel may arrive while paths are being resolved or before host approval finishes.
    if (this.records.has(input.taskKey)) { return { state: this.get(input.taskKey).state }; }
    const task = { taskKey: input.taskKey, kind, cwd, files, state: 'starting', createdAt: Date.now() };
    if (kind === 'mcp-debug') { task.mcpDebug = { serviceId: input.serviceId, pluginId: input.providerId }; }
    this.records.set(input.taskKey, task);
    await this.persist();
    const work = this.run(task, input.prompt).catch(async error => {
      if (task.state !== 'cancelled') {
        task.state = 'failed';
        task.error = error.message;
        await this.persist();
        console.error('[ai:task-failed]', { pluginId: this.pluginId, conversationId: task.conversationId, kind });
      }
    }).finally(() => this.active.delete(input.taskKey));
    this.active.set(input.taskKey, work);
    return { state: task.state };
  }
  async run(task, prompt) {
    if (task.kind === 'code') {
      task.before = await snapshot(task.cwd);
      task.original = await contents(task.cwd, task.files);
    }
    if (task.state === 'cancelled') { return; }
    // Debug may use its target MCP but must retain the existing read-only native sandbox.
    const scope = task.mcpDebug ? { kind: 'plan', mcpDebug: task.mcpDebug } : { kind: task.kind, files: task.files };
    const record = await this.conversations.create({ cwd: task.cwd, task: scope });
    task.conversationId = record.id;
    await this.persist();
    if (task.state === 'cancelled') { return; }
    await this.conversations.send(record.id, prompt);
    if (task.state === 'cancelled') {
      await this.conversations.cancel(record.id);
      return;
    }
    if (terminal(task.state)) { return; }
    task.state = 'running';
    await this.persist();
  }
  async read({ taskKey }) {
    const task = this.get(taskKey);
    if (task.conversationId && !terminal(task.state)) {
      const record = this.conversations.read(task.conversationId);
      const answered = new Set(record.events.filter(event => event.method === 'approval/answered').map(event => event.params.requestId));
      task.requests = record.events.filter(event => event.id !== undefined && !answered.has(event.id)
        && (event.method.endsWith('/requestApproval') || event.method === 'item/tool/requestUserInput'));
      if (record.state === 'idle' && record.events.some(event => event.method === 'turn/completed')) {
        try {
          await this.finish(task, record);
        } catch (error) {
          task.state = 'failed';
          task.error = error.message;
          await this.persist();
        }
      } else if (['failed', 'interrupted', 'cancelled'].includes(record.state)) {
        task.state = record.state;
        task.error = '原生 Agent 任务未完成，请检查对话记录';
        await this.persist();
      }
    }
    if (task.state === 'succeeded' && task.kind === 'code') {
      const current = await snapshot(task.cwd);
      if (JSON.stringify(current) !== JSON.stringify(task.after)) {
        task.state = 'failed';
        task.error = '代码文件已发生变化，请重新执行并确认';
        await this.persist();
      }
    }
    const { before, after, original, cwd, files, taskKey: secret, conversationId, ...publicTask } = task;
    return structuredClone(publicTask);
  }
  async finish(task, record) {
    task.output = record.events.filter(event => event.method === 'item/completed' && event.params.item?.type === 'agentMessage')
      .map(event => event.params.item.text).join('\n');
    if (!task.output) {
      task.output = record.events.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params.delta).join('');
    }
    if (task.kind === 'code') {
      task.after = await snapshot(task.cwd);
      const changed = [...new Set([...Object.keys(task.before), ...Object.keys(task.after)])]
        .filter(file => task.before[file] !== task.after[file]);
      task.changed = changed;
      if (changed.some(file => !task.files.includes(file))) {
        task.state = 'failed';
        task.error = `Agent 修改超出已确认范围：${changed.filter(file => !task.files.includes(file)).join('、')}。请手动审查后重新开始；未自动回滚。`;
        await this.persist();
        return;
      }
      const current = await contents(task.cwd, task.files);
      task.diff = changed.map(file => ({ file, before: task.original[file], after: current[file] }));
      task.digest = createHash('sha256').update(JSON.stringify(task.diff)).digest('hex');
    }
    assertTask(JSON.stringify({ output: task.output, diff: task.diff }).length < 600000, '任务产物过大，请缩小范围后重试');
    task.state = 'succeeded';
    await this.persist();
  }
  async respond(input) {
    const task = this.get(input.taskKey);
    assertTask(!terminal(task.state) && task.conversationId, '任务已结束');
    const request = (await this.read(input)).requests.find(event => event.id === input.requestId);
    assertTask(request, '审批或问题已失效');
    if (request.method === 'item/tool/requestUserInput') {
      this.conversations.answer(task.conversationId, input.requestId, input.answers);
    } else {
      // Planning may never promote a read-only thread into write access through an approval.
      assertTask(!['plan', 'mcp-debug'].includes(task.kind) || input.decision !== 'accept', '计划任务只读，不能批准写入或提权');
      this.conversations.approve(task.conversationId, input.requestId, input.decision);
    }
    return { accepted: true };
  }
  async cancel({ taskKey }) {
    assertTask(/^[a-f0-9]{64}$/.test(taskKey), '无效任务句柄');
    if (!this.records.has(taskKey)) {
      this.records.set(taskKey, { taskKey, state: 'cancelled', createdAt: Date.now() });
      await this.persist();
    }
    const task = this.get(taskKey);
    if (terminal(task.state) && task.mcpDebug && task.conversationId) {
      await this.conversations.cancelTask(task.conversationId);
    }
    if (!terminal(task.state)) {
      task.state = 'cancelled';
      task.stopping = true;
      try {
        if (task.conversationId) { await this.conversations.cancelTask(task.conversationId); }
        await this.active.get(taskKey);
        if (task.conversationId) { await this.conversations.cancelTask(task.conversationId); }
      } finally {
        delete task.stopping;
        await this.persist();
      }
    }
    return { state: task.state };
  }
  async stop() {
    await Promise.allSettled(this.starts.values());
    for (const task of this.records.values()) {
      await this.cancel(task);
    }
    await Promise.allSettled(this.active.values());
  }
}
export async function registerTasks(capabilities, tasks) {
  const common = { taskKey: { type: 'string', minLength: 64, maxLength: 64 } };
  const start = { ...common, cwd: { type: 'string' }, prompt: { type: 'string', maxLength: 90000 },
    files: { type: 'array', items: { type: 'string' }, maxItems: 30 } };
  for (const [id, title, properties, required, effects, handler] of [
    ['agent.mcp.debug.start.v1', 'MCP AI 调试', { ...common, prompt: start.prompt, serviceId: { type: 'string', maxLength: 64 },
      providerId: { type: 'string' } }, ['taskKey', 'prompt', 'serviceId', 'providerId'], ['workspace.read'],
      input => tasks.start('mcp-debug', input)],
    ['agent.task.start.v1', 'Agent 任务', start, ['taskKey', 'prompt'], ['workspace.read'], input => tasks.start('plan', input)],
    ['agent.menu.plan.start.v1', '菜单计划 Agent', start, ['taskKey', 'cwd', 'prompt'], ['workspace.read'], input => tasks.start('plan', input)],
    ['agent.menu.code.start.v1', '菜单代码 Agent', start, ['taskKey', 'cwd', 'prompt', 'files'], ['workspace.write'], input => tasks.start('code', input)],
    ['agent.task.read.v1', '读取 Agent 任务', common, ['taskKey'], ['workspace.read'], input => tasks.read(input)],
    ['agent.task.respond.v1', '响应 Agent 审批', { ...common, requestId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      decision: { type: 'string', enum: ['accept', 'decline', 'cancel'] }, answers: { type: 'object' } }, ['taskKey', 'requestId'],
      ['workspace.write'], input => tasks.respond(input)],
    ['agent.task.cancel.v1', '停止 Agent 任务', common, ['taskKey'], ['workspace.read'], input => tasks.cancel(input)]
  ]) {
    await capabilities.register({ id, version: 1, title, description: title, inputSchema: { type: 'object', properties,
      required, additionalProperties: false }, outputSchema: { type: 'object' }, effects, confirmation: 'policy',
      execution: { timeoutMs: 30000, cancellable: true, retry: 'never' }, state: 'ready' }, handler);
  }
}
