import './workspace.css';
import '@xterm/xterm/css/xterm.css';
import { api, adapters } from './api.js';
import { mountWorkspace } from './workspace.js';
import { run } from './ui.js';

// Retain one logical canvas per view so resizing scales typography and terminals without rearranging them.
const viewport = { width: innerWidth, height: innerHeight };
const scaleWorkspace = () => {
  const root = document.documentElement;
  root.style.zoom = Math.min(innerWidth / viewport.width, innerHeight / viewport.height);
  root.style.width = `${viewport.width}px`;
  root.style.height = `${viewport.height}px`;
  root.style.setProperty('--workspace-width', `${viewport.width}px`);
  root.style.setProperty('--workspace-height', `${viewport.height}px`);
};
window.addEventListener('resize', scaleWorkspace);
scaleWorkspace();

await run(async () => {
  document.documentElement.dataset.theme = (await api.storage.getPreferences()).theme;
  await mountWorkspace(document.querySelector('#workspace'), { pluginId: location.hostname, adapters: await adapters() });
});
