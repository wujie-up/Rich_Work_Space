import { ResourceMonitor } from './monitor.js';
import { createPlatform } from '../os/index.js';

let monitor;

export async function activate(context) {
  const key = `plugin-data/${context.pluginId}/settings.json`;
  monitor = new ResourceMonitor({ directory: () => context.host.runtimeDirectory(),
    platform: createPlatform({ ownProcesses: pids => context.ownProcesses(pids) }),
    readSettings: () => context.storage.readJson(key, {}), writeSettings: value => context.storage.writeJson(key, value) });
  context.methods.register('monitor.snapshot', () => monitor.snapshot());
  context.methods.register('monitor.settings', () => ({ ...monitor.settings }));
  context.methods.register('monitor.saveSettings', change => monitor.updateSettings(change), { exclusive: true });
  context.lifecycle.register({ snapshot: () => [], stop: () => monitor.stop() });
  await monitor.start();
  console.info('[resource-monitor:start]', { pluginId: context.pluginId, interval: monitor.settings.interval });
}

export async function deactivate() {
  await monitor?.stop();
  monitor = null;
}
