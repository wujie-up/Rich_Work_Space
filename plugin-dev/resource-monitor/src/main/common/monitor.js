import { aggregate } from './metrics.js';

export class ResourceMonitor {
  constructor({ directory, platform, readSettings, writeSettings, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { directory, platform, readSettings, writeSettings, schedule, cancel });
    this.settings = { interval: 2, defaultCollapsed: false };
    this.history = [];
    this.running = false;
    this.error = null;
  }

  async start() {
    if (this.running) {
      return;
    }
    const saved = await this.readSettings();
    this.settings = { interval: [2, 5, 10].includes(saved.interval) ? saved.interval : 2,
      defaultCollapsed: saved.defaultCollapsed === true };
    this.running = true;
    this.timer = this.schedule(() => this.cycle(), 0);
  }

  async cycle() {
    if (!this.running || this.inFlight) {
      return;
    }
    this.controller = new AbortController();
    const started = Date.now();
    this.inFlight = this.collect(this.controller.signal);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
      if (this.running) {
        this.timer = this.schedule(() => this.cycle(), Math.max(0, this.settings.interval * 1000 - (Date.now() - started)));
      }
    }
  }

  async collect(signal) {
    try {
      const directory = await this.directory();
      if (signal.aborted) {
        return;
      }
      const sampled = await this.platform.sample({ signal });
      if (signal.aborted) {
        return;
      }
      const { baseline, ...latest } = aggregate(directory.plugins, sampled, this.baseline);
      this.baseline = baseline;
      this.latest = latest;
      this.history.push(latest);
      if (this.history.length > 120) {
        this.history.shift();
      }
      this.error = null;
    } catch (error) {
      if (!signal.aborted) {
        this.error = error.message;
        this.baseline = { time: 0, processes: new Map(), roots: this.baseline?.roots || new Map() };
        console.error('[resource-monitor:sample]', { pluginId: 'resource-monitor', message: error.message });
      }
    }
  }

  snapshot() {
    return { version: 1, running: this.running, settings: { ...this.settings }, latest: this.latest || null,
      history: this.history, error: this.error };
  }

  async updateSettings(change) {
    if (!change || typeof change !== 'object' || (change.interval !== undefined && ![2, 5, 10].includes(change.interval))) {
      throw Error('采样间隔只能为 2、5 或 10 秒');
    }
    if (change.defaultCollapsed !== undefined && typeof change.defaultCollapsed !== 'boolean') {
      throw Error('默认收起状态无效');
    }
    const next = { ...this.settings, ...Object.fromEntries(Object.entries(change).filter(([key]) =>
      ['interval', 'defaultCollapsed'].includes(key))) };
    await this.writeSettings(next);
    this.settings = next;
    return { ...next };
  }

  async stop() {
    this.running = false;
    this.cancel(this.timer);
    this.controller?.abort();
    await this.platform.close();
    await this.inFlight;
  }
}
