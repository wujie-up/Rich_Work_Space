import './desk.css';
import { api, el, toast, run, ask } from './ui.js';
import { mountWindows } from './window-manager.js';
import { canOpen, contextMenu, dismissMenu, pluginDragType } from './launcher.js';
import { mountShelfLayout } from './shelf-layout.js';
import { mountSettings } from './settings.js';
import { transition } from './plugins.js';

const content = document.querySelector('#content');
const desktop = el('div', { class: 'desktop-surface', 'aria-label': '桌面' },
  el('span', { class: 'workspace-label', text: '本地工作空间' }));
const manager = mountWindows(content, { openPlugin, closePlugin: (id) => run(() => transition(id, 'close')), changed: (view) => {
  document.querySelector('#desktop').hidden = !view;
} });
const { windows } = manager;
let preferences;
let closeSettings;
let records = [];
let version = '';
const shelf = el('nav', { class: 'plugin-shelf', id: 'plugin-shelf', 'aria-label': '已安装插件' });
shelf.dataset.names = localStorage.getItem('plugin-shelf-show-names') === 'false' ? 'hidden' : 'visible';
const shelfLayout = mountShelfLayout(shelf);
let shelfResize;
const shelfToggle = el('button', { class: 'shelf-toggle', 'aria-controls': 'plugin-shelf', onclick: (event) => {
  // Pointer drags also emit click; keep resize releases from collapsing the shelf.
  if (event.detail > 0 && shelfResize?.moved) {
    shelfResize = null;
    return;
  }
  const hidden = !shelf.hidden;
  shelf.hidden = hidden;
  content.classList.toggle('shelf-collapsed', hidden);
  shelfToggle.setAttribute('aria-expanded', String(!hidden));
  shelfToggle.setAttribute('aria-label', hidden ? '显示插件栏' : '隐藏插件栏');
  localStorage.setItem('plugin-shelf-hidden', String(hidden));
} });
shelf.hidden = localStorage.getItem('plugin-shelf-hidden') === 'true';
content.classList.toggle('shelf-collapsed', shelf.hidden);
shelfToggle.setAttribute('aria-expanded', String(!shelf.hidden));
shelfToggle.setAttribute('aria-label', shelf.hidden ? '显示插件栏' : '隐藏插件栏');
const surface = el('div', { class: 'desktop-stage' });
content.before(surface);
surface.append(content, shelf, shelfToggle);
surface.style.setProperty('--shelf-preferred-width', `${Number(localStorage.getItem('plugin-shelf-width')) || 64}px`);
shelfToggle.addEventListener('pointerdown', (event) => {
  shelfResize = null;
  if (shelf.hidden || event.button !== 0) {
    return;
  }
  shelfResize = { x: event.clientX, width: shelf.getBoundingClientRect().width, moved: false };
  shelfToggle.setPointerCapture(event.pointerId);
});
shelfToggle.addEventListener('pointermove', (event) => {
  if (!shelfResize || !shelfToggle.hasPointerCapture(event.pointerId)) {
    return;
  }
  if (Math.abs(event.clientX - shelfResize.x) > 4) {
    shelfResize.moved = true;
  }
  if (shelfResize.moved) {
    const width = Math.max(64, Math.min(320, shelfResize.width + event.clientX - shelfResize.x));
    surface.style.setProperty('--shelf-preferred-width', `${width}px`);
    surface.classList.add('shelf-resizing');
  }
});
shelfToggle.addEventListener('lostpointercapture', () => {
  surface.classList.remove('shelf-resizing');
  if (shelfResize?.moved) {
    localStorage.setItem('plugin-shelf-width', String(shelf.getBoundingClientRect().width));
  }
});
content.append(desktop);

function configure() {
  dismissMenu();
  closeSettings?.();
  closeSettings = mountSettings(openPlugin, toggleTheme, version, { gridSize: preferences.gridSize || 24,
    shelfIconSize: preferences.shelfIconSize || 36, theme: preferences.theme || 'system', shelfNames: shelf.dataset.names !== 'hidden', save: saveDesktopSettings });
}

function showDesktop() {
  dismissMenu();
  closeSettings?.();
  closeSettings = null;
  manager.home();
}

function openPlugin(id) {
  const plugin = records.find((record) => record.id === id && canOpen(record));
  if (!plugin) {
    return;
  }
  dismissMenu();
  closeSettings?.();
  closeSettings = null;
  manager.open(plugin);
}

async function refresh() {
  records = await api.plugins.list();
  for (const [id, window] of windows) {
    // Keep the shell until shutdown succeeds, so a failed operation leaves the running view available.
    if (!records.some((record) => record.id === window.plugin.id && record.state === 'enabled')) {
      manager.close(id);
    }
  }
  mountDesktop();
}

function mountDesktop() {
  // Disabled installed plugins stay discoverable; enabling remains an explicit configuration action.
  shelf.replaceChildren(...records.filter((plugin) => plugin.state !== 'uninstalled' && plugin.showIcon !== false).map((plugin) => {
    const name = localStorage.getItem(`plugin-shelf-name:${plugin.id}`) || plugin.name;
    return el('button', { class: 'shelf-app', 'data-plugin': plugin.id,
      title: `${name}${canOpen(plugin) ? '' : '（前往配置）'}`, 'aria-label': name,
      'data-enabled': canOpen(plugin), onclick: () => canOpen(plugin) ? openPlugin(plugin.id) : configure(),
      oncontextmenu: (event) => contextMenu(event, [['修改名称', () => renameShelfPlugin(plugin)]]) },
    el('span', { class: 'shelf-icon', text: '⌘', 'aria-hidden': true }), el('span', { class: 'shelf-name', text: name }));
  }));
  [...shelf.children].forEach(node => shelfLayout.bind(node));
  shelfLayout.layout();
}

// Display aliases belong to the desktop; plugin identity and running windows keep their original metadata.
async function renameShelfPlugin(plugin) {
  const name = await ask('修改插件名称', localStorage.getItem(`plugin-shelf-name:${plugin.id}`) || plugin.name);
  if (name === null) {
    return;
  }
  if (!name.trim()) {
    toast('插件名称不能为空');
    return;
  }
  localStorage.setItem(`plugin-shelf-name:${plugin.id}`, name.trim());
  console.info('[shelf:rename]', { pluginId: plugin.id });
  mountDesktop();
}

function acceptDrag(event) {
  if (event.dataTransfer.types.includes(pluginDragType)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
}

function openDrop(event) {
  const id = event.dataTransfer.getData(pluginDragType);
  if (records.some((record) => record.id === id && canOpen(record))) {
    event.preventDefault();
    openPlugin(id);
  }
}

async function toggleTheme(selected) {
  const theme = selected || (document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  await savePreferences({ theme });
  applyTheme();
}

async function savePreferences(change) {
  const next = { ...preferences, ...change };
  await api.storage.savePreferences(next);
  preferences = next;
}

// Apply only the changed desktop setting so icon sizing never settles or replaces plugin windows.
async function saveDesktopSettings(change) {
  if (change.shelfNames !== undefined) {
    localStorage.setItem('plugin-shelf-show-names', String(change.shelfNames));
    shelf.dataset.names = change.shelfNames ? 'visible' : 'hidden';
    shelfLayout.layout();
    return;
  }
  await savePreferences(change);
  if (change.gridSize !== undefined) {
    manager.setGridSize(change.gridSize);
  }
  if (change.shelfIconSize !== undefined) {
    surface.style.setProperty('--shelf-icon-size', `${change.shelfIconSize}px`);
    shelfLayout.layout();
  }
}

const systemTheme = matchMedia('(prefers-color-scheme: dark)');

// Resolve system appearance in the host and notify retained plugin frames without reloading them.
function applyTheme() {
  const theme = preferences.theme === 'system' || !preferences.theme
    ? (systemTheme.matches ? 'dark' : 'light') : preferences.theme;
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent('desk-theme', { detail: theme }));
}

systemTheme.addEventListener('change', () => {
  if (preferences?.theme === 'system' || preferences && !preferences.theme) {
    applyTheme();
  }
});

desktop.addEventListener('contextmenu', (event) => contextMenu(event, [
  ...([...windows.values()].some((view) => ['open', 'restoring'].includes(view.root.dataset.phase)) ? [['回到桌面', showDesktop]] : []),
  ['添加插件', configure]
]));
document.querySelector('#desktop').addEventListener('click', showDesktop);
for (const target of [content, document.querySelector('#desktop')]) {
  target.addEventListener('dragover', acceptDrag);
  target.addEventListener('drop', openDrop);
}
api.events.pluginsChanged(() => run(refresh));
api.events.error((error) => {
  if (error.code === 'PLUGIN_VIEW_CRASHED') {
    for (const [id, window] of windows) {
      if (window.plugin.id === error.pluginId) {
        manager.close(id);
      }
    }
  }
  toast(error.message);
});
await run(async () => {
  preferences = await api.storage.getPreferences();
  applyTheme();
  surface.style.setProperty('--shelf-icon-size', `${preferences.shelfIconSize || 36}px`);
  manager.setGridSize(preferences.gridSize || 24);
  const info = await api.host.info();
  version = `v${info.version}`;
  if (info.warning) {
    toast(info.warning);
  }
  await refresh();
});

// Native application menus reuse the same settings view as desktop actions.
api.events.configure(() => run(configure));
