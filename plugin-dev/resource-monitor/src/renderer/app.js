import './style.css';
import { invoke, request, send, collapsed } from './api.js';
import { format, chartPath } from './format.js';

const root = document.querySelector('#app');
const metrics = [['cpu', 'CPU'], ['memory', '内存'], ['received', '下载'], ['sent', '上传']];
let active = true;
let selected = '';
let sort = 'cpu';
let latestSnapshot;

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'text') {
      node.textContent = value;
    } else if (key.startsWith('on')) {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  node.append(...children);
  return node;
}

// Keep secondary explanations available without occupying the monitoring panel.
function help(id, label, text) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16.5v.1"/>';
  return el('span', { class: 'help' },
    el('button', { type: 'button', 'aria-label': label, 'aria-describedby': id, title: label }, icon),
    el('span', { id, class: 'help-text', role: 'tooltip', text }));
}

const status = el('p', { class: 'status', role: 'status', text: '正在采集…' });
request('storage.getPreferences', []).then(preferences => {
  document.documentElement.dataset.theme = preferences.theme;
}).catch(error => { status.textContent = error.message; });

function showSettings() {
  const interval = el('select', { id: 'interval' }, ...[2, 5, 10].map(value => el('option', { value, text: `${value} 秒` })));
  const compact = el('input', { id: 'compact', type: 'checkbox' });
  const save = el('button', { type: 'button', text: '保存设置', onclick: async () => {
    save.disabled = true;
    try {
      await invoke('monitor.saveSettings', { interval: Number(interval.value), defaultCollapsed: compact.checked });
      status.textContent = '已保存';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  } });
  root.replaceChildren(el('div', { class: 'settings' },
    el('label', { for: 'interval', text: '采样间隔' }, interval),
    el('label', { class: 'checkbox', for: 'compact' }, compact, el('span', { text: '默认收起为横条' })),
    help('collapse-help', '收起状态说明', '仅首次显示时使用默认状态；已有面板保留上次状态。'), save, status));
  invoke('monitor.settings').then(settings => {
    interval.value = String(settings.interval);
    compact.checked = settings.defaultCollapsed;
    status.textContent = '';
  }).catch(error => { status.textContent = error.message; });
}

function updateDashboard(picker, sorting, cards, table) {
  const controls = root.querySelector('.controls');
  if (!controls) {
    root.replaceChildren(el('div', { class: 'controls' }, picker, sorting), el('div', { class: 'metrics' }, ...cards),
      el('div', { class: 'table-scroll' }, table), el('div', { class: 'monitor-footer' }, status,
        help('metrics-help', '统计口径说明',
          '仅统计插件后台及可归属子进程。CPU 按整机归一化；内存为 RSS，含共享页。共享界面、网络进程不计入，短命进程可能遗漏。')));
    return;
  }
  const previousPicker = controls.querySelector('[aria-label="查看插件"]');
  const options = node => [...node.options].map(option => [option.value, option.textContent]);
  if (JSON.stringify(options(previousPicker)) !== JSON.stringify(options(picker))) {
    previousPicker.replaceChildren(...picker.children);
  }
  previousPicker.value = selected;
  controls.querySelector('[aria-label="排序指标"]').value = sort;
  for (const card of cards) {
    const current = root.querySelector(`[data-metric="${card.dataset.metric}"]`);
    current.querySelector('.metric-value').textContent = card.querySelector('.metric-value').textContent;
    current.querySelector('path').setAttribute('d', card.querySelector('path').getAttribute('d'));
  }
  const body = root.querySelector('tbody');
  const rows = new Map([...body.rows].map(row => [row.dataset.plugin, row]));
  let next = body.firstElementChild;
  for (const row of [...table.querySelector('tbody').rows]) {
    const existing = rows.get(row.dataset.plugin);
    if (existing) {
      existing.setAttribute('aria-selected', row.getAttribute('aria-selected'));
      existing.querySelector('button').textContent = row.querySelector('button').textContent;
      existing.querySelector('button').title = row.querySelector('button').title;
      for (let i = 1; i < row.cells.length; i++) {
        existing.cells[i].textContent = row.cells[i].textContent;
      }
    }
    const item = existing || row;
    if (item !== next) {
      if (item.parentNode === body) {
        body.moveBefore(item, next);
      } else {
        body.insertBefore(item, next);
      }
    }
    next = item.nextElementSibling;
    rows.delete(item.dataset.plugin);
  }
  for (const row of rows.values()) {
    row.remove();
  }
}

function render(snapshot) {
  latestSnapshot = snapshot;
  const current = snapshot.latest;
  const stale = Boolean(snapshot.error || current && Date.now() - current.time > snapshot.settings.interval * 3000 + 3000);
  const total = stale ? {} : current?.total || {};
  send({ type: 'desk:overlay-summary', text: stale ? '采样中断 · 请展开查看' :
    `CPU ${format('cpu', total.cpu)}  内存 ${format('memory', total.memory)}  下载 ${format('received', total.received)}  上传 ${format('sent', total.sent)}` });
  send({ type: 'desk:overlay-state', defaultCollapsed: snapshot.settings.defaultCollapsed });
  if (collapsed) {
    return;
  }
  const rows = current?.rows || [];
  if (!rows.some(row => row.pluginId === selected)) {
    selected = '';
  }
  const selectedRow = selected ? rows.find(row => row.pluginId === selected) : current?.total;
  const displayed = stale ? {} : selectedRow || {};
  const picker = el('select', { 'aria-label': '查看插件', onchange: event => {
    selected = event.target.value;
    render(latestSnapshot);
  } }, el('option', { value: '', text: '全部插件' }), ...rows.map(row => el('option', { value: row.pluginId, text: row.name })));
  picker.value = selected;
  const sorting = el('select', { 'aria-label': '排序指标', onchange: event => {
    sort = event.target.value;
    render(latestSnapshot);
  } }, ...[['cpu', '按 CPU 排序'], ['memory', '按内存排序'], ['received', '按下载排序']]
    .map(([value, text]) => el('option', { value, text })));
  sorting.value = sort;
  const cards = metrics.map(([key, name]) => {
    const values = snapshot.history.map(point => (selected ? point.rows.find(row => row.pluginId === selected) : point.total)?.[key]);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 280 50');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', `${name}近期趋势`);
    svg.setAttribute('role', 'img');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', chartPath(values, key === 'cpu' ? 100 : undefined));
    if (key === 'sent') {
      path.setAttribute('stroke-dasharray', '4 3');
    }
    svg.append(path);
    return el('div', { class: 'metric', 'data-metric': key }, el('div', { class: 'metric-heading' },
      el('span', { text: name }), el('strong', { class: 'metric-value', text: format(key, displayed[key]) })), svg);
  });
  const table = el('table', { class: 'plugin-table' }, el('thead', {}, el('tr', {},
    ...['插件', 'CPU', '内存', '下载 / 上传'].map(text => el('th', { text })))),
  el('tbody', {}, ...[...rows].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1)).map(row => el('tr', {
    'data-plugin': row.pluginId, 'aria-selected': String(row.pluginId === selected)
  }, el('td', {}, el('button', { type: 'button', text: row.name, title: `${row.pluginId} · ${row.processCount} 个进程`, onclick: () => {
    selected = selected === row.pluginId ? '' : row.pluginId;
    render(latestSnapshot);
  } })), el('td', { text: format('cpu', stale ? null : row.cpu) }), el('td', { text: format('memory', stale ? null : row.memory) }),
  el('td', { text: `${format('received', stale ? null : row.received)} / ${format('sent', stale ? null : row.sent)}` })))));
  status.textContent = snapshot.error ? `采样中断：${snapshot.error}` : current?.processError || current?.networkError ||
    (!current ? '正在采集…' : !rows.length ? '没有运行中的插件后台' : displayed.cpu === null ? '正在建立采样基线…' :
      `每 ${snapshot.settings.interval} 秒采样 · ${new Date(current.time).toLocaleTimeString()}`);
  updateDashboard(picker, sorting, cards, table);
}

async function poll() {
  try {
    const snapshot = await invoke('monitor.snapshot');
    if (active) {
      render(snapshot);
    }
  } catch (error) {
    status.textContent = `采样不可用：${error.message}`;
    if (!root.contains(status)) {
      root.append(status);
    }
    send({ type: 'desk:overlay-summary', text: '采样不可用 · 请展开查看' });
  } finally {
    if (active) {
      setTimeout(poll, 1000);
    }
  }
}

window.addEventListener('pagehide', () => { active = false; }, { once: true });
if (location.pathname.endsWith('/settings.html')) {
  showSettings();
} else {
  root.append(status);
  poll();
}
