import { el } from './ui.js';
import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';

// Lock this frame only; desktop navigation and other plugins remain available during recovery.
export function showRestoreProgress() {
  const previous = document.activeElement;
  const outside = [...document.body.children];
  const inert = outside.map(node => node.inert);
  outside.forEach(node => { node.inert = true; });
  const percent = el('span', { class: 'restore-percent', text: '0' });
  const count = el('div', { class: 'restore-count', text: '0 / 0' });
  const name = el('div', { class: 'restore-current', text: '正在准备恢复' });
  const ring = el('div', { class: 'restore-ring', role: 'progressbar', 'aria-label': '会话恢复进度',
    'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 },
    el('div', { class: 'restore-numbers' }, el('div', {}, percent, el('small', { text: '%' })), count));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('aria-hidden', 'true');
  for (const className of ['restore-track', 'restore-fill']) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    for (const [key, value] of Object.entries({ cx: 60, cy: 60, r: 54, pathLength: 100, class: className })) {
      circle.setAttribute(key, value);
    }
    svg.append(circle);
  }
  ring.prepend(svg);
  const dialog = el('dialog', { id: 'restore-progress', class: 'restore-progress', 'aria-label': '正在恢复会话', 'aria-busy': 'true' }, ring, name);
  dialog.addEventListener('cancel', event => event.preventDefault());
  document.body.append(dialog);
  showPopup(dialog, document.body, { placement: 'center' });
  // This read-only indicator has no control to focus; the shared popup still blocks dismissal.
  dialog.blur();
  return {
    update({ completed, total, current }) {
      const value = total ? Math.floor(completed / total * 100) : 0;
      percent.textContent = value;
      count.textContent = `${completed} / ${total}`;
      ring.style.setProperty('--restore-progress', value);
      ring.setAttribute('aria-valuenow', value);
      name.textContent = current ? `正在恢复「${current.name}」` : '正在准备恢复';
    },
    async finish() {
      // Leave the last segment visible before unlocking, including when the final engine starts immediately.
      if (ring.getAttribute('aria-valuenow') === '100') {
        await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240));
      }
    },
    close() {
      closePopup(dialog);
      dialog.remove();
      outside.forEach((node, index) => { node.inert = inert[index]; });
      if (previous?.isConnected) { previous.focus(); }
    }
  };
}
