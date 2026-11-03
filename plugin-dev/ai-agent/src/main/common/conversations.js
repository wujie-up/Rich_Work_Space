import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ClaudeEngine } from './claude-engine.js';
import { AppServer } from './app-server.js';
import { ConversationHistory, summary } from './conversation-history.js';
import { CapabilityGateway } from './capability-gateway.js';
import { isApprovalRequest, isElicitationRequest, pendingRequests } from '../../shared/contracts.js';
import { elicitationResult } from '../../shared/mcp-elicitation.js';

const transcriptEvent = method => /^(thread\/started|turn\/(started|completed)|item\/|serverRequest\/resolved$|error$)/.test(method);
// Native "never" also declines user input; background execution still needs explicit MCP form/URL answers.
const backgroundApprovalPolicy = { granular: { sandbox_approval: false, rules: false, skill_approval: false,
  request_permissions: false, mcp_elicitations: true } };

// Child threads share the event stream, but cannot finish their parent's active turn.
export function isPrimaryTurnEvent(record, event, turnId = record.turnId) {
  const params = event.params || {};
  const eventTurnId = params.turnId || params.turn?.id;
  return (!params.threadId || params.threadId === record.threadId)
    && (!turnId || !eventTurnId || eventTurnId === turnId);
}

export class Conversations {
  constructor(options) {
    Object.assign(this, options);
    this.Engine ||= AppServer;
    this.createGateway ||= options => new CapabilityGateway(options);
    this.engines = new Map();
    this.records = new Map();
    this.loadedRecords = new Map();
    this.loadingRecords = new Map();
    this.history = new ConversationHistory(this.storage, this.pluginId, id => this.key(id));
    this.windows = new Map();
    this.windowViews = new Map();
    this.writes = Promise.resolve();
    this.pendingWrites = new Map();
    this.locks = new Set();
    this.toolRefresh = new Set();
    this.composers = new Map();
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
    const index = await this.history.index();
    for (const file of await readdir(directory)) {
      if (/^[a-f0-9-]{36}\.json$/.test(file)) {
        const id = file.slice(0, -5);
        const record = await this.history.load(id, index.get(id));
        this.records.set(record.id, record);
      }
    }
    await this.history.save(this.records);
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
    // A live desktop view may reopen an existing group; its binding must never persist as an open window.
    if (input.hostWindowId) {
      this.windowViews.set(input.hostWindowId, input.id);
      console.info('[agent:window-bound]', { pluginId: this.pluginId, windowId: input.id, hostWindowId: input.hostWindowId });
    }
    return { ...this.windows.get(input.id) };
  }

  listWindows() { return [...this.windows.values()].map(value => ({ ...value })); }

  async attachWindow(id, windowId) {
    const record = await this.loadRecord(id);
    if (!record || !this.windows.has(windowId)) { throw Error('对话或窗口不存在'); }
    if (record.windowId && record.windowId !== windowId) { throw Error('该对话属于其他窗口'); }
    record.windowId = windowId;
    await this.persist(record);
    return this.read(id);
  }

  async loadRecord(id) {
    let record = this.records.get(id);
    if (!record) {
      throw Error('对话不存在');
    }
    if (!record.events) {
      let loading = this.loadingRecords.get(id);
      if (!loading) {
        loading = this.storage.readJson(this.key(id)).then(value => {
          this.records.set(id, value);
          return value;
        }).finally(() => this.loadingRecords.delete(id));
        this.loadingRecords.set(id, loading);
      }
      record = await loading;
    }
    this.loadedRecords.delete(id);
    this.loadedRecords.set(id, record);
    return record;
  }

  // Live engines and pending mutations retain their record identity until they are drained.
  trimRecords() {
    for (const [id, record] of this.loadedRecords) {
      if (this.loadedRecords.size <= 8) {
        break;
      }
      if (!this.engines.has(id) && !this.locks.has(id) && !this.pendingWrites.has(id) && !this.loadingRecords.has(id)) {
        this.records.set(id, summary(record));
        this.loadedRecords.delete(id);
      }
    }
  }

  async read(id) {
    const record = await this.loadRecord(id);
    const value = structuredClone(record);
    this.trimRecords();
    return value;
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
      runtimeId: launch.runtimeId, runtimeVersion: launch.runtimeVersion, launchSettings: launch.launchSettings, state: 'idle',
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
      await previous.mcpConnection?.refresh();
      if (!this.toolRefresh.has(record.id) && previous.captureKey === (this.capture?.key(record) || null) && !await previous.gateway.refreshCatalog()) {
        this.assertOpen();
        return previous;
      }
      // Reconnect only between turns so native tool discovery sees the new catalog without losing the thread.
      this.engines.delete(record.id);
      await this.closeTools(previous);
      if (previous.engine.closeTask) { await previous.engine.closeTask(); } else { previous.engine.close(); }
      this.reportProcesses();
      console.info('[ai:catalog-refresh]', { pluginId: this.pluginId, conversationId: record.id });
    }
    const launch = await this.runtime.launch(record.profileId, record.engineId || 'codex', { runtimeId: record.runtimeId, snapshot: record.launchSettings });
    const capture = this.capture ? await this.capture.prepare(record, launch) : { key: null, args: launch.args, env: launch.env };
    this.assertOpen();
    if (launch.runtimeId !== record.runtimeId) {
      throw Error('会话固定的引擎版本尚未安装，不能自动切换版本');
    }
    const gateway = this.createGateway({ capabilities: this.capabilities, conversationId: record.id, task: record.task,
      selection: record.task?.background ? undefined : launch.launchSettings?.mcp,
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
        this.closeTools(active).catch(error => this.report(record.id, error));
        this.persist(record).catch(error => this.report(record.id, error));
        this.reportProcesses();
      } });
    const active = { engine, gateway, captureKey: capture.key };
    // Ownership begins before initialization, which can still be pending when the plugin is stopped.
    this.engines.set(record.id, active);
    try {
      const native = await this.createNativeMcp?.(record, launch);
      active.mcpConnection = native?.connection;
      this.assertOpen();
      await engine.start({ ...launch, cwd: record.cwd, threadId: record.threadId, resume: Boolean(record.threadId),
        plan: record.task?.kind === 'plan' && !record.task?.background, fullyAuthorized: Boolean(record.task?.background), gateway: { url: gateway.url, token: gateway.token }, env: { ...capture.env, WORK_DESK_MCP_TOKEN: gateway.token },
        args: [...capture.args, ...(native?.args || []), '-c', `mcp_servers.work_desk.url=${JSON.stringify(gateway.url)}`,
          '-c', 'mcp_servers.work_desk.bearer_token_env_var="WORK_DESK_MCP_TOKEN"', '-c', 'mcp_servers.work_desk.required=true',
          '-c', 'mcp_servers.work_desk.tool_timeout_sec=600'] });
      this.assertOpen();
      // Workflow authorization covers execution for the thread, including native tool calls and resumed turns.
      if (record.threadId) {
        await engine.request('thread/resume', { threadId: record.threadId, cwd: record.cwd,
          ...(record.task?.background ? { approvalPolicy: backgroundApprovalPolicy, sandbox: 'danger-full-access' }
            : record.task?.bridge ? { approvalPolicy: 'on-request', sandbox: 'read-only' } : {}) });
      } else {
        const { thread } = await engine.request('thread/start', { cwd: record.cwd,
          approvalPolicy: record.task?.background ? backgroundApprovalPolicy : 'on-request',
          sandbox: record.task?.background ? 'danger-full-access' : record.task?.kind === 'plan' ? 'read-only' : 'workspace-write' });
        record.threadId = thread.id;
      }
      this.assertOpen();
      this.reportProcesses();
      await this.persist(record);
      this.toolRefresh.delete(record.id);
      return active;
    } catch (error) {
      if (this.engines.get(record.id) === active) {
        this.engines.delete(record.id);
      }
      engine.close();
      await this.closeTools(active);
      this.reportProcesses();
      throw error;
    }
  }

  // The native reverse-request route belongs to the same conversation lifetime as its capability gateway.
  async closeTools(active) {
    await Promise.all([active.gateway.close(), active.mcpConnection?.close()]);
  }

  assertOpen() {
    if (this.stopped) {
      throw Error('AI 插件正在关闭');
    }
  }

  async reconnect(id) {
    const record = await this.loadRecord(id);
    this.assertOpen();
    this.toolRefresh.add(id);
    if (record.state === 'running' || this.locks.has(id)) { return { pending: true }; }
    this.locks.add(id);
    try {
      await this.connect(record);
      return { pending: false };
    } finally {
      this.locks.delete(id);
    }
  }

  composer(id, report) {
    const key = `${id}:${report.clientId}`;
    const previous = this.composers.get(key);
    if (previous && report.version <= previous.version) { return; }
    this.composers.set(key, { ...report, conversationId: id, at: Date.now() });
  }

  composerReason(id) {
    const views = [...this.composers.values()].filter(view => view.conversationId === id && !view.detached);
    if (!views.length || views.some(view => Date.now() - view.at > 5000)) { return 'composer_unknown'; }
    return views.some(view => !view.empty || view.composing) ? 'draft' : null;
  }

  async send(id, text, external) {
    const record = await this.loadRecord(id);
    if (!record || typeof text !== 'string' || !text.trim()) {
      throw Error('请输入有效对话内容');
    }
    if (this.stopped || this.locks.has(id) || record.state === 'running') {
      throw Error('对话正在执行，请先停止');
    }
    this.locks.add(id);
    let submitted = false;
    try {
      const { engine } = await this.connect(record);
      this.assertOpen();
      external?.beforeStart();
      await external?.ready(record);
      external?.beforeStart();
      record.state = 'running';
      record.name = record.name === '新对话' ? text.slice(0, 40) : record.name;
      this.event(record, { method: 'user/message', params: { text } });
      submitted = true;
      const { turn } = await engine.request('turn/start', { threadId: record.threadId, input: [{ type: 'text', text }] });
      await external?.turnStarted(turn);
      if (record.state === 'running') {
        record.turnId = turn.id;
      }
      await this.persist(record);
      console.info('[ai:turn-start]', { pluginId: this.pluginId, conversationId: id, threadId: record.threadId, turnId: turn.id });
      return this.read(id);
    } catch (error) {
      if (!external || submitted) {
        record.state = 'failed';
        this.event(record, { method: 'error', params: { message: error.message } });
      }
      throw error;
    } finally {
      this.locks.delete(id);
      this.trimRecords();
    }
  }

  onNativeEvent(record, message) {
    if (message.method === 'turn/completed' && isPrimaryTurnEvent(record, message)) {
      record.state = message.params.turn.status === 'completed' ? 'idle' : message.params.turn.status;
      record.turnId = null;
    }
    // Full access never substitutes for a human answer to an explicit native approval request.
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
    const pending = this.pendingWrites.get(record.id);
    if (pending) {
      pending.dirty = true;
      return pending.write;
    }
    const next = { dirty: true };
    // Keep one in-flight snapshot per conversation; streamed updates share the next durable write.
    const write = Promise.resolve().then(async () => {
      try {
        while (next.dirty) {
          next.dirty = false;
          await this.storage.writeJson(this.key(record.id), structuredClone(record));
        }
      } finally {
        this.pendingWrites.delete(record.id);
        this.trimRecords();
      }
    });
    next.write = write;
    this.pendingWrites.set(record.id, next);
    // Different files can drain independently, while stop still waits for every pending write.
    this.writes = Promise.all([this.writes, write]).then(() => {}, () => {});
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
    const record = await this.loadRecord(id);
    const active = this.engines.get(id);
    if (active) {
      try {
        if (record.turnId) {
          await active.engine.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId }, 3000);
        }
      } catch (error) {
        this.report(id, error);
      }
      await this.closeTools(active);
      if (active.engine.closeTask) { await active.engine.closeTask(); }
      else { active.engine.close(); }
      this.engines.delete(id);
      this.reportProcesses();
    }
    record.state = 'cancelled';
    await this.persist(record);
  }

  // Archive in place so closing a reused node never duplicates its transcript.
  async archive(id) {
    await this.cancelTask(id);
    const record = await this.loadRecord(id);
    record.archivedAt ||= new Date().toISOString();
    await this.persist(record);
  }

  approve(id, requestId, decision) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) {
      throw Error('无效审批结果');
    }
    const record = this.records.get(id);
    const request = record?.events?.find(event => event.id === requestId && isApprovalRequest(event));
    if (!request || !this.engines.has(id)) {
      throw Error('审批已失效');
    }
    let result = { decision };
    if (request.method === 'item/permissions/requestApproval') {
      result = { permissions: decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
    } else if (request.method === 'mcpServer/elicitation/request') {
      result = { action: decision, ...(decision === 'accept' ? { content: {} } : {}) };
    }
    this.engines.get(id).engine.respond(requestId, result);
    this.event(record, { method: 'approval/answered', params: { requestId, decision } });
  }

  answer(id, requestId, answers) {
    const record = this.records.get(id);
    const request = record?.events?.find(event => event.id === requestId && event.method === 'item/tool/requestUserInput');
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

  // Generic MCP input is separate from tool approval and keeps native content types intact.
  elicit(id, requestId, decision, content) {
    const record = this.records.get(id);
    const request = pendingRequests(record?.events || []).find(event => event.id === requestId && isElicitationRequest(event));
    if (!request || !this.engines.has(id) || ['failed', 'interrupted', 'cancelled'].includes(record.state)) {
      throw Error('问题已失效');
    }
    const result = elicitationResult(request.params, decision, content);
    this.engines.get(id).engine.respond(requestId, result);
    // Persist only the decision; authorization form values may contain private information.
    this.event(record, { method: 'approval/answered', params: { requestId, decision } });
    console.info('[ai:mcp-elicitation-answered]', { pluginId: this.pluginId, conversationId: id, requestId, decision });
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
        await this.closeTools(active);
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
    const launch = await this.runtime.launch(undefined, 'codex', { account: true });
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
      await this.closeTools(active);
      active.engine.close();
      const record = this.records.get(id);
      record.state = record.state === 'running' ? 'interrupted' : record.state;
      await this.persist(record);
    }
    this.engines.clear();
    this.accountEngine?.close();
    this.accountEngine = null;
    await this.writes;
    await this.history.save(this.records);
    this.trimRecords();
    this.reportProcesses();
  }
}
