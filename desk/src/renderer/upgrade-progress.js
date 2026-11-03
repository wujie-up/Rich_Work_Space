import { el } from './ui.js';
import './upgrade-progress.css';

// Native modality also blocks retained plugin frames and controls added during list refreshes.
export async function withUpgradeProgress(id, version, action) {
  const previous = document.activeElement;
  const ring = el('div', { class: 'upgrade-ring', role: 'progressbar',
    'aria-label-message': version ? ['正在升级 {name} 到 v{version}', { name: id, version }] : '正在升级全部插件' },
    el('span', { class: 'upgrade-label', message: '正在升级' }));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('aria-hidden', 'true');
  for (const className of ['upgrade-track', 'upgrade-fill']) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    for (const [key, value] of Object.entries({ cx: 60, cy: 60, r: 54, pathLength: 100, class: className })) {
      circle.setAttribute(key, value);
    }
    svg.append(circle);
  }
  ring.prepend(svg);
  const dialog = el('dialog', { id: 'plugin-upgrade-progress', class: 'upgrade-progress', 'aria-label-message': '正在升级插件', 'aria-busy': 'true' }, ring);
  dialog.addEventListener('cancel', event => event.preventDefault());
  const keyboard = event => {
    event.stopImmediatePropagation();
    if (event.key !== 'Tab') {
      event.preventDefault();
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  // Host shortcuts must not switch pages or create windows behind the read-only progress ring.
  window.addEventListener('keydown', keyboard, true);
  window.addEventListener('keyup', keyboard, true);
  console.info('[plugin:upgrade-start]', { pluginId: id, version });
  try {
    const result = await action();
    console.info('[plugin:upgrade-complete]', { pluginId: id, version });
    return result;
  } catch (error) {
    console.error('[plugin:upgrade-failed]', { pluginId: id, version, stack: error.stack });
    throw error;
  } finally {
    window.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('keyup', keyboard, true);
    dialog.close();
    dialog.remove();
    if (previous?.isConnected) {
      previous.focus();
    }
  }
}
