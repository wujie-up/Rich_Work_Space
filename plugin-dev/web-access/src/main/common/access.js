import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { Pairing } from './pairing.js';
import { ALPN, exact, denied, validateHello, validateService, readFrame, writeFrame, within, StreamBudget } from './protocol.js';
import { forward } from './forward.js';

export class AccessService {
  constructor({ context, platform }) {
    Object.assign(this, { context, platform });
    this.connections = new Map();
    this.waiters = new Map();
    this.budget = new StreamBudget();
    this.generation = 0;
    this.running = false;
    this.traffic = new Map();
    this.totalTraffic = { at: 0, size: 0 };
    this.diagnostics = [];
  }

  status() {
    const now = Date.now();
    return { running: this.running, hostId: this.endpoint?.id().toString(),
      devices: [...(this.pairs?.devices.values() || [])],
      pending: [...(this.pairs?.pending.values() || [])].filter(entry => entry.expiresAt > now),
      connections: [...this.connections.values()].filter(state => state.grant).map(state => {
        const path = state.connection.paths().find(value => value.isSelected);
        return { connectionId: state.connectionId, deviceId: state.deviceId,
          path: path?.isRelay ? 'relay' : path?.isIp ? 'direct' : 'connecting', streams: state.streams };
      }) };
  }

  async start() {
    if (this.running) { return this.status(); }
    const generation = this.generation;
    await this.context.host.transport.describe();
    this.engine = await this.platform.loadEngine();
    const key = `plugin-data/${this.context.pluginId}/identity.json`;
    let identity = await this.context.storage.readJson(key);
    if (!identity) {
      identity = { secret: randomBytes(32).toString('hex') };
      await this.context.storage.writeJson(key, identity);
    }
    if (!/^[a-f0-9]{64}$/.test(identity.secret)) { throw Error('插件身份文件无效，请恢复备份'); }
    const directory = this.context.storage.pluginDir(this.context.pluginId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await chmod(await this.context.storage.path(key), 0o600);
    // Keep the approved fallback reachable; assistants attempt direct transport before enabling relay data.
    const endpoint = await this.engine.Endpoint.bind(
      { secretKey: [...Buffer.from(identity.secret, 'hex')], alpns: [[...Buffer.from(ALPN)]] },
      this.engine.RelayMode.customFromUrls(['https://usw1-1.relay.n0.iroh.link./']));
    if (generation !== this.generation) { await endpoint.close(); throw Error('访问已停止'); }
    this.endpoint = endpoint;
    try {
      await this.platform.ready?.(endpoint);
      const devicesKey = `plugin-data/${this.context.pluginId}/devices.json`;
      this.pairs = new Pairing({ hostId: endpoint.id().toString(), devices: await this.context.storage.readJson(devicesKey, []),
        persist: devices => this.context.storage.writeJson(devicesKey, devices), failClosed: () => this.stop(),
        disconnect: deviceId => this.disconnect(deviceId) });
      if (generation !== this.generation) { throw Error('访问已停止'); }
      this.running = true;
      this.accept(endpoint, generation).catch(error => {
        if (generation !== this.generation) { return; }
        console.error('[web-access:accept]', { pluginId: this.context.pluginId, stack: error.stack });
        this.stop().catch(failure => console.error('[web-access:stop]', { stack: failure.stack }));
      });
      console.info('[web-access:started]', { pluginId: this.context.pluginId, hostId: endpoint.id().toString(), policy: 'direct-first-us-fallback' });
      return this.status();
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }

  createInvitation() {
    if (!this.running) { throw Error('请先开启访问'); }
    return this.pairs.create(this.engine.EndpointTicket.fromAddr(this.endpoint.addr()).toString());
  }

  async confirm(requestId) {
    try {
      const device = await this.pairs.confirm(requestId);
      this.waiters.get(requestId)?.(true);
      console.info('[web-access:paired]', { pluginId: this.context.pluginId, deviceId: device.deviceId });
    } catch (error) {
      console.error('[web-access:pair-failed]', { pluginId: this.context.pluginId, requestId, stack: error.stack });
      throw error;
    }
  }

  async revoke(deviceId) {
    try {
      await this.pairs.revoke(deviceId);
      console.info('[web-access:revoked]', { pluginId: this.context.pluginId, deviceId });
    } catch (error) {
      console.error('[web-access:revoke-failed]', { pluginId: this.context.pluginId, deviceId, stack: error.stack });
      throw error;
    }
  }

  async accept(endpoint, generation) {
    while (this.running && generation === this.generation) {
      const incoming = await endpoint.acceptNext();
      if (!incoming) { break; }
      if (!this.running || generation !== this.generation) { await incoming.refuse(); break; }
      if (this.connections.size >= 32) { await incoming.refuse(); continue; }
      const state = { connectionId: randomUUID(), streams: 0, sockets: new Set(), generation };
      this.connections.set(state.connectionId, state);
      this.serve(incoming, state).catch(error => {
        if (this.running && !state.closing) {
          console.error('[web-access:connection]', { pluginId: this.context.pluginId, deviceId: state.deviceId,
            connectionId: state.connectionId, stack: error.stack });
        }
      }).finally(() => this.closeConnection(state)).catch(error => {
        console.error('[web-access:connection-cleanup]', { connectionId: state.connectionId, stack: error.stack });
        if (generation !== this.generation) { return; }
        this.stop().catch(failure => console.error('[web-access:stop]', { stack: failure.stack }));
      });
    }
  }

  check(state) {
    if (!this.running || state.closing || state.generation !== this.generation
      || !this.pairs.approved(state.deviceId)) { throw denied(); }
  }

  // Keep host-side evidence when the desktop has no console; never persist protocol frames or Web data.
  async diagnose(state, stage) {
    try {
      const stats = state.connection?.stats();
      const path = state.connection?.paths().find(value => value.isSelected);
      this.diagnostics.push({ at: Date.now(), connectionId: state.connectionId, deviceId: state.deviceId, stage,
        tx: stats?.udpTxBytes, rx: stats?.udpRxBytes, lost: stats?.lostPackets, rtt: path?.rttMs,
        path: path?.isRelay ? 'relay' : path?.isIp ? 'direct' : 'connecting' });
      this.diagnostics.splice(0, Math.max(0, this.diagnostics.length - 128));
      await this.context.storage.writeJson(`plugin-data/${this.context.pluginId}/connection-diagnostics.json`, this.diagnostics);
    } catch (error) {
      console.error('[web-access:diagnostics]', { pluginId: this.context.pluginId, connectionId: state.connectionId, stack: error.stack });
    }
  }

  async serve(incoming, state) {
    const accepting = await within(incoming.accept(), 10000);
    state.connection = await within(accepting.connect(), 10000);
    state.deviceId = state.connection.remoteId().toString();
    void this.diagnose(state, 'peer-accepted');
    let samples = 0;
    state.diagnosticTimer = setInterval(() => {
      void this.diagnose(state, 'transport');
      if (++samples >= 12) { clearInterval(state.diagnosticTimer); }
    }, 5000);
    state.diagnosticTimer.unref();
    state.connection.setMaxConcurrentBiStreams(32n);
    state.connection.setMaxConcurrentUniStreams(0n);
    state.connection.setReceiveWindow(2n * 1024n * 1024n);
    const control = await within(state.connection.acceptBi(), 10000);
    validateHello(await within(readFrame(control.recv), 10000));
    void this.diagnose(state, 'hello-received');
    const nonce = randomBytes(32).toString('hex');
    await writeFrame(control.send, { type: 'challenge', nonce, hostId: this.endpoint.id().toString(),
      services: this.pairs.approved(state.deviceId) ? (await this.context.host.transport.describe()).services : [] });
    void this.diagnose(state, 'challenge-written');
    const request = await within(readFrame(control.recv), 10000);
    void this.diagnose(state, 'request-received');
    if (request.type === 'pair') {
      if ([...this.connections.values()].filter(value => !value.grant).length > 8) { throw denied(); }
      const pending = this.pairs.request(request, state.deviceId, nonce);
      const decision = new Promise(resolve => this.waiters.set(pending.requestId, resolve));
      try {
        await writeFrame(control.send, { type: 'pending', requestId: pending.requestId, fingerprint: pending.fingerprint });
        if (!await within(decision, Math.max(1, pending.expiresAt - Date.now()))) { throw denied(); }
        this.check(state);
        await writeFrame(control.send, { type: 'paired' });
        await control.send.finish();
      } finally {
        this.waiters.delete(pending.requestId);
        this.pairs.pending.delete(pending.requestId);
      }
      return;
    }
    exact(request, ['type', 'origins']);
    if (request.type !== 'connect') { throw denied(); }
    this.check(state);
    void this.diagnose(state, 'grant-requested');
    state.grant = await this.context.host.transport.open({ deviceId: state.deviceId, origins: request.origins });
    void this.diagnose(state, 'grant-issued');
    this.check(state);
    const { certificate, certificateHash, services } = state.grant;
    await writeFrame(control.send, { type: 'ready', certificate, certificateHash, services });
    await control.send.finish();
    void this.diagnose(state, 'ready-written');
    console.info('[web-access:connected]', { pluginId: this.context.pluginId, deviceId: state.deviceId, connectionId: state.connectionId });
    while (true) {
      const stream = await state.connection.acceptBi();
      this.check(state);
      const release = this.budget.acquire(state.deviceId);
      state.streams++;
      this.stream(state, stream).catch(error => {
        if (!state.closing) {
          console.error('[web-access:stream]', { deviceId: state.deviceId, connectionId: state.connectionId, stack: error.stack });
          state.connection.close(1n, []);
        }
      }).finally(() => { state.streams--; release(); });
    }
  }

  async stream(state, stream) {
    const serviceId = validateService(await within(readFrame(stream.recv), 10000), Object.keys(state.grant.origins));
    this.check(state);
    try {
      await forward(stream, state.grant, serviceId, size => {
        try {
          this.check(state);
          this.consume(state.deviceId, size);
        } catch (error) {
          state.connection.close(1n, []);
          throw error;
        }
      }, state.sockets);
    } catch (error) {
      // HTTP keep-alive expiry and browser cancellation end one stream, not the authenticated session.
      if (!state.closing) {
        console.error('[web-access:stream-transport]', { pluginId: this.context.pluginId, deviceId: state.deviceId,
          connectionId: state.connectionId, serviceId, stack: error.stack });
      }
    }
  }

  consume(deviceId, size) {
    const now = Date.now();
    const previous = this.traffic.get(deviceId);
    const window = previous && now - previous.at < 1000 ? previous : { at: now, size: 0 };
    window.size += size;
    this.traffic.set(deviceId, window);
    if (window.size > 10 * 1024 * 1024) { throw Error('设备流量超过 10 MiB/s 限制'); }
    if (now - this.totalTraffic.at >= 1000) { this.totalTraffic = { at: now, size: 0 }; }
    this.totalTraffic.size += size;
    if (this.totalTraffic.size > 10 * 1024 * 1024) { throw Error('总流量超过 10 MiB/s 限制'); }
  }

  async closeConnection(state) {
    state.closing = true;
    clearInterval(state.diagnosticTimer);
    void this.diagnose(state, 'closing');
    state.connection?.close(0n, []);
    for (const socket of state.sockets) { socket.destroy(); }
    if (state.grant) { await this.context.host.transport.revoke(state.grant.grantId); }
    this.connections.delete(state.connectionId);
  }

  async disconnect(deviceId) {
    await Promise.all([...this.connections.values()].filter(state => state.deviceId === deviceId).map(state => this.closeConnection(state)));
  }

  async stop() {
    // Detach this generation before awaiting the Web broker; a later start owns a different endpoint.
    const endpoint = this.endpoint;
    this.endpoint = null;
    this.running = false;
    this.generation++;
    this.traffic.clear();
    this.totalTraffic = { at: 0, size: 0 };
    for (const resolve of this.waiters.values()) { resolve(false); }
    this.waiters.clear();
    if (this.pairs) { this.pairs.invite = null; this.pairs.pending.clear(); }
    try {
      await Promise.all([...this.connections.values()].map(state => this.closeConnection(state)));
    } finally {
      // Loss of the Web broker must never leave a public QUIC endpoint running.
      await endpoint?.close();
    }
    console.info('[web-access:stopped]', { pluginId: this.context.pluginId });
  }
}
