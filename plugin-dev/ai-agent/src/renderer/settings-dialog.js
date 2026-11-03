import { mountSettings } from './settings.js';
import { modal, iconButton } from './ui.js';
import './settings-dialog.css';

export function showSettings(options) {
  return modal('CLI 配置', ({ body, actions, finish, dialog }) => {
    dialog.classList.add('configuration-dialog');
    const controls = mountSettings(body, options);
    dialog.addEventListener('close', () => controls.dispose(), { once: true });
    actions.append(iconButton('完成', 'check', () => finish(true), 'primary'));
  }, { placement: 'center' });
}
