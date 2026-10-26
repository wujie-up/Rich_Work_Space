import { randomUUID } from 'node:crypto';
const key = value => JSON.stringify([value?.pluginId, value?.instanceId, value?.windowId, value?.conversationId]);

export class SessionCaptureClient {
  constructor(services) {
    this.services = services;
    this.ownerId = randomUUID();
    this.target = null;
    this.enabled = false;
    this.operations = Promise.resolve();
  }

  queue(work) {
    const result = this.operations.then(work);
    this.operations = result.catch(() => {});
    return result;
  }

  async sources() {
    const providers = await this.services.discover('agent.capture.v2');
    return Promise.all(providers.map(async provider => {
      const catalog = await this.services.invoke(provider, { action: 'catalog' }, { timeout: 4500 });
      if (catalog?.version !== 2 || !Array.isArray(catalog.windows)) { throw Error('Agent 抓包接口不兼容，请升级 AI 插件'); }
      return { pluginId: provider.pluginId, ...catalog };
    }));
  }

  async invoke(target, action, values = {}) {
    const provider = (await this.services.discover('agent.capture.v2')).find(value => value.pluginId === target.pluginId);
    if (!provider) { throw Error('未发现目标 Agent，请启用 AI 插件 0.6.0 或更新版本'); }
    return this.services.invoke(provider, { ...target, action, ownerId: this.ownerId, ...values }, { timeout: 4500 });
  }

  configure(input) {
    return this.queue(async () => {
      const target = input.target || this.target;
      if (!target || typeof input.enabled !== 'boolean') { throw Error('请选择 Agent 窗口和具体对话'); }
      let warning;
      if (this.target && key(target) !== key(this.target) && this.enabled) {
        try { await this.invoke(this.target, 'configure', { enabled: false }); }
        catch { warning = '原 Agent 目标已失联，原记录租约将在 20 秒内到期'; }
        this.enabled = false;
      }
      const result = await this.invoke(target, 'configure', { enabled: input.enabled });
      this.target = { ...target };
      this.enabled = input.enabled;
      return { ...result, target: this.target, warning };
    });
  }

  renew() {
    return this.queue(async () => {
      if (this.target && this.enabled) { await this.invoke(this.target, 'configure', { enabled: true }); }
    });
  }

  async status() {
    if (!this.target) { return { enabled: false, state: 'unselected', target: null }; }
    const target = { ...this.target };
    try { return { ...await this.invoke(target, 'status'), target }; }
    catch (error) { return { enabled: false, state: 'unavailable', target, error: error.message }; }
  }

  checkedTarget(expected) {
    if (expected && key(expected) !== key(this.target)) { throw Error('抓包目标已在其他窗口切换，请刷新目标'); }
    return this.target;
  }

  list(expected) {
    const target = this.checkedTarget(expected);
    return target ? this.invoke(target, 'list') : [];
  }
  read(id, offset, expected) {
    const target = this.checkedTarget(expected);
    if (!this.target) { throw Error('请选择目标对话'); }
    return this.invoke(target, 'read', { id, offset });
  }

  stop() {
    return this.queue(async () => {
      if (this.target && this.enabled) {
        try { await this.invoke(this.target, 'configure', { enabled: false }); }
        finally { this.enabled = false; }
      }
    });
  }
}
