import './workspace.css';
import './session-status.css';
import '@xterm/xterm/css/xterm.css';
import { api, adapters } from './api.js';
import { mountWorkspace } from './workspace.js';
import { run } from './ui.js';

await run(async () => {
  document.documentElement.dataset.theme = (await api.storage.getPreferences()).theme;
  await mountWorkspace(document.querySelector('#workspace'), { pluginId: location.hostname, adapters: await adapters() });
});
