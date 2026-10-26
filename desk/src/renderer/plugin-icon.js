import { el } from './ui.js';

// Desktop-owned overrides are separate from immutable plugin packages and survive upgrades.
export function pluginIcon(plugin) {
  const image = el('img', { class: 'plugin-icon-image', src: `desk-host://desktop/plugin-icons/${plugin.id}?v=${Date.now()}`,
    alt: '', draggable: false, 'aria-hidden': true });
  image.addEventListener('error', () => { image.hidden = true; }, { once: true });
  return image;
}
