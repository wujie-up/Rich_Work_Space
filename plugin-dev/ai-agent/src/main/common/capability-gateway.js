import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class CapabilityGateway {
  constructor(options) {
    Object.assign(this, options);
    this.handles = new Map();
    this.active = new Set();
    this.token = randomBytes(32).toString('hex');
  }

  async start() {
    await this.refreshCatalog();
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.url = `http://127.0.0.1:${this.server.address().port}/mcp`;
    return this;
  }

  async serve(request, response) {
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (!this.token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end();
      return;
    }
    // Browser origins must never be able to use this loopback endpoint with ambient credentials.
    if (request.headers.origin || request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let message;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          throw Error('MCP 请求过大');
        }
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result = await this.dispatch(message);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(200, { 'content-type': 'application/json' });
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: error.message } }));
    }
  }

  async dispatch({ method, params = {} }) {
    if (method === 'initialize') {
      return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'work-desk-capabilities', version: '1.0.0' } };
    }
    if (method === 'ping') {
      return {};
    }
    if (method === 'tools/list') {
      await this.refreshCatalog();
      return { tools: this.tools };
    }
    if (method === 'tools/call') {
      return this.call(params);
    }
    throw Error(`不支持的 MCP 方法：${method}`);
  }

  async refreshCatalog() {
    const catalog = await this.capabilities.discover();
    const changed = this.catalogRevision !== undefined && this.catalogRevision !== catalog.catalogRevision;
    this.catalogRevision = catalog.catalogRevision;
    this.handles.clear();
    this.tools = catalog.providers.filter(({ state, handle, descriptor }) => {
      if (state !== 'ready' || /^agent\.(menu|task|mcp)\./.test(descriptor.id)) { return false; }
      if (this.task?.mcpDebug) {
        return descriptor.source?.debug === true && descriptor.source.serviceId === this.task.mcpDebug.serviceId
          && handle.pluginId === this.task.mcpDebug.pluginId;
      }
      return !this.task && descriptor.source?.debug !== true;
    }).map(({ handle, descriptor }) => {
      const name = `cap_${createHash('sha256').update(JSON.stringify(handle)).digest('hex').slice(0, 24)}`;
      // Match the host's read effects so tool hints describe the same approval boundary.
      const readOnly = descriptor.effects.length > 0
        && descriptor.effects.every(effect => /^(filesystem|network|workspace|document)\.read$/.test(effect));
      this.handles.set(name, handle);
      return { name, title: descriptor.title, description: descriptor.description, inputSchema: descriptor.inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly } };
    });
    return changed;
  }

  async call({ name, arguments: input }) {
    try {
      const handle = this.handles.get(name);
      if (!handle || !this.token) {
        throw Error('工具句柄已失效，请重新发现能力');
      }
      // Host binds caller identity and trace lineage; model-supplied identity/options are never forwarded.
      const task = await this.capabilities.invoke(handle, input, {});
      this.active.add(task.invocationId);
      this.onInvocation({ conversationId: this.conversationId, ...task });
      try {
        while (this.token) {
          const snapshot = await this.capabilities.getInvocation(task.invocationId);
          if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state)) {
            this.onInvocation({ conversationId: this.conversationId, ...snapshot });
            return { content: [{ type: 'text', text: JSON.stringify(snapshot.state === 'succeeded' ? snapshot.result : snapshot.error) }],
              isError: snapshot.state !== 'succeeded' };
          }
          await delay(100);
        }
        throw Error('会话网关已关闭');
      } finally {
        this.active.delete(task.invocationId);
      }
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }

  async cancel() {
    await Promise.allSettled([...this.active].map(id => this.capabilities.cancel(id)));
  }

  async close() {
    this.token = null;
    await this.cancel();
    this.handles.clear();
    if (this.server?.listening) {
      this.server.closeAllConnections();
      await new Promise(resolve => this.server.close(resolve));
    }
  }
}
