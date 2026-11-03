import './app.css';
import { invoke, request } from './api.js';
import { pluginHostOrigin } from '../../../../desk/src/resource/plugin-host.js';

const $ = selector => document.querySelector(selector);
const paths = {
  open: '<path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-7"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8M20 3v7h-7"/>',
  save: '<path d="M4 3h13l4 4v14H3V3Zm3 0v7h10V3M7 21v-7h10v7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
document.querySelectorAll('[data-icon]').forEach(button => { button.innerHTML = icon(button.dataset.icon); });
let busy = false;
let timer;
let visible = true;
let engineChanged = false;
let actionQueue = Promise.resolve();

function report(error) {
  $('#error').hidden = false;
  $('#error').textContent = error.message;
}

async function refresh() {
  const status = await invoke('browser.status');
  $('#state').textContent = status.installation.state === 'running' ? '正在下载并安装 Chromium'
    : status.installation.state === 'failed' ? status.installation.error
      : status.running ? `浏览器运行中 · ${status.tabs.length} 个标签` : status.ready ? '内核就绪 · 浏览器未打开' : '内核未就绪，请安装 Chromium 或选择本机 Chrome';
  if (!busy && !engineChanged && document.activeElement !== $('#engine')) {
    $('#engine').value = status.engine;
  }
  $('#close').disabled = busy || !status.running;
  $('#open').disabled = busy || !status.ready;
  $('#install').disabled = busy || status.installation.state === 'running';
  $('#tabs').querySelectorAll('button').forEach(node => { node.disabled = busy; });
  const signature = JSON.stringify(status.tabs);
  if ($('#tabs').dataset.signature === signature) {
    return;
  }
  $('#tabs').dataset.signature = signature;
  $('#tabs').replaceChildren(...status.tabs.map(tab => {
    const row = document.createElement('div');
    row.className = 'tab';
    const content = document.createElement('div');
    content.className = 'tab-content';
    const title = document.createElement('div');
    title.textContent = tab.title || '空白标签';
    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = tab.url;
    content.append(title, url);
    const focus = document.createElement('button');
    focus.type = 'button';
    focus.className = 'icon-button';
    focus.title = '切换到此标签';
    focus.setAttribute('aria-label', `切换到标签 ${tab.title || tab.id}`);
    focus.innerHTML = icon('open');
    focus.disabled = busy;
    focus.addEventListener('click', () => perform(() => invoke('browser.focus', tab.id)));
    row.append(content, focus);
    return row;
  }));
}

function perform(operation) {
  const action = actionQueue.then(() => execute(operation));
  actionQueue = action.catch(report);
  return action;
}

async function execute(operation) {
  busy = true;
  $('#error').hidden = true;
  document.querySelectorAll('button:not(.help button), select').forEach(node => { node.disabled = true; });
  try {
    const result = await operation();
    if (result?.failedStep !== undefined) {
      throw Error(result.error);
    }
  } catch (error) {
    report(error);
  } finally {
    busy = false;
    $('#save').disabled = false;
    $('#engine').disabled = false;
    $('#refresh').disabled = false;
    await refresh().catch(report);
  }
}

function openLaunchContext(context) {
  if (context?.path) {
    perform(() => invoke('browser.openHtml', { path: context.path, cwd: context.cwd }));
  }
}

// Plugin frames intentionally disallow native form submission; Enter uses the same RPC as the icon.
function openBrowser() {
  perform(() => invoke('browser.open', { url: $('#address').value.trim() }));
}
$('#open').addEventListener('click', openBrowser);
$('#address').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    openBrowser();
  }
});
$('#close').addEventListener('click', () => perform(() => invoke('browser.close')));
$('#engine').addEventListener('change', () => { engineChanged = true; });
$('#save').addEventListener('click', () => perform(async () => {
  const result = await invoke('browser.settings', { engine: $('#engine').value });
  engineChanged = false;
  return result;
}));
$('#install').addEventListener('click', () => perform(() => invoke('browser.install')));
$('#refresh').addEventListener('click', () => perform(() => Promise.resolve()));

// Poll metadata only while this view is visible; never transmit page content to the UI in the background.
function schedule() {
  clearTimeout(timer);
  if (!visible || document.hidden) {
    return;
  }
  timer = setTimeout(async () => {
    if (!busy) {
      await refresh().catch(report);
    }
    schedule();
  }, 2000);
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== pluginHostOrigin()) {
    return;
  }
  if (event.data?.type === 'desk:launch') {
    openLaunchContext(event.data.context);
  }
  if (event.data?.type === 'desk:visibility') {
    visible = event.data.visible;
    schedule();
  }
});
document.addEventListener('visibilitychange', schedule);
window.addEventListener('pagehide', () => clearTimeout(timer));
request('storage.getPreferences').then(value => {
  document.documentElement.dataset.theme = value.theme;
}).catch(report);
await refresh().catch(report);
if (document.body.dataset.page !== 'settings') {
  await request('host.getLaunchContext').then(openLaunchContext).catch(report);
}
schedule();
