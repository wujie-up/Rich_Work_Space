import { pluginIdentity } from '../../../../desk/src/resource/plugin-host.js';
import '../../../../desk/src/resource/controls.css';
import './workspace.css';
import './session-groups.css';
import './session-status.css';
import '@xterm/xterm/css/xterm.css';
import { api, adapters } from './api.js';
import { mountWorkspace } from './workspace.js';
import { el, run } from './ui.js';
import { mountAppearance } from './appearance.js';

const disposeAppearance = mountAppearance();
window.addEventListener('pagehide', disposeAppearance, { once: true });

const root = document.querySelector('#workspace');
const loading = el('div', { class: 'workspace-loading', role: 'status', text: '正在载入工作区…' });
root.setAttribute('aria-busy', 'true');
root.replaceChildren(loading);

await run(async () => {
  try {
    document.documentElement.dataset.theme = (await api.storage.getPreferences()).theme;
    const syncTheme = async () => {
      try {
        await api.sessions.setTheme(pluginIdentity(), document.documentElement.dataset.theme);
      } catch (error) {
        // A palette failure may fall back to the CLI's unshaded composer, but must not prevent opening sessions.
        console.error('[session:palette-theme]', { pluginId: pluginIdentity() }, error);
      }
    };
    await syncTheme();
    window.addEventListener('desk-theme', syncTheme);
    await mountWorkspace(root, { pluginId: pluginIdentity(), adapters: await adapters() });
  } catch (error) {
    console.error('[session:workspace-load-failed]', { pluginId: pluginIdentity() }, error);
    loading.textContent = `工作区加载失败：${error.message}。请重新打开插件重试。`;
    loading.setAttribute('role', 'alert');
    root.setAttribute('aria-busy', 'false');
    root.replaceChildren(loading);
    throw error;
  }
});
