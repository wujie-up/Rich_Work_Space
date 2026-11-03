import { join } from 'node:path';
import { listener, json, jsonBody, staticFile, httpError } from './http.js';
import { certificate, addresses } from './certificate.js';
import { createRemoteHandlers } from './remote.js';

import { ServiceTransport } from './transport.js';
import { shellDocument, pluginResources, pluginInputResources } from './static-resources.js';

const cookieName = '__Host-deckpg';
const tokenFor = request => (request.headers.cookie || '').split(';').map(value => value.trim())
  .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
const allowed = new Set(['plugins.list', 'plugins.start', 'plugins.enable', 'plugins.preview', 'plugins.disable', 'plugins.forceDisable',
  'plugins.close', 'plugins.forceClose', 'plugins.remove', 'plugins.retryCleanup', 'plugins.invoke', 'plugins.setMultipleWindows',
  'plugins.setAutoStart', 'plugins.resetIcon', 'plugins.checkUpdates', 'plugins.scanUpdates', 'plugins.upgradeLatest',
  'desktop.list', 'desktop.read', 'desktop.properties', 'desktop.create', 'desktop.resolve', 'desktop.rename', 'desktop.trash',
  'storage.getPreferences', 'storage.savePreferences', 'messages.list', 'messages.respond', 'messages.defer', 'capabilities.approve']);

export class WebWorkspace {
  constructor({ storage, plugins, handlers, root }) {
    Object.assign(this, { storage, plugins, handlers, root });
    this.clients = new Set();
    this.frames = new Map();
    this.attempts = new Map();
    this.pending = Promise.resolve();
    this.generation = 0;
    this.remote = createRemoteHandlers(this);
    this.transport = new ServiceTransport(this);
  }

  async accounts() {
    if (!this.accountStore) {
      const { Accounts, csrfFor } = await import('./accounts.js');
      this.csrfFor = csrfFor;
      this.accountStore = new Accounts(await this.storage.path('web'));
    }
    return this.accountStore;
  }

  async listAccounts() {
    return (await this.accounts()).list();
  }

  async saveAccount(username, password) {
    await (await this.accounts()).save(username, password);
    this.revalidateClients();
    console.info('[web:account-saved]', { username });
  }

  async removeAccount(username) {
    await (await this.accounts()).remove(username);
    this.revalidateClients();
    console.info('[web:account-removed]', { username });
  }

  async status() {
    const config = await this.storage.readJson('web/settings.json', { enabled: false, port: 47831 });
    return { ...config, enabled: Boolean(this.server), port: this.port || config.port, configured: config.enabled,
      addresses: this.server ? addresses().map(host => `https://${host}:${this.port}`) : [],
      certificatePath: join(this.storage.root, 'web/certificate.pem'), error: this.error || null };
  }

  configure(value) {
    const next = this.pending.catch(() => {}).then(async () => {
      if (typeof value.enabled !== 'boolean' || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535
        || value.port > 0 && value.port < 1024) {
        throw Error('网页端口须为 1024–65535');
      }
      await this.stop();
      if (value.enabled) {
        await this.start(value.port);
      }
      await this.storage.writeJson('web/settings.json', value);
      return this.status();
    });
    this.pending = next;
    return next;
  }

  async start(port) {
    if (this.server) {
      return;
    }
    const generation = this.generation;
    try {
      const accounts = await this.accounts();
      if (!accounts.list().length) {
        throw Error('请先创建网页账号');
      }
      accounts.revokeAll();
      const config = await this.storage.readJson('web/settings.json', { port: 47831 });
      const tls = await certificate(await this.storage.path('web'));
      if (generation !== this.generation) {
        return;
      }
      const server = await listener(tls, (request, response) => this.handle(request, response), port ?? config.port);
      // A disabled service must not reappear when a pending certificate/listen operation finishes.
      if (generation !== this.generation) {
        await server.close();
        return;
      }
      this.tls = tls;
      this.server = server;
      this.port = server.port;
      this.heartbeat = setInterval(() => this.revalidateClients(), 25_000);
      this.heartbeat.unref();
      this.error = null;
      console.info('[web:started]', { port: this.port });
    } catch (error) {
      console.error('[web:start-failed]', { stack: error.stack });
      if (generation === this.generation) {
        this.error = error.message;
        await this.stop();
      }
      throw error;
    }
  }

  async stop() {
    this.generation++;
    await this.transport.closeAll();
    clearInterval(this.heartbeat);
    this.accountStore?.revokeAll();
    for (const client of this.clients) {
      client.response.end('event: revoked\ndata: {}\n\n');
    }
    this.clients.clear();
    const listeners = [...this.frames.values()];
    this.frames.clear();
    if (this.server) {
      listeners.push(this.server);
      this.server = null;
    }
    await Promise.all(listeners.map(async pending => {
      try {
        await (await pending).close();
      } catch (error) {
        console.error('[web:listener-close]', { stack: error.stack });
      }
    }));
    await this.remote.clear();
    this.attempts.clear();
    console.info('[web:stopped]');
  }

  async close() {
    await this.stop();
    this.accountStore?.close();
    this.accountStore = null;
  }

  // Host checks resist DNS rebinding; plugin ports never expose the workspace API.
  context(request, port, serviceId = 'workspace') {
    const grant = this.transport.requests.get(request);
    this.transport.assertActive(grant);
    if (grant) {
      const origin = grant.origins[serviceId];
      const authority = request.httpVersionMajor === 2 ? request.headers[':authority'] : request.headers.host;
      // HTTP/2 uses :authority; a conflicting legacy Host must not bypass the fixed service mapping.
      if (!origin || authority !== new URL(origin).host || request.headers.host && request.headers.host !== authority) {
        throw httpError(403, '访问地址不允许');
      }
      return origin;
    }
    let url;
    try {
      url = new URL(`https://${request.headers.host}`);
    } catch {
      throw httpError(403, '访问地址无效');
    }
    if (!addresses().includes(url.hostname) || Number(url.port || 443) !== port || url.username || url.password) {
      throw httpError(403, '访问地址不允许');
    }
    return url.origin;
  }

  authenticate(request) {
    const token = tokenFor(request);
    this.transport.authenticate(request, token);
    const session = this.accountStore.session(token) || this.transport.session(token);
    if (!session) {
      throw httpError(401, '请登录');
    }
    return { ...session, token, csrf: this.csrfFor(token) };
  }

  async handle(request, response) {
    const origin = this.context(request, this.port);
    const grant = this.transport.requests.get(request);
    const path = new URL(request.url, origin).pathname;
    response.setHeader('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src ${grant ? Object.entries(grant.origins).filter(([id]) => id !== 'workspace').map(([, value]) => value).join(' ') || "'none'" : `https://${new URL(origin).hostname}:*`}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    if (request.method !== 'GET' && request.headers.origin !== origin) {
      throw httpError(403, '拒绝跨来源请求');
    }
    if (path === '/api/login' && request.method === 'POST') {
      return this.login(request, response);
    }
    if (path === '/api/session' && request.method === 'GET') {
      if (grant && !tokenFor(request)) {
        // Do not mint credentials for a cross-site navigation or an attacker-selected Origin.
        if (request.headers.origin && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
          throw httpError(403, '拒绝跨来源请求');
        }
        const token = this.transport.authorizeDevice(request);
        request.headers.cookie = `${cookieName}=${token}`;
        response.setHeader('set-cookie', `${cookieName}=${token}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`);
      }
      const session = this.authenticate(request);
      return json(response, { username: session.username, csrf: session.csrf });
    }
    if (path.startsWith('/api/') || path.startsWith('/plugin-icons/')) {
      const session = this.authenticate(request);
      if (request.method !== 'GET' && request.headers['x-deckpg-csrf'] !== session.csrf) {
        throw httpError(403, '请求验证已失效');
      }
      if (path === '/api/logout' && request.method === 'POST') {
        this.transport.logout(request, session.token);
        this.accountStore.revoke(session.token);
        this.revalidateClients();
        response.setHeader('set-cookie', `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
        return json(response, {});
      }
      if (path === '/api/events' && request.method === 'GET') {
        return this.subscribe(request, response, session);
      }
      if (path === '/api/rpc' && request.method === 'POST') {
        const { method, args } = await jsonBody(request);
        // Account changes also revoke requests parked while their body is being received.
        this.authenticate(request);
        if ((!allowed.has(method) && !Object.hasOwn(this.remote.handlers, method)) || !Array.isArray(args)) {
          throw httpError(403, '网页不支持此操作，请在桌面端操作');
        }
        try {
          let value = Object.hasOwn(this.remote.handlers, method)
            ? await this.remote.invoke(method, args, session) : await this.handlers[method](...args);
          if (method === 'plugins.list') {
            value = await Promise.all(value.map(record => this.webPlugin(record, grant)));
          }
          this.authenticate(request);
          return json(response, { ok: true, value });
        } catch (error) {
          console.error('[web:rpc-failed]', { method, username: session.username, stack: error.stack });
          return json(response, { ok: false, error: { code: error.code, message: error.message, details: error.details } });
        }
      }
      if (path.startsWith('/plugin-icons/') && request.method === 'GET') {
        return this.remote.icon(response, path.slice('/plugin-icons/'.length));
      }
      if (await this.remote.route(request, response, path, session)) {
        return;
      }
      throw httpError(404, '接口不存在');
    }
    if (request.method !== 'GET' || !['/', '/index.html', '/app.js', '/app.css'].includes(path)) {
      throw httpError(404, '页面不存在');
    }
    if (grant && ['/', '/index.html'].includes(path)) {
      const html = await shellDocument(join(this.root, 'web/dist'), new URL(request.url, origin).searchParams.get('deskShell'));
      this.transport.assertActive(grant);
      if (html) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
        return response.end(html);
      }
    }
    return staticFile(response, join(this.root, 'web/dist'), path === '/' ? '/index.html' : path);
  }

  async login(request, response) {
    const address = this.transport.requests.get(request)?.deviceId || request.socket.remoteAddress;
    const now = Date.now();
    for (const [key, attempt] of this.attempts) {
      if (attempt.until <= now) {
        this.attempts.delete(key);
      }
    }
    if (this.attempts.size >= 1024 && !this.attempts.has(address)) {
      throw httpError(429, '请稍后重试');
    }
    const attempt = this.attempts.get(address) || { count: 0, until: now + 60_000 };
    if (++attempt.count > 10) {
      throw httpError(429, '登录尝试过多，请稍后重试');
    }
    this.attempts.set(address, attempt);
    const { username, password } = await jsonBody(request);
    if (typeof username !== 'string' || username.length > 64 || typeof password !== 'string' || password.length > 256) {
      throw httpError(400, '账号或密码无效');
    }
    const generation = this.generation;
    this.transport.assertActive(this.transport.requests.get(request));
    const session = await this.accountStore.login(username, password);
    if (!session || !this.server || generation !== this.generation) {
      if (session) {
        this.accountStore.revoke(session.token);
      }
      throw httpError(401, '账号或密码错误');
    }
    try {
      this.transport.bind(request, session.token);
    } catch (error) {
      this.accountStore.revoke(session.token);
      throw error;
    }
    response.setHeader('set-cookie', `${cookieName}=${session.token}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`);
    console.info('[web:login]', { username, address });
    json(response, { username, csrf: session.csrf });
  }

  subscribe(request, response, session) {
    if (this.clients.size >= 32) {
      throw httpError(429, '网页连接过多');
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.write(': connected\n\n');
    const client = { response, token: session.token };
    this.clients.add(client);
    request.on('close', () => this.clients.delete(client));
  }

  revalidateClients() {
    for (const client of this.clients) {
      if (!this.accountStore.session(client.token) && !this.transport.session(client.token)) {
        client.response.end('event: revoked\ndata: {}\n\n');
        this.clients.delete(client);
      } else {
        client.response.write(': heartbeat\n\n');
      }
    }
  }

  emit(channel, value) {
    const data = JSON.stringify({ channel, value });
    if (Buffer.byteLength(data) > 1024 * 1024) {
      console.error('[web:event-too-large]', { channel });
      return;
    }
    for (const client of this.clients) {
      if ((!this.accountStore.session(client.token) && !this.transport.session(client.token)) || client.response.writableLength > 1024 * 1024) {
        client.response.end('event: revoked\ndata: {}\n\n');
        this.clients.delete(client);
      } else {
        client.response.write(`data: ${data}\n\n`);
      }
    }
  }

  // Add Web-only resource paths without changing the plugin's declared views or message origin.
  async webPlugin(record, grant) {
    if (record.state !== 'enabled') {
      return { ...record, webPort: null };
    }
    const input = await pluginInputResources(join(this.root, 'web/dist'));
    const resources = await pluginResources(await this.storage.packageDirectory(record.id), input.version);
    return { ...record,
      views: record.views?.map(view => ({ ...view, entry: resources.entry(view.entry) })),
      settings: record.settings?.entry ? { ...record.settings, entry: resources.entry(record.settings.entry) } : record.settings,
      webPort: grant ? Number(new URL(grant.origins[`plugin:${record.id}`] || 'https://127.0.0.1').port) || null
        : await this.pluginPort(record.id) };
  }

  async pluginResource(request, response, id, path) {
    const inputDirectory = join(this.root, 'web/dist');
    const input = await pluginInputResources(inputDirectory);
    const validate = () => {
      this.authenticate(request);
      this.plugins.assertEnabled(id);
    };
    if (path.startsWith('/_web_input/')) {
      return staticFile(response, inputDirectory, input.resolve(path), { cache: true, validate });
    }
    const directory = await this.storage.packageDirectory(id);
    const resource = (await pluginResources(directory, input.version)).resolve(path);
    return staticFile(response, directory, resource.pathname, { cache: resource.cache, validate, transform: input.transform });
  }

  async pluginPort(id) {
    if (!this.frames.has(id)) {
      // Coalesce concurrent list requests so a plugin never gets duplicate listeners.
      const generation = this.generation;
      const pending = listener(this.tls, async (request, response) => {
        const port = (await pending).port;
        const origin = this.context(request, port);
        this.authenticate(request);
        this.plugins.assertEnabled(id);
        const host = new URL(origin).hostname;
        response.setHeader('content-security-policy', `frame-ancestors https://${host}:${this.port}; object-src 'none'; base-uri 'none'`);
        const path = new URL(request.url, origin).pathname;
        if (request.method !== 'GET' || path.startsWith('/api/')) {
          throw httpError(404, '接口不存在');
        }
        return this.pluginResource(request, response, id, path);
      }, 0);
      this.frames.set(id, pending);
      try {
        const server = await pending;
        if (!this.server || generation !== this.generation) {
          await server.close();
          throw httpError(503, '网页端已关闭');
        }
        this.frames.set(id, server);
      } catch (error) {
        if (this.frames.get(id) === pending) {
          this.frames.delete(id);
        }
        throw error;
      }
    }
    return (await this.frames.get(id)).port;
  }
}
