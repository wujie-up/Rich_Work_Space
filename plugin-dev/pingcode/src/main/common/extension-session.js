import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { validWorkItemQuery } from '../../shared/query-policy.js';

const fail = (code, message) => Object.assign(Error(message), { code });
const messages = {
  LOGIN_REQUIRED: '请在浏览器标签页完成 PingCode 登录后检查登录状态',
  TAB_UNAVAILABLE: 'PingCode 标签页不可用，请重新打开后查询',
  WEB_REQUEST_FAILED: '网页请求失败，请检查浏览器登录和网络',
  CANCELLED: '查询已取消', TIMEOUT: '浏览器请求超时，请重试'
};
const pairingPage = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<title>连接 PingCode 扩展</title><style>body{font:16px system-ui;max-width:620px;margin:80px auto;padding:24px;color:#333;background:#fafafa}p{line-height:1.8}button{padding:12px;border:1px solid #bbb;border-radius:8px;background:transparent;color:inherit;cursor:pointer}svg{width:24px;height:24px}button:focus-visible{outline:2px solid currentColor}</style>
<h1>连接浏览器与工作台</h1><p>请先在 Chrome 扩展管理页启用开发者模式，加载交付的 pingcode-browser-extension 文件夹。安装完成后刷新此页。</p>
<p id="state" role="status">正在等待 PingCode 扩展。如果未显示连接按钮，请检查扩展是否已安装并启用。</p>
<div id="extension-pairing"></div><p>连接成功后会打开或定位当前浏览器的 PingCode 标签页。插件仅通过此扩展读取任务，不复制浏览器 Cookie。</p></html>`;

export class ExtensionSession {
  constructor({ root, timeoutMs = 24000, heartbeatMs = 20000 }) {
    Object.assign(this, { root, timeoutMs, heartbeatMs });
    this.state = 'closed';
    this.epoch = randomUUID();
    this.pending = new Map();
  }

  status() {
    return { state: this.state, epoch: this.epoch, error: this.error || null,
      transport: 'extension', extensionConnected: this.socket?.readyState === WebSocket.OPEN, supportsQuery: Boolean(this.supportsQuery) };
  }

  rotate() {
    this.epoch = randomUUID();
  }

  async start(site) {
    const url = new URL(site);
    if (url.protocol !== 'https:' || url.origin !== site || !url.hostname.endsWith('.pingcode.com')) {
      throw fail('INVALID_CONFIG', '浏览器扩展目前仅支持 HTTPS PingCode 公有云站点');
    }
    if (this.starting) {
      await this.starting;
    }
    if (this.server) {
      if (this.site !== site) {
        this.site = site;
        this.state = this.socket ? 'needs-login' : 'closed';
        this.cancelPending();
        this.rotate();
      }
      return;
    }
    this.site = site;
    this.starting = this.listen().finally(() => { this.starting = null; });
    await this.starting;
  }

  async listen() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let saved;
    try {
      saved = JSON.parse(await readFile(join(this.root, 'browser-bridge.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw fail('BRIDGE_CONFIG', '无法读取浏览器扩展连接配置');
      }
    }
    if (saved && (!Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535
      || !/^[A-Za-z0-9_-]{43}$/.test(saved.token))) {
      throw fail('BRIDGE_CONFIG', '浏览器扩展连接配置无效');
    }
    this.token = saved?.token || randomBytes(32).toString('base64url');
    const server = createServer((request, response) => {
      if (request.headers.host !== this.host || request.method !== 'GET' || request.url !== '/pair') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(pairingPage);
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024,
      handleProtocols: () => 'pingcode-v1' });
    server.on('upgrade', (request, socket, head) => {
      const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
      const token = protocols[1] || '';
      const authorized = request.url === '/bridge' && request.headers.host === this.host
        && /^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin || '')
        && protocols.length === 2 && protocols[0] === 'pingcode-v1' && /^[A-Za-z0-9_-]{43}$/.test(token)
        && timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
      if (!authorized || this.socket) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      sockets.handleUpgrade(request, socket, head, client => this.attach(client));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(saved?.port || 0, '127.0.0.1', resolve);
      });
      this.server = server;
      this.sockets = sockets;
      this.host = `127.0.0.1:${server.address().port}`;
      await this.savePairing();
    } catch {
      server.close();
      sockets.close();
      throw fail('BRIDGE_START_FAILED', '无法启动本机浏览器连接，请关闭重复运行的 PingCode 插件后重试');
    }
  }

  async savePairing() {
    await writeFile(join(this.root, 'browser-bridge.json'), JSON.stringify({ port: Number(this.host.split(':')[1]), token: this.token }),
      { mode: 0o600 });
  }

  attach(socket) {
    this.socket = socket;
    this.supportsQuery = false;
    this.state = 'needs-login';
    this.error = null;
    this.rotate();
    let alive = true;
    const timer = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.send(JSON.stringify({ action: 'ping' }));
    }, this.heartbeatMs);
    timer.unref();
    socket.on('error', () => socket.terminate());
    socket.on('message', bytes => {
      let response;
      try { response = JSON.parse(bytes); } catch { socket.terminate(); return; }
      if (response.action === 'hello') {
        this.supportsQuery = response.protocol === 2;
        return;
      }
      if (response.action === 'pong') {
        alive = true;
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending || pending.socket !== socket) {
        return;
      }
      if (response.error) {
        const code = Object.hasOwn(messages, response.error.code) ? response.error.code : 'WEB_REQUEST_FAILED';
        pending.finish(fail(code, messages[code]));
      } else {
        pending.finish(null, response.result);
      }
    });
    socket.once('close', () => {
      clearInterval(timer);
      if (this.socket === socket) {
        this.socket = null;
        this.state = 'closed';
        this.error = null;
        this.cancelPending();
        this.rotate();
      }
    });
  }

  cancelPending() {
    for (const pending of [...this.pending.values()]) {
      pending.finish(fail('CANCELLED', '浏览器连接已更改，请重新查询'));
    }
  }

  command(action, values = {}, signal) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(fail('LOGIN_REQUIRED', '请先安装并连接 PingCode 浏览器扩展'));
    }
    if (signal?.aborted) {
      return Promise.reject(fail('CANCELLED', '查询已取消'));
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancelRemote = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: 'cancel', id }));
        }
      };
      const abort = () => { cancelRemote(); finish(fail('CANCELLED', '查询已取消')); };
      const timer = setTimeout(() => { cancelRemote(); finish(fail('TIMEOUT', messages.TIMEOUT)); }, this.timeoutMs);
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        if (error) { reject(error); } else { resolve(result); }
      };
      this.pending.set(id, { socket, finish });
      signal?.addEventListener('abort', abort, { once: true });
      socket.send(JSON.stringify({ id, action, site: this.site, ...values }), error => {
        if (error) { finish(fail('WEB_REQUEST_FAILED', messages.WEB_REQUEST_FAILED)); }
      });
    });
  }

  async open(site) {
    await this.start(site);
    if (!this.socket) {
      return { ...this.status(), pairingUrl: `http://${this.host}/pair#${this.token}` };
    }
    await this.command('open');
    return this.check();
  }

  async query(site, body, signal) {
    if (!validWorkItemQuery(body)) { throw fail('INVALID_ARGUMENT', '按月查询条件无效'); }
    if (this.socket?.readyState !== WebSocket.OPEN) { throw fail('LOGIN_REQUIRED', '请先连接 PingCode 浏览器扩展'); }
    if (!this.supportsQuery) {
      throw fail('EXTENSION_UPDATE_REQUIRED', '按月查询需要 0.4.0 浏览器扩展，请停用旧扩展并加载新版本后连接');
    }
    return this.read(site, '/api/agile/work-items', body, signal, true);
  }

  async read(site, path, params = {}, signal, query = false) {
    if (site !== this.site) {
      throw fail('SITE_CHANGED', '登录站点已更改，请重新连接浏览器');
    }
    if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(path)
      || !(path.startsWith('/api/agile/') || path === '/api/typhon/account/me') || (query && path !== '/api/agile/work-items')) {
      throw fail('INVALID_ARGUMENT', '网页读取请求无效');
    }
    const result = await this.command(query ? 'query' : 'read', { path, params }, signal);
    if (result?.status === 401 || result?.body?.code === 401 || result?.failure === 'site') {
      this.state = 'needs-login';
      this.rotate();
      throw fail('LOGIN_REQUIRED', messages.LOGIN_REQUIRED);
    }
    if (result?.status === 403) { throw fail('FORBIDDEN', '当前账号无权读取这些数据'); }
    if (result?.status === 429) { throw fail('RATE_LIMITED', '请求过于频繁，请稍后重试'); }
    if (result?.failure) { throw fail('WEB_REQUEST_FAILED', messages.WEB_REQUEST_FAILED); }
    if (result?.status !== 200 || ![0, 200].includes(result?.body?.code) || !result?.body?.data) {
      throw fail('WEB_RESPONSE_CHANGED', '网页接口响应不符合预期，请检查登录或插件更新');
    }
    return result.body.data;
  }

  async check() {
    if (!this.socket) {
      return this.status();
    }
    const epoch = this.epoch;
    try {
      const account = await this.read(this.site, '/api/typhon/account/me');
      if (this.epoch !== epoch) { return this.status(); }
      if (!account.me) {
        this.state = 'needs-login';
        this.rotate();
      } else {
        const accountId = account.me.uid || account.me.id || account.me._id;
        if (this.state !== 'connected' || !accountId || accountId !== this.accountId) {
          this.rotate();
        }
        this.accountId = accountId;
        this.state = 'connected';
      }
      this.error = null;
    } catch (error) {
      if (this.epoch !== epoch) { return this.status(); }
      this.state = error.code === 'LOGIN_REQUIRED' ? 'needs-login' : 'error';
      this.error = error.message;
    }
    return this.status();
  }

  async disconnect() {
    this.socket?.send(JSON.stringify({ action: 'unpair' }));
    this.socket?.terminate();
    this.socket = null;
    this.cancelPending();
    this.token = randomBytes(32).toString('base64url');
    if (this.server) { await this.savePairing(); }
    this.state = 'closed';
    this.error = null;
    this.rotate();
    return this.status();
  }

  async stop() {
    if (this.starting) { await this.starting.catch(() => {}); }
    this.cancelPending();
    this.socket?.terminate();
    this.socket = null;
    this.sockets?.close();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise(resolve => this.server.close(resolve));
    }
    this.server = null;
    this.sockets = null;
    this.state = 'closed';
    this.rotate();
  }
}
