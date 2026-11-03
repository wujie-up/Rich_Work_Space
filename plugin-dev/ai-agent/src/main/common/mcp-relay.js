import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CapabilityGateway } from './capability-gateway.js';

// Native CLI processes keep their MCP configuration for their lifetime. Only this session-local address is stable;
// upstream addresses and credentials are refreshed before terminal input submission and never written to disk.
export function relayServices(engineId, config) {
  if (engineId === 'claude') { return config.mcpServers; }
  const services = {};
  for (const override of config) {
    const match = override.match(/^mcp_servers\.(desk_[a-zA-Z0-9_]+)\.(url|http_headers)=(.*)$/s);
    if (!match) { throw Error('MCP 连接配置无效'); }
    const [, name, field, value] = match;
    services[name] ||= { type: 'http', headers: {} };
    if (field === 'url') { services[name].url = JSON.parse(value); }
    else {
      const header = value.match(/^\{\s*Authorization\s*=\s*("(?:[^"\\]|\\.)*")\s*\}$/s);
      if (!header) { throw Error('MCP 认证配置无效'); }
      services[name].headers.Authorization = JSON.parse(header[1]);
    }
  }
  return services;
}

export class McpRelay {
  constructor(options) {
    Object.assign(this, options);
    this.token = randomBytes(32).toString('hex');
    this.active = new Set();
    this.connections = new Map();
    this.retired = new Set();
    this.watchers = new Map();
    this.clientCapabilities = new Map();
    this.requests = new Map();
  }

  async start(engineId, config) {
    this.engineId = engineId;
    this.targets = new Map(Object.entries(relayServices(engineId, config)));
    this.names = new Set(this.targets.keys());
    if (this.builtin) { this.names.add('desk_agent_sessions'); }
    if (this.capabilities) {
      // External MCP services keep their native names and selections on the existing relay routes.
      this.gateway = new CapabilityGateway({ capabilities: this.capabilities, selection: { mode: 'selected', services: [] },
        conversationId: this.sessionId, onInvocation: snapshot => console.info('[ai:native-capability]', {
          pluginId: this.pluginId, sessionId: this.sessionId, invocationId: snapshot.invocationId, state: snapshot.state
        }) });
      this.names.add('desk_capabilities');
      await this.refreshCapabilities();
    }
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.url = `http://127.0.0.1:${this.server.address().port}/mcp`;
    return engineId === 'claude' ? { mcpServers: Object.fromEntries([...this.names].map(name => [name,
      { type: 'http', url: `${this.url}/${name}`, headers: { Authorization: `Bearer ${this.token}` } }])) }
      : [...this.names].flatMap(name => [`mcp_servers.${name}.url=${JSON.stringify(`${this.url}/${name}`)}`,
        `mcp_servers.${name}.http_headers={ Authorization = ${JSON.stringify(`Bearer ${this.token}`)} }`,
        `mcp_servers.${name}.tool_timeout_sec=600`]);
  }

  // Must run in the submitting RPC: host services deliberately reject detached HTTP callbacks.
  async refresh() {
    await this.refreshCapabilities();
    const names = [...this.names].filter(name => name !== 'desk_capabilities' && (name !== 'desk_agent_sessions' || !this.builtin));
    const updates = await Promise.allSettled(names.map(async name => relayServices(this.engineId, await this.resolve(name))[name]));
    if (!this.token) { throw Error('会话连接已关闭'); }
    for (const [index, update] of updates.entries()) {
      const name = names[index];
      const previous = this.targets.get(name);
      const target = update.status === 'fulfilled' ? update.value : undefined;
      if (target) { this.targets.set(name, target); } else { this.targets.delete(name); }
      if (JSON.stringify(previous) !== JSON.stringify(target)) {
        const entry = this.connections.get(name);
        if (entry) {
          this.connections.delete(name);
          this.retired.add(entry);
          if (!entry.users) { void this.retire(entry); }
        }
        for (const kind of ['tools', 'resources', 'prompts']) { this.notify(name, kind); }
      }
    }
  }

  // Peer turns reuse the already resolved relay targets; only user RPCs may resolve missing external services.
  get automaticInputReason() {
    return [...this.names].some(name => name !== 'desk_capabilities'
      && (name !== 'desk_agent_sessions' || !this.builtin) && !this.targets.has(name))
      ? 'connection_refresh_required' : null;
  }

  // Discovery failure must not block terminal input or retain stale capability handles.
  async refreshCapabilities() {
    if (!this.gateway) { return; }
    try {
      if (await this.gateway.refreshCatalog()) { this.notify('desk_capabilities', 'tools'); }
    } catch (error) {
      this.gateway.tools = [];
      this.gateway.handles.clear();
      console.error('[ai:native-capability-refresh-failed]', { pluginId: this.pluginId, sessionId: this.sessionId }, error);
    }
  }

  async builtinResult(message) {
    if (message.method === 'initialize') {
      return { protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'work-desk-agent-sessions', version: '1.0.0' } };
    }
    if (message.method === 'tools/list') { return { tools: this.builtin.tools }; }
    if (message.method === 'tools/call') {
      const result = await this.builtin.call(message.params?.name, message.params?.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    throw Error('不支持的会话通信方法');
  }

  async sdk() {
    this.modules ||= Promise.all([
      this.importModule('@modelcontextprotocol/sdk/client/index.js'),
      this.importModule('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      this.importModule('@modelcontextprotocol/sdk/types.js')
    ]).then(([client, transport, types]) => ({ ...client, ...transport, ...types }));
    return this.modules;
  }

  connection(name, target, sdk) {
    const capabilities = this.clientCapabilities.get(name) || {};
    const fingerprint = createHash('sha256').update(JSON.stringify([target.url, target.headers || {}, capabilities])).digest('hex');
    let entry = this.connections.get(name);
    if (entry?.fingerprint !== fingerprint) {
      if (entry) {
        this.connections.delete(name);
        this.retired.add(entry);
        if (!entry.users) { void this.retire(entry); }
      }
      const controller = new AbortController();
      const client = new sdk.Client({ name: 'work-desk-mcp-relay', version: '1.0.0' }, { capabilities });
      for (const [capability, schema] of [['elicitation', 'ElicitRequestSchema'], ['roots', 'ListRootsRequestSchema'],
        ['sampling', 'CreateMessageRequestSchema']]) {
        if (capabilities[capability]) {
          client.setRequestHandler(sdk[schema], (request, extra) => this.requestClient(name, request, extra.signal));
        }
      }
      entry = { name, fingerprint, controller, client, users: 0 };
      this.connections.set(name, entry);
      entry.ready = client.connect(new sdk.StreamableHTTPClientTransport(new URL(target.url), {
        requestInit: { headers: target.headers || {} }
      }), { signal: controller.signal, timeout: 18000 });
      entry.ready.then(() => {
        for (const [kind, schema] of [['tools', 'ToolListChangedNotificationSchema'],
          ['resources', 'ResourceListChangedNotificationSchema'], ['prompts', 'PromptListChangedNotificationSchema']]) {
          client.setNotificationHandler(sdk[schema], () => this.notify(name, kind));
          this.notify(name, kind);
        }
      }).catch(() => {});
    }
    entry.users++;
    return entry;
  }

  async retire(entry) {
    if (this.connections.get(entry.name) === entry) { this.connections.delete(entry.name); }
    this.retired.delete(entry);
    entry.controller.abort();
    await entry.client.close().catch(() => {});
  }

  notify(name, kind) {
    const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: `notifications/${kind}/list_changed` })}\n\n`;
    for (const response of this.watchers.get(name) || []) { response.write(event); }
  }

  // Prefer the notification stream so cancelling a tool can also dismiss its pending user prompt.
  requestClient(name, request, signal) {
    const watcher = () => [...(this.watchers.get(name) || [])].find(response => !response.destroyed && !response.writableEnded);
    const response = watcher() || [...this.active].find(active => active.name === name && active.messageId !== undefined
      && !active.response.destroyed && !active.response.writableEnded)?.response;
    if (!response) { throw Error('原生客户端已断开，无法请求用户输入'); }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.requests.delete(id);
        error ? reject(error) : resolve(result);
      };
      const abort = () => {
        const target = !response.destroyed && !response.writableEnded ? response : watcher();
        if (target?.headersSent) {
          target.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })}\n\n`);
        }
        finish(signal.reason || Error('MCP 请求已取消'));
      };
      const timer = setTimeout(() => finish(Error('原生客户端响应超时')), 600000);
      this.requests.set(id, { name, finish });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      if (!response.headersSent) { response.writeHead(200, { 'content-type': 'text/event-stream' }); }
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, method: request.method, params: request.params })}\n\n`);
    });
  }

  async serve(request, response) {
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (!this.token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end();
      return;
    }
    const name = request.url?.match(/^\/mcp\/(desk_[a-zA-Z0-9_]+)$/)?.[1];
    if (request.headers.origin || !['GET', 'POST'].includes(request.method) || !this.names.has(name)) {
      response.writeHead(405).end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.flushHeaders();
      const watchers = this.watchers.get(name) || new Set();
      watchers.add(response);
      this.watchers.set(name, watchers);
      response.once('close', () => { watchers.delete(response); });
      return;
    }
    let message;
    const controller = new AbortController();
    const active = { controller, name, response };
    this.active.add(active);
    response.once('close', () => { if (!response.writableEnded) { controller.abort(); } });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) { throw Error('MCP 请求过大'); }
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks).toString());
      if (!message.method && message.id !== undefined) {
        const pending = this.requests.get(message.id);
        if (!pending || pending.name !== name) { response.writeHead(400).end(); return; }
        pending.finish(message.error ? Object.assign(Error(message.error.message), { code: message.error.code }) : null, message.result);
        response.writeHead(202).end();
        return;
      }
      if (message.id === undefined) {
        if (message.method === 'notifications/cancelled') {
          for (const running of this.active) {
            if (running.name === name && running.messageId === message.params?.requestId) { running.controller.abort(); }
          }
        } else if (message.method === 'notifications/roots/list_changed') {
          const entry = this.connections.get(name);
          if (entry) { await entry.ready; await entry.client.notification(message); }
        }
        response.writeHead(202).end();
        return;
      }
      active.messageId = message.id;
      let result;
      if (message.method === 'ping') { result = {}; }
      else if (name === 'desk_agent_sessions' && this.builtin) { result = await this.builtinResult(message); }
      else if (name === 'desk_capabilities' && this.gateway) {
        result = await this.gateway.dispatch(message);
        if (message.method === 'initialize') { result.capabilities.tools.listChanged = true; }
      }
      else if (['initialize', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read',
        'prompts/list', 'prompts/get'].includes(message.method)) {
        const target = this.targets.get(name);
        if (!target?.url) { throw Error('MCP 服务未启用或不可用，请先启动服务'); }
        const sdk = await this.sdk();
        controller.signal.throwIfAborted();
        if (message.method === 'initialize') { this.clientCapabilities.set(name, message.params?.capabilities || {}); }
        // Keep a live upstream session for OAuth callbacks and stateful tools. Rotated connections drain before closing.
        const entry = this.connection(name, target, sdk);
        active.connection = entry;
        try {
          await entry.ready;
          controller.signal.throwIfAborted();
          if (message.method === 'initialize') {
            const capabilities = entry.client.getServerCapabilities() || {};
            result = { protocolVersion: '2025-03-26', capabilities: Object.fromEntries(
              ['tools', 'resources', 'prompts'].filter(key => capabilities[key]).map(key => [key, { listChanged: true }])),
              serverInfo: { name: 'work-desk-mcp-relay', version: '1.0.0' } };
          } else {
            result = await entry.client.request({ method: message.method, params: message.params }, sdk.ResultSchema,
              { signal: controller.signal, timeout: message.method === 'tools/call' ? 600000 : 18000 });
          }
        } catch {
          this.retired.add(entry);
          if (this.connections.get(name) === entry) { this.connections.delete(name); }
          throw Error('MCP 服务连接或调用失败，请检查服务状态。本次调用未自动重试；写入或部署操作请先核查执行结果。');
        }
      } else { throw Error('不支持的 MCP 方法'); }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      if (response.headersSent) { response.end(`event: message\ndata: ${reply}\n\n`); }
      else { response.writeHead(200, { 'content-type': 'application/json' }).end(reply); }
    } catch (error) {
      console.error('[ai:mcp-relay-failed]', { pluginId: this.pluginId, sessionId: this.sessionId, server: name, method: message?.method, error: error.stack });
      if (!response.destroyed && !response.writableEnded) {
        const reply = JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: error.message } });
        if (response.headersSent) { response.end(`event: message\ndata: ${reply}\n\n`); }
        else { response.writeHead(200, { 'content-type': 'application/json' }).end(reply); }
      }
    } finally {
      const entry = active.connection;
      if (entry) {
        entry.users--;
        if (!entry.users && this.retired.has(entry)) { await this.retire(entry); }
      }
      this.active.delete(active);
    }
  }

  async close() {
    this.token = '';
    try {
      await this.gateway?.close();
    } catch (error) {
      // Capability cleanup must not leave this session's existing MCP connections open.
      console.error('[ai:native-capability-close-failed]', { pluginId: this.pluginId, sessionId: this.sessionId }, error);
    }
    for (const active of this.active) {
      active.controller.abort();
    }
    for (const pending of this.requests.values()) { pending.finish(Error('会话连接已关闭')); }
    this.clientCapabilities.clear();
    for (const entry of new Set([...this.connections.values(), ...this.retired])) { await this.retire(entry); }
    for (const watchers of this.watchers.values()) {
      for (const response of watchers) { response.end(); }
    }
    this.watchers.clear();
    if (this.server) {
      await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); });
      this.server = null;
    }
  }
}
