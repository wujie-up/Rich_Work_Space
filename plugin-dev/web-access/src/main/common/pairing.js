import { randomBytes, randomUUID, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { exact, denied } from './protocol.js';

export class Pairing {
  constructor({ hostId, devices, persist, now = Date.now, failClosed = async () => {}, disconnect = async () => {} }) {
    Object.assign(this, { hostId, persist, now, failClosed, disconnect });
    this.devices = new Map(devices.map(device => [device.deviceId, device]));
    this.pending = new Map();
    this.attempts = [];
  }

  approved(id) { return this.devices.has(id); }

  create(ticket) {
    this.attempts = this.attempts.filter(time => time > this.now() - 60_000);
    if (this.attempts.length >= 5) { throw Error('配对邀请创建过于频繁'); }
    this.attempts.push(this.now());
    this.pending.clear();
    this.invite = { version: 1, hostId: this.hostId, ticket, pairId: randomUUID(), secret: randomBytes(32).toString('hex'),
      expiresAt: this.now() + 120_000 };
    return { ...this.invite };
  }

  request(input, deviceId, nonce) {
    exact(input, ['pairId', 'label', 'proof'], ['type']);
    const invite = this.invite;
    if (!invite || invite.expiresAt <= this.now() || invite.pairId !== input.pairId || this.pending.size >= 8
      || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 64
      || typeof input.proof !== 'string' || !/^[a-f0-9]{64}$/.test(input.proof)) { throw denied(); }
    const expected = createHmac('sha256', Buffer.from(invite.secret, 'hex'))
      .update(`${'work-desk/web-access/1'}\n${this.hostId}\n${deviceId}\n${invite.pairId}\n${nonce}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(input.proof, 'hex'))) { throw denied(); }
    const request = { requestId: randomUUID(), pairId: invite.pairId, deviceId, label: input.label.trim(),
      fingerprint: createHash('sha256').update(deviceId).digest('hex').slice(0, 24), expiresAt: invite.expiresAt };
    this.pending.set(request.requestId, request);
    return request;
  }

  async confirm(requestId) {
    const pending = this.pending.get(requestId);
    if (!pending || !this.invite || pending.expiresAt <= this.now() || pending.pairId !== this.invite.pairId) { throw denied(); }
    // Consume before awaiting disk so concurrent confirmations cannot approve a second device.
    this.invite = null;
    this.pending.clear();
    const device = { deviceId: pending.deviceId, label: pending.label, approvedAt: this.now() };
    const devices = [...this.devices.values()].filter(entry => entry.deviceId !== device.deviceId).concat(device);
    try {
      await this.persist(devices);
      this.devices.set(device.deviceId, device);
      return device;
    } catch (error) {
      await this.failClosed();
      throw error;
    }
  }

  async revoke(id) {
    this.devices.delete(id);
    try {
      await this.disconnect(id);
      await this.persist([...this.devices.values()]);
    } catch (error) {
      await this.failClosed();
      throw error;
    }
  }
}
