import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createStdioTransport } from '../os/posix/transport.js';

const LIMIT = 1024 * 1024;
const TIMEOUT = 18000;
const failure = (code, message) => Object.assign(Error(message), { code });

export class McpServices {
  constructor(context) {
    this.context = context;
    this.key = `plugin-data/${context.pluginId}/services.json`;
    this.running = new Map();
    this.states = new Map();
    this.entries = new Map();
    this.pids = new Set();
    this.logWrites = new Map();
  }

  async definitions() {
    const definitions = await this.context.storage.readJson(this.key, []);
    for (const { id } of definitions) {
      if (!this.entries.has(id)) { this.entries.set(id, await this.context.storage.readJson(`plugin-data/${this.context.pluginId}/logs/${id}.json`, '')); }
    }
    return definitions;
  }

  async save(input) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || typeof input.name !== 'string' || !input.name.trim()) {
      throw failure('INVALID_ARGUMENT', '服务需要有效 ID 和名称');
    }
    const config = { id: input.id, name: input.name.trim(), transport: input.transport };
    if (input.transport === 'stdio') {
      if (typeof input.command !== 'string' || !input.command.trim() || !Array.isArray(input.args)
        || input.args.some(value => typeof value !== 'string')) { throw failure('INVALID_ARGUMENT', '命令和参数无效'); }
      Object.assign(config, { command: input.command, args: input.args, cwd: input.cwd || '', env: input.env || {} });
    } else if (input.transport === 'http') {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw failure('INVALID_ARGUMENT', '只支持 HTTP(S) URL'); }
      Object.assign(config, { url: url.href, headers: input.headers || {} });
    } else { throw failure('INVALID_ARGUMENT', '只支持 stdio 和 Streamable HTTP'); }
    const values = config.env || config.headers;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'string')) {
      throw failure('INVALID_ARGUMENT', '环境变量或请求头必须是字符串映射');
    }
    if (config.transport === 'http') {
      if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
        throw failure('INVALID_ARGUMENT', '密钥必须是字符串');
      }
      if (input.apiKey?.trim()) {
        // Persist through the existing header format so old installations need no data migration.
        config.headers = Object.fromEntries(Object.entries(config.headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
        config.headers.Authorization = `Bearer ${input.apiKey.trim().replace(/^Bearer\s+/i, '')}`;
      }
    }
    if (this.running.has(input.id)) { throw failure('SERVICE_BUSY', '请先停止服务再修改配置'); }
    const definitions = await this.definitions();
    await this.context.storage.writeJson(this.key, [...definitions.filter(value => value.id !== input.id), config]);
    this.log(config, 'info', '配置已保存');
    return config.id;
  }

  async remove(id) {
    await this.stop(id);
    await this.context.storage.writeJson(this.key, (await this.definitions()).filter(value => value.id !== id));
    this.states.delete(id);
  }

  async list() {
    return (await this.definitions()).map(config => ({ ...config, state: this.running.has(config.id) ? 'running' : this.states.get(config.id) || 'stopped',
      clients: this.running.get(config.id)?.clients.size || 0 }));
  }

  log(config, level, message) {
    let text = String(message);
    for (const secret of Object.values(config.env || config.headers || {})) {
      if (secret) {
        text = text.split(secret).join('[redacted]');
        if (/^Bearer\s+/i.test(secret)) { text = text.split(secret.replace(/^Bearer\s+/i, '')).join('[redacted]'); }
      }
    }
    const entry = `${new Date().toISOString()} ${level} ${text.slice(0, 8192)}`;
    this.entries.set(config.id, Buffer.from(`${this.entries.get(config.id) || ''}${entry}\n`).subarray(-LIMIT).toString());
    if (!this.logWrites.has(config.id)) {
      // Coalesce noisy stderr while retaining only the bounded latest log.
      const write = (async () => {
        let saved;
        do {
          saved = this.entries.get(config.id);
          await this.context.storage.writeJson(`plugin-data/${this.context.pluginId}/logs/${config.id}.json`, saved);
        } while (saved !== this.entries.get(config.id));
      })();
      this.logWrites.set(config.id, write);
      write.catch(error => console.error('[mcp:log]', { serviceId: config.id, message: error.message }))
        .finally(() => this.logWrites.delete(config.id));
    }
    this.context.emit?.('mcp.changed', { serviceId: config.id });
    (level === 'error' ? console.error : console.info)('[mcp]', { serviceId: config.id, message: level === 'error' ? '操作失败，请查看插件日志' : text.slice(0, 160) });
  }

  async logs(id) {
    await this.definitions();
    return this.entries.get(id) || '';
  }

  async sdk() {
    if (!this.modules) {
      const load = this.context.importModule;
      this.modules = Promise.all([
        load('@modelcontextprotocol/sdk/client/index.js'), load('@modelcontextprotocol/sdk/client/streamableHttp.js'),
        load('@modelcontextprotocol/sdk/server/index.js'), load('@modelcontextprotocol/sdk/server/streamableHttp.js'),
        load('@modelcontextprotocol/sdk/shared/stdio.js'), load('@modelcontextprotocol/sdk/types.js')
      ]).then(([client, httpClient, server, httpServer, stdio, types]) => ({ ...client, ...httpClient, ...server, ...httpServer, stdio, types }));
    }
    return this.modules;
  }

  async connect(config, signal) {
    const sdk = await this.sdk();
    const client = new sdk.Client({ name: 'work-desk-mcp', version: '0.1.0' });
    const transport = config.transport === 'stdio' ? createStdioTransport(config, sdk.stdio, (pid, active) => {
      active ? this.pids.add(pid) : this.pids.delete(pid);
      this.context.ownProcesses([...this.pids]);
    }, (level, text) => this.log(config, level, text)) : new sdk.StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers }, reconnectionOptions: { maxRetries: 0 },
      fetch: async (url, options) => {
        const opening = new AbortController();
        const timer = options.method === 'GET' ? setTimeout(() => opening.abort(), TIMEOUT) : null;
        try {
          // Bound GET response headers, then let the notification stream live until the client closes it.
          return await fetch(url, { ...options, signal: AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            ...(options.method !== 'DELETE' && signal ? [signal] : []),
            options.method === 'GET' ? opening.signal : AbortSignal.timeout(options.method === 'DELETE' ? 1500 : TIMEOUT)
          ]) });
        } finally {
          clearTimeout(timer);
        }
      } });
    const close = client.close.bind(client);
    client.close = async () => {
      try {
        if (config.transport === 'http' && transport.sessionId) { await transport.terminateSession(); }
      } catch (error) { this.log(config, 'error', `终止远程会话失败: ${error.message}`); }
      finally { await close(); }
    };
    let timer;
    let abort;
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(failure('MCP_CANCELLED', '连接已取消'));
      if (signal?.aborted) { abort(); }
      else { signal?.addEventListener('abort', abort, { once: true }); }
      timer = setTimeout(() => reject(failure('MCP_TIMEOUT', 'MCP 握手超时')), TIMEOUT);
    });
    try {
      // The SDK timeout excludes notifications/initialized; bound the complete handshake.
      await Promise.race([client.connect(transport, { timeout: TIMEOUT }), cancelled]);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async start(id) {
    if (this.running.has(id) || this.states.get(id) === 'starting') { throw failure('SERVICE_BUSY', '服务已经启动或正在启动'); }
    const config = (await this.definitions()).find(value => value.id === id);
    if (!config) { throw failure('SERVICE_NOT_FOUND', '服务不存在'); }
    this.states.set(id, 'starting');
    let runtime;
    try {
      const management = await this.connect(config);
      runtime = { config, management, clients: new Map(), sessions: new Set(), controller: new AbortController(), token: randomBytes(32).toString('hex') };
      management.onclose = () => {
        if (this.running.get(id) === runtime) {
          this.stop(id).then(() => this.states.set(id, 'error')).catch(error => this.log(config, 'error', error.message));
        }
      };
      runtime.server = createServer((request, response) => this.handle(runtime, request, response).catch(error => {
        this.log(config, 'error', error.message);
        if (!response.headersSent) { response.writeHead(502); }
        response.end();
      }));
      await new Promise((resolve, reject) => {
        runtime.server.once('error', reject);
        runtime.server.listen(0, '127.0.0.1', resolve);
      });
      runtime.url = `http://127.0.0.1:${runtime.server.address().port}/mcp`;
      this.running.set(id, runtime);
      this.log(config, 'info', '网关已启动');
    } catch (error) {
      await runtime?.management.close();
      this.states.set(id, 'error');
      this.log(config, 'error', error.message);
      throw failure('MCP_START_FAILED', `服务 ${id} 启动失败，请查看日志`);
    }
  }

  async handle(runtime, request, response) {
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${runtime.token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); return; }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    let body;
    if (request.method === 'POST') {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > LIMIT) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { response.writeHead(400).end(); return; }
    }
    if (runtime.controller.signal.aborted) { response.writeHead(503).end(); return; }
    const sessionId = request.headers['mcp-session-id'];
    if (sessionId) {
      const session = runtime.clients.get(sessionId);
      if (!session) { response.writeHead(404).end(); return; }
      this.touch(runtime, session);
      if (request.method === 'GET') {
        // Allow a brief HTTP reconnect, then release the independent upstream.
        session.streams = (session.streams || 0) + 1;
        clearTimeout(session.timer);
        response.once('close', () => {
          session.streams--;
          this.touch(runtime, session, 2000);
        });
      }
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (request.method !== 'POST') { response.writeHead(400).end(); return; }
    const sdk = await this.sdk();
    if (!sdk.types.InitializeRequestSchema.safeParse(body).success) { response.writeHead(400).end(); return; }
    if (runtime.sessions.size >= 16) { response.writeHead(429).end(); return; }
    // Reserve before connecting so concurrent initialize and stop share one lifecycle.
    const session = {};
    runtime.sessions.add(session);
    session.connecting = this.connect(runtime.config, runtime.controller.signal);
    try {
      const upstream = await session.connecting;
      session.upstream = upstream;
      if (session.closed || runtime.controller.signal.aborted) { await upstream.close(); return; }
      const caps = upstream.getServerCapabilities();
      const capabilities = Object.fromEntries(['tools', 'resources', 'prompts'].filter(key => caps[key]).map(key => [key, { ...(caps[key].listChanged ? { listChanged: true } : {}) }]));
      const server = new sdk.Server({ name: 'work-desk-gateway', version: '0.1.0' }, { capabilities });
      const routes = [['tools', 'ListToolsRequestSchema', 'listTools'], ['tools', 'CallToolRequestSchema', 'callTool'],
        ['resources', 'ListResourcesRequestSchema', 'listResources'], ['resources', 'ListResourceTemplatesRequestSchema', 'listResourceTemplates'],
        ['resources', 'ReadResourceRequestSchema', 'readResource'], ['prompts', 'ListPromptsRequestSchema', 'listPrompts'],
        ['prompts', 'GetPromptRequestSchema', 'getPrompt']];
      for (const [capability, schema, method] of routes) {
        if (capabilities[capability]) {
          server.setRequestHandler(sdk.types[schema], async request => {
            const result = method === 'callTool' ? await upstream.callTool(request.params, undefined, { timeout: TIMEOUT })
              : await upstream[method](request.params, { timeout: TIMEOUT });
            if (Buffer.byteLength(JSON.stringify(result)) > LIMIT) { throw Error('MCP 响应超过 1 MiB'); }
            return result;
          });
        }
      }
      // Forward changes without exposing unsupported server-to-client requests.
      for (const [capability, schema, method] of [['tools', 'ToolListChangedNotificationSchema', 'sendToolListChanged'],
        ['resources', 'ResourceListChangedNotificationSchema', 'sendResourceListChanged'], ['prompts', 'PromptListChangedNotificationSchema', 'sendPromptListChanged']]) {
        if (capabilities[capability]?.listChanged) { upstream.setNotificationHandler(sdk.types[schema], () => server[method]()); }
      }
      const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: id => { session.id = id; runtime.clients.set(id, session); },
        onsessionclosed: () => this.dispose(runtime, session) });
      Object.assign(session, { transport, server });
      await server.connect(transport);
      upstream.onclose = () => this.dispose(runtime, session).catch(error => this.log(runtime.config, 'error', error.message));
      this.touch(runtime, session);
      await transport.handleRequest(request, response, body);
      if (!session.id) { await this.dispose(runtime, session); }
    } catch (error) {
      await this.dispose(runtime, session);
      throw error;
    }
  }

  touch(runtime, session, timeout = 30000) {
    clearTimeout(session.timer);
    if (session.closed || session.streams) { return; }
    session.timer = setTimeout(() => this.dispose(runtime, session)
      .catch(error => this.log(runtime.config, 'error', error.message)), timeout);
    session.timer.unref();
  }

  async dispose(runtime, session) {
    if (session.closed) { return; }
    session.closed = true;
    clearTimeout(session.timer);
    runtime.clients.delete(session.id);
    runtime.sessions.delete(session);
    await session.server?.close();
    await session.upstream?.close();
  }

  async stop(id) {
    const runtime = this.running.get(id);
    if (!runtime) { return; }
    this.running.delete(id);
    runtime.controller.abort();
    const sessions = [...runtime.sessions];
    await Promise.all(sessions.map(async session => {
      await this.dispose(runtime, session);
      await session.connecting.catch(() => {});
      await session.upstream?.close();
    }));
    runtime.server.closeAllConnections();
    await new Promise(resolve => runtime.server.close(resolve));
    await runtime.management.close();
    this.states.set(id, 'stopped');
    this.log(runtime.config, 'info', '服务已停止');
  }

  active(id) {
    const runtime = this.running.get(id);
    if (!runtime) { throw failure('SERVICE_UNAVAILABLE', '服务未启动'); }
    return runtime;
  }

  async tools(id) { return this.active(id).management.listTools({}, { timeout: TIMEOUT }); }
  async call(id, name, args) { return this.active(id).management.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT }); }
  async connections() {
    return { version: 1, services: (await this.definitions()).map(({ id, name }) => {
      const runtime = this.running.get(id);
      return { id, name, state: runtime ? 'running' : this.states.get(id) || 'stopped',
        ...(runtime ? { url: runtime.url, headers: { Authorization: `Bearer ${runtime.token}` } } : {}) };
    }) };
  }
  async close() {
    await Promise.all([...this.running.keys()].map(id => this.stop(id)));
    await Promise.all([...this.logWrites.values()]);
  }
}
