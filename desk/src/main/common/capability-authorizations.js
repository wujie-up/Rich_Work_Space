import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../../shared/contracts.js';

// A remembered consent creates a fresh live lease; an old process never inherits it.
export class CapabilityAuthorizations {
  constructor({ storage, messages, resolve }) {
    Object.assign(this, { storage, messages, resolve });
    this.leases = new Map();
    this.writes = Promise.resolve();
  }

  async request(owner, { scopeKey, title, providers, approval = 'prompt' }) {
    if (typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > 300 || !Array.isArray(providers) || !providers.length
      || !['prompt', 'automatic'].includes(approval)) {
      throw fail('INPUT_INVALID', '授权范围无效');
    }
    const entries = providers.map(handle => {
      const { runtime, descriptor } = this.resolve(handle);
      return { handle, packageIdentity: runtime.packageIdentity, descriptor };
    });
    const fingerprint = createHash('sha256').update(JSON.stringify({ owner: owner.id, packageIdentity: owner.packageIdentity, scopeKey, entries:
      entries.map(({ handle, packageIdentity, descriptor }) => ({ pluginId: handle.pluginId, packageIdentity, descriptor })) })).digest('hex');
    // Register before I/O so stopping either runtime can revoke an in-flight request.
    const lease = { id: randomUUID(), owner, scopeKey, entries, state: 'pending' };
    this.leases.set(lease.id, lease);
    // Trusted local automation opts in per request; it must not create remembered user consent.
    if (approval === 'automatic') {
      lease.state = 'granted';
      console.info('[capability:authorized]', { pluginId: owner.id, instanceId: owner.instanceId, scopeKey, approval });
      return { id: lease.id, state: lease.state };
    }
    const remembered = await this.storage.readJson('capability-consents.json', {});
    if (lease.state === 'revoked') { return { id: lease.id, state: lease.state }; }
    if (remembered[fingerprint]) { lease.state = 'granted'; }
    if (lease.state === 'pending') {
      lease.message = this.messages.request(owner, { title: title || '允许后台能力调用',
        question: `允许此范围的后台任务完全授权运行并记住选择？\n${entries.map(entry =>
          `${entry.handle.pluginId} · ${entry.descriptor.title} (${entry.descriptor.effects.join(', ')})`).join('\n')}`,
        options: ['允许并记住', '拒绝'], optionsOnly: true }, async answer => {
        if (lease.state !== 'pending') {
          return;
        }
        const state = answer.text === '允许并记住' ? 'granted' : 'denied';
        if (state === 'granted') {
          this.writes = this.writes.catch(() => {}).then(async () => {
            const current = await this.storage.readJson('capability-consents.json', {});
            await this.storage.writeJson('capability-consents.json', { ...current, [fingerprint]: true });
          });
          await this.writes;
        }
        if (lease.state === 'pending') { lease.state = state; }
      }).id;
    }
    return { id: lease.id, state: lease.state };
  }

  get(owner, id) {
    const lease = this.leases.get(id);
    if (!lease || lease.owner !== owner) {
      throw fail('AUTHORIZATION_FORBIDDEN', '授权不属于当前实例');
    }
    return { id, state: lease.state };
  }

  allows(owner, id, handle) {
    const lease = this.leases.get(id);
    if (!lease || lease.state !== 'granted') {
      return false;
    }
    const delegated = lease.entries.some(entry => entry.handle.pluginId === owner.id && entry.handle.instanceId === owner.instanceId);
    if (lease.owner !== owner && !delegated) {
      return false;
    }
    return lease.entries.some(entry => JSON.stringify(entry.handle) === JSON.stringify(handle));
  }

  revoke(owner, id) {
    const lease = this.leases.get(id);
    this.get(owner, id);
    lease.state = 'revoked';
    if (lease.message) {
      this.messages.cancel(owner, lease.message);
    }
  }

  revokeRuntime(runtime) {
    for (const lease of this.leases.values()) {
      if (lease.owner === runtime || lease.entries.some(entry => entry.handle.instanceId === runtime.instanceId)) {
        lease.state = 'revoked';
        if (lease.message) { this.messages.cancel(lease.owner, lease.message); }
      }
    }
  }
}
