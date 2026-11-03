// Route once at the host boundary; retained pages must not multiply IPC listeners.
export class PluginEvents {
  constructor(target, subscribe) {
    this.target = target;
    this.subscribe = subscribe;
    this.frames = new Map();
    this.plugins = new Map();
    this.receive = event => {
      const frame = this.frames.get(event.source);
      if (frame?.origin === event.origin) {
        frame.receive(event);
      }
    };
  }

  add(source, pluginId, receive, send, origin = `desk-plugin://${pluginId}`) {
    if (!this.frames.size) {
      this.target.addEventListener('message', this.receive);
      this.off = this.subscribe(event => {
        for (const frame of this.plugins.get(event.pluginId) || []) {
          frame.send({ type: 'desk:event', ...event });
        }
      });
    }
    const frame = { origin, receive, send };
    this.frames.set(source, frame);
    const group = this.plugins.get(pluginId) || new Set();
    group.add(frame);
    this.plugins.set(pluginId, group);
    return () => {
      this.frames.delete(source);
      group.delete(frame);
      if (!group.size) {
        this.plugins.delete(pluginId);
      }
      if (!this.frames.size) {
        this.target.removeEventListener('message', this.receive);
        this.off();
      }
    };
  }
}
