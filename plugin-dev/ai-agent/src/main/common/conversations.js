import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ClaudeEngine } from './claude-engine.js';
import { AppServer } from './app-server.js';
import { CapabilityGateway } from './capability-gateway.js';

const transcriptEvent = method => /^(thread\/started|turn\/(started|completed)|item\/|error$)/.test(method);

export class Conversations {
  constructor(options) {
    Object.assign(this, options);
    this.Engine ||= AppServer;
    this.createGateway ||= options => new CapabilityGateway(options);
    this.engines = new Map();
    this.records = new Map();
    this.windows = new Map();
    this.writes = Promise.resolve();
    this.locks = new Set();
    this.stopped = false;
  }

  key(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) {
      throw Error('无效对话 ID');
    }
    return `plugin-data/${this.pluginId}/conversations/${id}.json`;
  }

  async load() {
    const windows = await this.storage.readJson(`plugin-data/${this.pluginId}/conversation-windows.json`, []);
    this.windows = new Map(windows.map(value => [value.id, value]));
    const directory = await this.storage.path(`plugin-data/${this.pluginId}/conversations`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(directory)) {
      if (/^[a-f0-9-]{36}\.json$/.test(file)) {
        const record = await this.storage.readJson(this.key(file.slice(0, -5)));
        if (record.state === 'running') {
          record.state = 'interrupted';
          await this.storage.writeJson(this.key(record.id), record);
        }
        this.records.set(record.id, record);
      }
    }
  }

  list() {
    return [...this.records.values()].map(({ events, ...record }) => record).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async registerWindow(input) {
    if (!/^[a-f0-9-]{36}$/.test(input?.id)) { throw Error('无效窗口 ID'); }
    if (!this.windows.has(input.id)) {
      const record = { id: input.id, name: `窗口 ${this.windows.size + 1}`, createdAt: new Date().toISOString() };
      this.windows.set(input.id, record);
      const snapshot = [...this.windows.values()];
      const write = this.writes.then(() => this.storage.writeJson(`plugin-data/${this.pluginId}/conversation-windows.json`, snapshot));
      this.writes = write.catch(() => {});
      await write;
    }
    return { ...this.windows.get(input.id) };
  }

  listWindows() { return [...this.windows.values()].map(value => ({ ...value })); }

  async attachWindow(id, windowId) {
    const record = this.records.get(id);
    if (!record || !this.windows.has(windowId)) { throw Error('对话或窗口不存在'); }
    if (record.windowId && record.windowId !== windowId) { throw Error('该对话属于其他窗口'); }
    record.windowId = windowId;
    await this.persist(record);
    return this.read(id);
  }

  read(id) {
    const record = this.records.get(id);
    if (!record) {
      throw Error('对话不存在');
    }
    return structuredClone(record);
  }

  async create(input = {}) {
    if (input.windowId && !this.windows.has(input.windowId)) { throw Error('窗口尚未登记'); }
    if (this.stopped) {
      throw Error('AI 插件正在关闭');
    }
    const launch = await this.runtime.launch(undefined, input.engineId);
    const cwd = input.cwd || launch.env.HOME;
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
      throw Error('请选择有效工作目录');
    }
    const record = { id: randomUUID(), name: '新对话', cwd, engineId: launch.engineId || 'codex', protocol: launch.engineId === 'claude' ? 'claude-stream' : 'app-server', profileId: launch.profileId,
      runtimeId: launch.runtimeId, runtimeVersion: launch.runtimeVersion, state: 'idle',
      ...(input.windowId ? { windowId: input.windowId } : {}),
      ...(input.task ? { task: input.task } : {}),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
    this.records.set(record.id, record);
    await this.persist(record);
    return this.read(record.id);
  }

  async connect(record) {
    const previous = this.engines.get(record.id);
    if (previous) {
      if (previous.captureKey === (this.capture?.key(record) || null) && !await previous.gateway.refreshCatalog()) {
        this.assertOpen();
        return previous;
      }
      // Reconnect only between turns so native tool discovery sees the new catalog without losing the thread.
      this.engines.delete(record.id);
      await previous.gateway.close();
      if (previous.engine.closeTask) { await previous.engine.closeTask(); } else { previous.engine.close(); }
      this.reportProcesses();
      console.info('[ai:catalog-refresh]', { pluginId: this.pluginId, conversationId: record.id });
    }
    const launch = await this.runtime.launch(record.profileId, record.engineId || 'codex');
    const capture = this.capture ? await this.capture.prepare(record, launch) : { key: null, args: launch.args, env: launch.env };
    this.assertOpen();
    if (launch.runtimeId !== record.runtimeId) {
      throw Error('会话固定的引擎版本尚未安装，不能自动切换版本');
    }
    const gateway = this.createGateway({ capabilities: this.capabilities, conversationId: record.id, task: record.task,
      onInvocation: task => this.event(record, { method: 'capability/invocation', params: task }) });
    await gateway.start();
    if (this.stopped) {
      await gateway.close();
      this.assertOpen();
    }
    const Engine = record.engineId === 'claude' ? ClaudeEngine : this.Engine;
    const engine = new Engine({ onSpawn: () => this.reportProcesses(),
      onEvent: message => this.onNativeEvent(record, message), onExit: () => {
        if (this.engines.get(record.id)?.engine !== engine) {
          return;
        }
        if (record.state === 'running') {
          record.state = 'interrupted';
        }
        this.engines.delete(record.id);
        gateway.close().catch(error => this.report(record.id, error));
        this.persist(record).catch(error => this.report(record.id, error));
        this.reportProcesses();
      } });
    const active = { engine, gateway, captureKey: capture.key };
    // Ownership begins before initialization, which can still be pending when the plugin is stopped.
    this.engines.set(record.id, active);
    try {
      await engine.start({ ...launch, cwd: record.cwd, threadId: record.threadId, resume: Boolean(record.threadId),
        plan: record.task?.kind === 'plan', gateway: { url: gateway.url, token: gateway.token }, env: { ...capture.env, WORK_DESK_MCP_TOKEN: gateway.token },
        args: [...capture.args, '-c', `mcp_servers.work_desk.url=${JSON.stringify(gateway.url)}`,
          '-c', 'mcp_servers.work_desk.bearer_token_env_var="WORK_DESK_MCP_TOKEN"', '-c', 'mcp_servers.work_desk.required=true'] });
      this.assertOpen();
      if (record.threadId) {
        await engine.request('thread/resume', { threadId: record.threadId, cwd: record.cwd });
      } else {
        const { thread } = await engine.request('thread/start', { cwd: record.cwd, approvalPolicy: 'on-request', sandbox: record.task?.kind === 'plan' ? 'read-only' : 'workspace-write' });
        record.threadId = thread.id;
      }
      this.assertOpen();
      this.reportProcesses();
      await this.persist(record);
      return active;
    } catch (error) {
      if (this.engines.get(record.id) === active) {
        this.engines.delete(record.id);
      }
      engine.close();
      await gateway.close();
      this.reportProcesses();
      throw error;
    }
  }

  assertOpen() {
    if (this.stopped) {
      throw Error('AI 插件正在关闭');
    }
  }

  async send(id, text) {
    const record = this.records.get(id);
    if (!record || typeof text !== 'string' || !text.trim() || text.length > 100000) {
      throw Error('请输入有效对话内容');
    }
    if (this.stopped || this.locks.has(id) || record.state === 'running') {
      throw Error('对话正在执行，请先停止');
    }
    this.locks.add(id);
    try {
      const { engine } = await this.connect(record);
      this.assertOpen();
      record.state = 'running';
      record.name = record.name === '新对话' ? text.slice(0, 40) : record.name;
      this.event(record, { method: 'user/message', params: { text } });
      const { turn } = await engine.request('turn/start', { threadId: record.threadId, input: [{ type: 'text', text }] });
      if (record.state === 'running') {
        record.turnId = turn.id;
      }
      await this.persist(record);
      console.info('[ai:turn-start]', { pluginId: this.pluginId, conversationId: id, threadId: record.threadId, turnId: turn.id });
      return this.read(id);
    } catch (error) {
      record.state = 'failed';
      this.event(record, { method: 'error', params: { message: error.message } });
      throw error;
    } finally {
      this.locks.delete(id);
    }
  }

  onNativeEvent(record, message) {
    if (message.method === 'turn/completed') {
      record.state = message.params.turn.status === 'completed' ? 'idle' : message.params.turn.status;
      record.turnId = null;
    }
    if (message.id !== undefined || transcriptEvent(message.method)) {
      this.event(record, message);
    } else if (message.method.startsWith('account/')) {
      this.emit('conversation.account', { method: message.method, params: message.params });
    }
  }

  event(record, message) {
    const event = { ...message, sequence: record.events.length + 1, at: new Date().toISOString() };
    record.events.push(event);
    this.emit('conversation.event', { conversationId: record.id, event, state: record.state });
    this.persist(record).catch(error => this.report(record.id, error));
  }

  persist(record) {
    record.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(record);
    const write = this.writes.then(() => this.storage.writeJson(this.key(record.id), snapshot));
    this.writes = write.catch(() => {});
    return write;
  }

  async cancel(id) {
    const record = this.records.get(id);
    const active = this.engines.get(id);
    if (active && record.turnId) {
      await active.engine.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId });
      await active.gateway.cancel();
    }
  }

  // Workflow tasks own an engine: close it before a cancelled code task releases its workspace lock.
  async cancelTask(id) {
    const record = this.records.get(id);
    const active = this.engines.get(id);
    if (active) {
      try {
        if (record.turnId) {
          await active.engine.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId }, 3000);
        }
      } catch (error) {
        this.report(id, error);
      }
      await active.gateway.close();
      if (active.engine.closeTask) { await active.engine.closeTask(); }
      else { active.engine.close(); }
      this.engines.delete(id);
      this.reportProcesses();
    }
    record.state = 'cancelled';
    await this.persist(record);
  }

  approve(id, requestId, decision) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) {
      throw Error('无效审批结果');
    }
    const record = this.records.get(id);
    const request = record?.events.find(event => event.id === requestId && event.method.endsWith('/requestApproval'));
    if (!request || !this.engines.has(id)) {
      throw Error('审批已失效');
    }
    const result = request.method === 'item/permissions/requestApproval'
      ? { permissions: decision === 'accept' ? request.params.permissions : {}, scope: 'turn' } : { decision };
    this.engines.get(id).engine.respond(requestId, result);
    this.event(record, { method: 'approval/answered', params: { requestId, decision } });
  }

  answer(id, requestId, answers) {
    const record = this.records.get(id);
    const request = record?.events.find(event => event.id === requestId && event.method === 'item/tool/requestUserInput');
    if (!request || !this.engines.has(id)) {
      throw Error('问题已失效');
    }
    const result = Object.fromEntries(request.params.questions.map(question => {
      const answer = answers[question.id];
      if (typeof answer !== 'string' || !answer.trim()) {
        throw Error('请回答所有问题');
      }
      return [question.id, { answers: [answer] }];
    }));
    this.engines.get(id).engine.respond(requestId, { answers: result });
    this.event(record, { method: 'approval/answered', params: { requestId, answers } });
  }

  async account(method, params = {}, engineId = 'codex') {
    this.assertOpen();
    if (engineId === 'claude') {
      if (method === 'account/logout') { await this.prepareEngineChange(engineId); }
      return this.runtime.account(method, params);
    }
    const allowed = ['account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'model/list'];
    if (!allowed.includes(method)) {
      throw Error('不支持的账户操作');
    }
    this.assertOpen();
    // All windows share one initialization, including the time spent preparing the isolated profile.
    if (!this.accountEngine && !this.accountStarting) {
      this.accountStarting = this.startAccount().finally(() => { this.accountStarting = null; });
    }
    const engine = await (this.accountStarting || this.accountEngine);
    this.assertOpen();
    if (method === 'account/logout') { await this.prepareEngineChange(engineId, false); }
    const result = await engine.request(method, params);
    return result;
  }

  // Authorization replacement cannot race an active turn or leave cached credentials in an idle process.
  async prepareEngineChange(engineId, closeAccount = true) {
    this.runtime.runtime(engineId);
    const records = [...this.records.values()].filter(record => (record.engineId || 'codex') === engineId);
    if (records.some(record => record.state === 'running' || this.locks.has(record.id))) { throw Error('请先停止该引擎正在执行的对话'); }
    for (const record of records) {
      const active = this.engines.get(record.id);
      if (active) {
        await active.gateway.close();
        await active.engine.closeTask();
        this.engines.delete(record.id);
      }
    }
    if (engineId === 'codex' && closeAccount) {
      await this.accountStarting;
      await this.accountEngine?.closeTask();
      this.accountEngine = null;
    }
    this.reportProcesses();
  }

  async startAccount() {
    const launch = await this.runtime.launch(undefined, 'codex');
    this.assertOpen();
    const engine = new this.Engine({ onSpawn: () => this.reportProcesses(), onEvent: message => {
      if (message.method.startsWith('account/')) {
        this.emit('conversation.account', message);
      }
    }, onExit: () => {
      if (this.accountEngine === engine) {
        this.accountEngine = null;
        this.reportProcesses();
      }
    } });
    this.accountEngine = engine;
    try {
      await engine.start({ ...launch, cwd: launch.env.HOME });
      this.assertOpen();
      this.reportProcesses();
      return engine;
    } catch (error) {
      engine.close();
      if (this.accountEngine === engine) {
        this.accountEngine = null;
      }
      this.reportProcesses();
      throw error;
    }
  }

  reportProcesses() {
    this.ownProcesses([...this.engines.values()].map(({ engine }) => engine.child?.pid)
      .concat(this.accountEngine?.child?.pid).filter(Boolean));
  }

  report(id, error) {
    console.error('[ai:conversation-error]', { pluginId: this.pluginId, conversationId: id, message: error.message });
  }

  async stop() {
    this.stopped = true;
    for (const [id, active] of this.engines) {
      await active.gateway.close();
      active.engine.close();
      const record = this.records.get(id);
      record.state = record.state === 'running' ? 'interrupted' : record.state;
      await this.persist(record);
    }
    this.engines.clear();
    this.accountEngine?.close();
    this.accountEngine = null;
    await this.writes;
    this.reportProcesses();
  }
}
