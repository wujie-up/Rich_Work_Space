import { pluginIdentity } from '../../../../desk/src/resource/plugin-host.js';
import { conversationApi } from './api.js';
import { appearanceSettings, DEFAULT_FONT_SIZE, FONT_SIZES } from '../shared/appearance.js';

export const FONT_SIZE_EVENT = 'agent-font-size';
export const currentFontSize = () => Number.parseInt(document.documentElement.style.getPropertyValue('--agent-font-size'), 10)
  || DEFAULT_FONT_SIZE;

function applyAppearance(value) {
  const settings = appearanceSettings(value);
  document.documentElement.style.setProperty('--agent-font-size', `${settings.fontSize}px`);
  window.dispatchEvent(new CustomEvent(FONT_SIZE_EVENT, { detail: settings.fontSize }));
}

// A late initial read must not replace a newer preference broadcast or a local save.
export function mountAppearance() {
  let revision = 0;
  const changed = () => { revision++; };
  window.addEventListener(FONT_SIZE_EVENT, changed);
  const apply = value => {
    try {
      applyAppearance(value);
    } catch (error) {
      console.error('[ai:appearance-apply]', { pluginId: pluginIdentity() }, error);
      applyAppearance({ fontSize: DEFAULT_FONT_SIZE });
    }
  };
  const off = conversationApi.onAppearance(apply);
  const initialRevision = revision;
  conversationApi.call('appearance.get').then(value => {
    if (revision === initialRevision) { apply(value); }
  }).catch(error => {
    console.error('[ai:appearance-load]', { pluginId: pluginIdentity() }, error);
    if (revision === initialRevision) { apply({ fontSize: DEFAULT_FONT_SIZE }); }
  });
  return () => {
    revision++;
    off();
    window.removeEventListener(FONT_SIZE_EVENT, changed);
  };
}

export function mountFontSizeSetting(root) {
  const select = root.querySelector('#conversation-font-size');
  select.replaceChildren(...FONT_SIZES.map(size => new Option(`${size} px`, String(size))));
  const refresh = () => { select.value = String(currentFontSize()); };
  refresh();
  window.addEventListener(FONT_SIZE_EVENT, refresh);
  select.onchange = async () => {
    const restoreFocus = document.activeElement === select;
    select.disabled = true;
    root.querySelector('#notice').textContent = '';
    try {
      applyAppearance(await conversationApi.call('appearance.save', { fontSize: Number(select.value) }));
    } catch (error) {
      refresh();
      root.querySelector('#notice').textContent = error.message;
      console.error('[ai:appearance-save]', { pluginId: pluginIdentity() }, error);
    } finally {
      select.disabled = false;
      if (restoreFocus && select.isConnected && document.activeElement === document.body) {
        select.focus({ preventScroll: true });
      }
    }
  };
  return () => {
    select.onchange = null;
    window.removeEventListener(FONT_SIZE_EVENT, refresh);
  };
}
