import { message, setLanguage } from './i18n.js';
import './desk.css';
import { pluginIcon } from './plugin-icon.js';
import { api, el, toast, run, ask, confirm, iconButton, icons, modal } from './ui.js';
import { mountWindows } from './window-manager.js';
import { canOpen, contextMenu, dismissMenu, pluginDragType } from './launcher.js';
import { mountShelfLayout } from './shelf-layout.js';
import { mountSettings } from './settings.js';
import { transition } from './plugins.js';
import { mountAccountMenu } from './account-menu.js';
import { mountOverlays } from './overlays.js';

const content = document.querySelector('#content');
const desktop = el('div', { class: 'desktop-surface', 'aria-label-message': '桌面' },
  el('span', { class: 'workspace-label', message: '本地工作空间' }));
const manager = mountWindows(content, { openPlugin: newPluginWindow, openView: openContributedView, closePlugin: id => run(() => transition(id, 'close')) });
const { windows } = manager;
let preferences;
let closeSettings;
let records = [];
const shelf = el('nav', { class: 'plugin-shelf', id: 'plugin-shelf', 'aria-label-message': '已安装插件' });
shelf.dataset.names = localStorage.getItem('plugin-shelf-show-names') === 'false' ? 'hidden' : 'visible';
const shelfLayout = mountShelfLayout(shelf);
let shelfResize;
const shelfToggle = el('button', { class: 'shelf-toggle', 'aria-controls': 'plugin-shelf', onclick: (event) => {
  // Pointer drags also emit click; keep resize releases from collapsing the shelf.
  if (event.detail > 0 && shelfResize?.moved) {
    shelfResize = null;
    return;
  }
  closeAccountMenu();
  const hidden = !shelf.hidden;
  shelf.hidden = hidden;
  content.classList.toggle('shelf-collapsed', hidden);
  shelfToggle.setAttribute('aria-expanded', String(!hidden));
  message(shelfToggle, hidden ? '显示插件栏' : '隐藏插件栏', 'aria-label');
  localStorage.setItem('plugin-shelf-hidden', String(hidden));
} });
shelf.hidden = localStorage.getItem('plugin-shelf-hidden') === 'true';
content.classList.toggle('shelf-collapsed', shelf.hidden);
shelfToggle.setAttribute('aria-expanded', String(!shelf.hidden));
message(shelfToggle, shelf.hidden ? '显示插件栏' : '隐藏插件栏', 'aria-label');
const homeButton = iconButton('m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8', '回到桌面', showDesktop);
homeButton.id = 'desktop';
document.querySelector('#desktop').replaceWith(homeButton);
const surface = el('div', { class: 'desktop-stage' });
content.before(surface);
surface.append(content, shelf, document.querySelector('.titlebar'), shelfToggle);
const overlays = mountOverlays(surface, { closePlugin: id => transition(id, 'close'),
  openWindow: (plugin, view) => manager.open(plugin, view), openView: openContributedView });
const closeAccountMenu = mountAccountMenu(surface, configure, changeLanguage);
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
  closeAccountMenu();
  dismissMenu();
  closeSettings?.();
  closeSettings = mountSettings(openPlugin, toggleTheme, { gridSize: preferences.gridSize || 24,
    shelfIconSize: preferences.shelfIconSize || 36, theme: preferences.theme || 'system', shelfNames: shelf.dataset.names !== 'hidden', save: saveDesktopSettings });
}

function showDesktop() {
  dismissMenu();
  closeSettings?.();
  closeSettings = null;
  manager.home();
}

async function openPlugin(id) {
  const plugin = records.find((record) => record.id === id && canOpen(record));
  if (!plugin) {
    return;
  }
  dismissMenu();
  closeSettings?.();
  closeSettings = null;
  if (plugin.views.some(view => view.presentation?.type === 'overlay')) {
    await api.plugins.start(id);
    await refresh();
    overlays.restore(id);
    return;
  }
  const existing = [...windows.values()].filter(view => view.plugin.id === id).sort((a, b) => b.layer - a.layer)[0];
  if (existing) {
    manager.restore(existing);
    return;
  }
  manager.open(plugin);
}

function newPluginWindow(id) {
  const plugin = records.find(record => record.id === id && canOpen(record));
  if (plugin?.singleInstance) {
    return openPlugin(id);
  }
  if (plugin) {
    dismissMenu();
    closeSettings?.();
    closeSettings = null;
    manager.open(plugin, { ...plugin.views[0], entry: `${plugin.views[0].entry}?fresh=1` });
  }
}

// Resolve a declared entry through the host; providers keep ownership of their view and launch payload.
function openContributedView(entry, launchContext) {
  const providers = records.filter(canOpen).flatMap(plugin => plugin.views
    .filter(view => view.contributes?.entries?.includes(entry)).map(view => ({ plugin, view })));
  if (providers.length !== 1) {
    throw Error(providers.length ? '该入口存在多个提供方，请保留一个启用的插件' : '请先安装并启用提供该入口的插件');
  }
  const { plugin, view } = providers[0];
  const opened = manager.open(plugin, { ...view, launchContext });
  return { windowId: opened.id };
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
  overlays.refresh(records);
  refreshEntry();
}

function mountDesktop() {
  // Hiding a disabled launcher preserves its saved placement and alias for the next enable.
  shelf.replaceChildren(...records.filter((plugin) => plugin.state === 'enabled' && plugin.showIcon !== false).map((plugin) => {
    const name = localStorage.getItem(`plugin-shelf-name:${plugin.id}`) || plugin.name;
    return el('div', { class: 'shelf-app', role: 'button', tabindex: 0, 'data-plugin': plugin.id,
      'title-message': canOpen(plugin) ? ['{name}', { name }] : ['{name}（前往配置）', { name }], 'aria-label': name,
      'data-enabled': canOpen(plugin), onkeydown: event => {
        if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          openPlugin(plugin.id);
        }
      }, onclick: () => canOpen(plugin) ? openPlugin(plugin.id) : configure(),
      oncontextmenu: (event) => contextMenu(event, [['修改名称', () => renameShelfPlugin(plugin)], ['修改图标', () => api.plugins.setIcon(plugin.id)], ['恢复默认图标', () => api.plugins.resetIcon(plugin.id)]]) },
    el('span', { class: 'shelf-icon', 'aria-hidden': true }, pluginIcon(plugin)), el('span', { class: 'shelf-name', text: name }));
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

// Language updates host labels in place, keeping every plugin frame and live task mounted.
async function changeLanguage(language) {
  await savePreferences({ language });
  setLanguage(language);
  console.info('[desktop:language]', { language });
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
  ...([...windows.values()].some((view) => view.root.dataset.phase === 'open') ? [['回到桌面', showDesktop]] : []),
  ['添加插件', configure]
]));
for (const target of [content, document.querySelector('#desktop')]) {
  target.addEventListener('dragover', acceptDrag);
  target.addEventListener('drop', openDrop);
}
api.events.pluginsChanged(() => run(refresh));
api.events.pluginClosed(({ pluginId }) => {
  overlays.close(pluginId);
  for (const [id, window] of windows) {
    if (window.plugin.id === pluginId) {
      manager.close(id);
    }
  }
});
api.events.error((error) => {
  if (error.code === 'PLUGIN_VIEW_CRASHED') {
    overlays.fail(error.pluginId);
    for (const [id, window] of windows) {
      if (window.plugin.id === error.pluginId) {
        manager.close(id);
      }
    }
  }
  toast(error.message);
});
const conversationEntry = iconButton('M4 4h16v12H9l-5 4Z M8 8h8M8 12h5', 'AI 对话', openConversation, 'global-conversation-entry');
surface.append(conversationEntry);
await run(async () => {
  preferences = await api.storage.getPreferences();
  setLanguage(preferences.language || 'zh-CN');
  applyTheme();
  surface.style.setProperty('--shelf-icon-size', `${preferences.shelfIconSize || 36}px`);
  manager.setGridSize(preferences.gridSize || 24);
  const info = await api.host.info();
  if (info.warning) {
    toast(info.warning);
  }
  await refresh();
});

// Native application menus reuse the same settings view as desktop actions.
api.events.configure(() => run(configure));


function entryProviders() {
  return records.filter(plugin => canOpen(plugin)).flatMap(plugin => plugin.views
    .filter(view => view.contributes?.entries?.includes('global-conversation')).map(view => ({ plugin, view })));
}
function refreshEntry() {
  conversationEntry.disabled = false;
}
async function openConversation() {
  const providers = entryProviders();
  if (!providers.length) { configure(); toast('请安装并启用提供 AI 对话入口的插件'); return; }
  let provider = providers.find(item => `${item.plugin.id}:${item.view.id}` === localStorage.getItem('entry-provider:global-conversation'));
  if (!provider && providers.length === 1) { provider = providers[0]; }
  if (!provider) {
    provider = await modal('选择对话插件', ({ body, finish }) => {
      for (const item of providers) {
        body.append(el('button', { text: `${item.plugin.name} · ${item.view.title}`, onclick: () => finish(item) }));
      }
    });
  }
  if (!provider) { return; }
  localStorage.setItem('entry-provider:global-conversation', `${provider.plugin.id}:${provider.view.id}`);
  const existing = [...windows.values()].find(item => item.plugin.id === provider.plugin.id && item.entryViewId === provider.view.id);
  if (existing) { manager.restore(existing); return; }
  manager.open(provider.plugin, provider.view);
}
// Confirmation originates in the trusted desktop frame; plugins cannot approve their own effects.
api.events.capabilityApproval?.(request => run(async () => {
  const allowed = await modal(request.title, ({ body, actions, finish }) => {
    body.append(el('p', { text: request.description }), el('p', { class: 'muted', text: request.effects.join(' · ') }),
      el('pre', { class: 'capability-input', text: JSON.stringify(request.input, null, 2) }));
    actions.append(iconButton(icons.cancel, '取消', () => finish(false)), iconButton(icons.check, '允许', () => finish(true)));
  });
  await api.capabilities.approve(request.invocationId, Boolean(allowed));
}));
