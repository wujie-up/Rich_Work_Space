import { createServer } from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash, X509Certificate, timingSafeEqual } from 'node:crypto';
import { listener, httpError } from './http.js';

const digest = token => createHash('sha256').update(token).digest('hex');
const invalid = () => httpError(403, '服务传输授权无效');

// Neither a remote address nor an HTTP header can select a receiving context.
export class ServiceTransport {
  constructor(workspace) {
    this.workspace = workspace;
    this.grants = new Map();
    this.sessions = new Map();
    this.requests = new WeakMap();
  }

  assertActive(grant) {
    if (grant && (grant.closed || grant.owner.closed || !this.workspace.server || grant.generation !== this.workspace.generation)) {
      throw invalid();
    }
  }

  async describe() {
    if (!this.workspace.server) {
      throw httpError(503, '请先在本机开启工作台网页服务');
    }
    const services = ['workspace', ...(await this.workspace.plugins.list()).filter(item => item.state === 'enabled')
      .map(item => `plugin:${item.id}`)];
    const cert = new X509Certificate(this.workspace.tls.cert);
    return { services, certificate: cert.toString(), certificateHash: createHash('sha256').update(cert.raw).digest('hex') };
  }

  async request(owner, action, input) {
    if (action === 'describe') { return this.describe(); }
    if (action === 'open') { return this.open(owner, input); }
    if (action === 'revoke') { return this.revoke(owner, input); }
    throw invalid();
  }

  async open(owner, input) {
    const generation = this.workspace.generation;
    const description = await this.describe();
    const { deviceId, origins } = input || {};
    if (!input || Object.keys(input).some(key => !['deviceId', 'origins'].includes(key))
      || typeof deviceId !== 'string' || !deviceId || deviceId.length > 128 || !origins || Array.isArray(origins)
      || typeof origins !== 'object' || !origins.workspace || Object.keys(origins).length > 128
      || this.grants.size >= 32) { throw invalid(); }
    const ports = new Set();
    for (const [id, origin] of Object.entries(origins)) {
      let url;
      try { url = new URL(origin); } catch { throw invalid(); }
      const port = Number(url.port);
      if (!description.services.includes(id) || url.protocol !== 'https:' || url.hostname !== '127.0.0.1'
        || url.origin !== origin || port < 1024 || ports.has(port)) { throw invalid(); }
      ports.add(port);
    }
    const grant = { owner, deviceId, generation, grantId: randomUUID(), origins: { ...origins }, sockets: new Set(),
      receivers: new Map(), closed: false, capability: randomBytes(32).toString('hex') };
    // Publish before any await so Web shutdown also owns partially constructed grants.
    this.grants.set(grant.grantId, grant);
    try {
      grant.directory = await mkdtemp(join(tmpdir(), 'wd-t-'));
      await chmod(grant.directory, 0o700);
      for (const serviceId of Object.keys(origins)) {
        this.assertActive(grant);
        const receiver = await listener(this.workspace.tls, (request, response) => {
          this.assertActive(grant);
          this.requests.set(request, grant);
          if (serviceId === 'workspace') { return this.workspace.handle(request, response); }
          return this.plugin(grant, serviceId, request, response);
        }, null);
        grant.receivers.set(serviceId, receiver);
      }
      this.assertActive(grant);
      grant.path = join(grant.directory, 'broker');
      grant.broker = createServer(socket => this.receive(grant, socket));
      grant.broker.on('error', error => {
        console.error('[web:transport-broker]', { grantId: grant.grantId, deviceId, stack: error.stack });
        this.close(grant).catch(failure => console.error('[web:transport-close]', { stack: failure.stack }));
      });
      await new Promise((resolve, reject) => {
        grant.broker.once('error', reject);
        grant.broker.listen(grant.path, () => { grant.broker.removeListener('error', reject); resolve(); });
      });
      await chmod(grant.path, 0o600);
      this.assertActive(grant);
      console.info('[web:transport-open]', { pluginId: owner.id, deviceId, grantId: grant.grantId });
      return { ...description, origins: grant.origins, grantId: grant.grantId, path: grant.path, capability: grant.capability };
    } catch (error) {
      await this.close(grant);
      throw error;
    }
  }

  receive(grant, socket) {
    if (grant.closed || grant.sockets.size >= 32) { socket.destroy(); return; }
    grant.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => grant.sockets.delete(socket));
    socket.setTimeout(3000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    const preface = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0 && buffer.length <= 4096) { return; }
      try {
        this.assertActive(grant);
        if (end < 0 || end > 4096 || buffer.length !== end + 1) { throw invalid(); }
        const input = JSON.parse(buffer.subarray(0, end).toString());
        const supplied = Buffer.from(input.capability || '', 'utf8');
        const expected = Buffer.from(grant.capability);
        if (Object.keys(input).some(key => !['capability', 'serviceId'].includes(key)) || supplied.length !== expected.length
          || !timingSafeEqual(supplied, expected) || !grant.receivers.has(input.serviceId)) { throw invalid(); }
        const receiver = grant.receivers.get(input.serviceId);
        socket.pause();
        socket.removeListener('data', preface);
        socket.setTimeout(0);
        socket.write('OK\n');
        receiver.accept(socket);
        socket.resume();
      } catch {
        socket.destroy();
      }
    };
    socket.on('data', preface);
  }

  async plugin(grant, serviceId, request, response) {
    const id = serviceId.slice('plugin:'.length);
    const origin = this.workspace.context(request, 0, serviceId);
    this.workspace.authenticate(request);
    this.workspace.plugins.assertEnabled(id);
    response.setHeader('content-security-policy', `frame-ancestors ${grant.origins.workspace}; object-src 'none'; base-uri 'none'`);
    const path = new URL(request.url, origin).pathname;
    if (request.method !== 'GET' || path.startsWith('/api/')) { throw httpError(404, '接口不存在'); }
    return this.workspace.pluginResource(request, response, id, path);
  }

  authenticate(request, token) {
    const grant = this.requests.get(request);
    this.assertActive(grant);
    if (this.sessions.get(digest(token)) !== grant) { throw httpError(401, '请登录'); }
    return grant;
  }

  bind(request, token) {
    const grant = this.requests.get(request);
    this.assertActive(grant);
    if (grant) { this.sessions.set(digest(token), grant); }
  }

  // Only a receiver created by the trusted transport owner can exchange its grant for Web access.
  authorizeDevice(request) {
    const grant = this.requests.get(request);
    this.assertActive(grant);
    if (!grant || grant.loggedOut) { throw invalid(); }
    if (grant.deviceSession) { this.sessions.delete(grant.deviceSession.digest); }
    const token = randomBytes(32).toString('hex');
    grant.deviceSession = { digest: digest(token), expires: Date.now() + 8 * 3600_000 };
    this.bind(request, token);
    console.info('[web:device-session]', { deviceId: grant.deviceId, grantId: grant.grantId });
    return token;
  }

  session(token) {
    const grant = this.sessions.get(digest(token));
    if (!grant || grant.closed || grant.owner.closed || !this.workspace.server
      || grant.generation !== this.workspace.generation || grant.deviceSession?.digest !== digest(token)
      || grant.deviceSession.expires <= Date.now()) { return null; }
    return { username: '已绑定设备', expires: grant.deviceSession.expires };
  }

  logout(request, token) {
    const grant = this.requests.get(request);
    if (grant?.deviceSession?.digest === digest(token)) {
      grant.loggedOut = true;
      this.sessions.delete(digest(token));
    }
  }

  async revoke(owner, grantId) {
    const grant = this.grants.get(grantId);
    if (grant && grant.owner !== owner) { throw invalid(); }
    if (grant) { await this.close(grant); }
  }

  async close(grant) {
    grant.closed = true;
    // Delete database sessions first: forgetting a binding must never turn it into a LAN session.
    for (const [hash, bound] of this.sessions) {
      if (bound === grant) {
        this.workspace.accountStore.revokeDigest(hash);
        this.sessions.delete(hash);
      }
    }
    this.workspace.revalidateClients();
    for (const socket of grant.sockets) { socket.destroy(); }
    if (grant.broker) { grant.broker.close(); }
    await Promise.all([...grant.receivers.values()].map(receiver => receiver.close()));
    grant.receivers.clear();
    if (grant.directory) { await rm(grant.directory, { recursive: true, force: true }); }
    this.grants.delete(grant.grantId);
    console.info('[web:transport-closed]', { pluginId: grant.owner.id, deviceId: grant.deviceId, grantId: grant.grantId });
  }

  async closeOwner(owner) {
    await Promise.all([...this.grants.values()].filter(grant => grant.owner === owner).map(grant => this.close(grant)));
  }

  async closeAll() {
    await Promise.all([...this.grants.values()].map(grant => this.close(grant)));
  }
}
