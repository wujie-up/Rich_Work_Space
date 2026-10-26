import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as zlib from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CaptureLog, safeHeaders } from './capture-log.js';
export { CaptureLog } from './capture-log.js';

function forwardHeaders(headers) {
  const blocked = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of (headers.connection || '').split(',')) { blocked.add(name.trim().toLowerCase()); }
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

export class CaptureProxy {
  constructor({ root, upstream, proxyUrl, onEvent = () => {}, identity = {}, isRecording, paths }) {
    this.upstream = upstream;
    this.identity = identity;
    this.isRecording = isRecording;
    this.paths = paths || /^\/(responses(?:\/[a-zA-Z0-9_-]+)*|models)$/;
    this.proxyUrl = proxyUrl;
    this.log = new CaptureLog(root, onEvent);
    this.recording = true;
    this.sockets = new Set();
    this.requests = new Set();
    this.prefix = `/${randomBytes(32).toString('hex')}`;
  }

  async start() {
    await this.log.start();
    this.agent = this.proxyUrl ? new HttpsProxyAgent(this.proxyUrl) : undefined;
    this.server = http.createServer((req, res) => this.http(req, res));
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${this.server.address().port}${this.prefix}`;
  }

  target(req) {
    if (req.headers.origin) { throw Object.assign(Error('不允许浏览器跨域请求'), { status: 403 }); }
    if (!req.url.startsWith(`${this.prefix}/`) || req.url.includes('\\')) {
      throw Object.assign(Error('入口不存在'), { status: 404 });
    }
    const suffix = req.url.slice(this.prefix.length);
    const path = suffix.split('?')[0];
    if (!this.paths.test(path)) {
      throw Object.assign(Error('请求路径不支持'), { status: 404 });
    }
    return new URL(`${this.upstream.replace(/\/$/, '')}${suffix}`);
  }

  record(id, type, value) {
    if (this.recording && (!this.isRecording || this.isRecording())) { this.log.write(id, type, { ...this.identity, ...value }); }
  }

  body(id, direction, encoding) {
    const decoder = new TextDecoder();
    const factories = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress, zstd: zlib.createZstdDecompress };
    const compressed = encoding && encoding !== 'identity';
    const transform = compressed && factories[encoding]?.();
    const decoded = chunk => this.record(id, `${direction}.text`, { text: decoder.decode(chunk, { stream: true }) });
    if (transform) {
      transform.on('data', decoded);
      transform.on('error', () => this.record(id, `${direction}.decode-error`, { encoding }));
      transform.on('end', () => this.record(id, `${direction}.text`, { text: decoder.decode() }));
    }
    return {
      write: chunk => {
        this.record(id, `${direction}.body`, { base64: chunk.toString('base64') });
        if (transform) { transform.write(chunk); }
        else if (!compressed) { decoded(chunk); }
      },
      end: () => {
        if (transform) { transform.end(); }
        else if (!compressed) { this.record(id, `${direction}.text`, { text: decoder.decode() }); }
        else { this.record(id, `${direction}.encoded`, { encoding }); }
      }
    };
  }

  http(req, res) {
    let target;
    try { target = this.target(req); }
    catch (error) { res.writeHead(error.status); res.end(error.message); return; }
    const id = randomUUID();
    this.record(id, 'request.start', { method: req.method, url: `${target.origin}${target.pathname}`, headers: safeHeaders(req.headers) });
    const requestBody = this.body(id, 'request', req.headers['content-encoding']);
    const outgoing = (target.protocol === 'https:' ? https : http).request(target, {
      method: req.method, headers: forwardHeaders(req.headers), agent: target.protocol === 'https:' ? this.agent : undefined
    });
    this.requests.add(outgoing);
    outgoing.on('close', () => this.requests.delete(outgoing));
    outgoing.on('error', error => {
      this.record(id, 'response.error', { code: error.code || 'UPSTREAM_ERROR' });
      if (!res.headersSent) { res.writeHead(502); res.end('Agent 上游连接失败'); }
      else { res.destroy(); }
    });
    outgoing.on('response', upstream => {
      this.record(id, 'response.start', { status: upstream.statusCode, headers: safeHeaders(upstream.headers) });
      res.writeHead(upstream.statusCode, forwardHeaders(upstream.headers));
      const body = this.body(id, 'response', upstream.headers['content-encoding']);
      upstream.on('data', chunk => body.write(chunk));
      upstream.on('end', () => { body.end(); this.record(id, 'response.end'); });
      upstream.on('error', error => {
        this.record(id, 'response.error', { code: error.code || 'STREAM_ERROR' });
        res.destroy();
      });
      upstream.pipe(res);
    });
    req.on('data', chunk => requestBody.write(chunk));
    req.on('end', () => { requestBody.end(); this.record(id, 'request.end'); });
    req.on('error', () => outgoing.destroy());
    res.on('close', () => {
      if (!res.writableFinished) { this.record(id, 'response.cancelled'); outgoing.destroy(); }
    });
    req.pipe(outgoing);
  }

  upgrade(req, socket, head) {
    let target;
    try { target = this.target(req); }
    catch (error) { socket.end(`HTTP/1.1 ${error.status} Rejected\r\nConnection: close\r\n\r\n`); return; }
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const id = randomUUID();
    this.record(id, 'request.start', { method: 'WEBSOCKET', url: `${target.origin}${target.pathname}`, headers: safeHeaders(req.headers) });
    const headers = forwardHeaders(req.headers);
    for (const key of Object.keys(headers)) {
      if (key.startsWith('sec-websocket-')) { delete headers[key]; }
    }
    const upstream = new WebSocket(target, { headers, agent: target.protocol === 'wss:' ? this.agent : undefined,
      perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 15000 });
    this.requests.add(upstream);
    let client;
    let rejectedHandshake = false;
    upstream.on('upgrade', response => this.record(id, 'response.start', { status: response.statusCode, headers: safeHeaders(response.headers) }));
    upstream.on('open', () => {
      if (socket.destroyed) { upstream.terminate(); return; }
      this.ws.handleUpgrade(req, socket, head, connected => {
        client = connected;
        client.on('message', (data, binary) => {
          this.record(id, 'request.message', binary ? { base64: data.toString('base64') } : { text: data.toString() });
          if (upstream.readyState === WebSocket.OPEN) { upstream.send(data, { binary }); }
        });
        client.on('error', () => upstream.terminate());
        client.on('close', (code, reason) => {
          if (upstream.readyState === WebSocket.OPEN) { upstream.close(code === 1005 || code === 1006 ? 1000 : code, reason); }
        });
      });
    });
    upstream.on('message', (data, binary) => {
      this.record(id, 'response.message', binary ? { base64: data.toString('base64') } : { text: data.toString() });
      if (client?.readyState === WebSocket.OPEN) { client.send(data, { binary }); }
    });
    upstream.on('unexpected-response', (_request, response) => {
      rejectedHandshake = true;
      this.record(id, 'response.start', { status: response.statusCode, headers: safeHeaders(response.headers) });
      const result = new http.ServerResponse(req);
      result.assignSocket(socket);
      result.shouldKeepAlive = false;
      result.writeHead(response.statusCode, forwardHeaders(response.headers));
      const body = this.body(id, 'response', response.headers['content-encoding']);
      response.on('data', chunk => body.write(chunk));
      response.on('end', () => {
        body.end();
        this.record(id, 'response.end');
        upstream.terminate();
      });
      response.on('error', () => { result.destroy(); upstream.terminate(); });
      response.pipe(result);
    });
    upstream.on('error', error => {
      this.record(id, 'response.error', { code: error.code || 'WEBSOCKET_ERROR' });
      if (client) { client.terminate(); } else if (!rejectedHandshake) { socket.destroy(); }
    });
    upstream.on('close', (code, reason) => {
      this.requests.delete(upstream);
      this.record(id, 'response.end', { code });
      if (client?.readyState === WebSocket.OPEN) { client.close(code === 1005 || code === 1006 ? 1000 : code, reason); }
    });
    socket.on('error', () => upstream.terminate());
    socket.on('close', () => upstream.terminate());
  }

  async close() {
    for (const request of this.requests) {
      if (request.terminate) { request.terminate(); } else { request.destroy(); }
    }
    for (const socket of this.sockets) { socket.destroy(); }
    if (this.server?.listening) { await new Promise(resolve => this.server.close(resolve)); }
    this.ws?.close();
    this.agent?.destroy();
    await this.log.flush();
  }
}
