import '../../../../desk/src/resource/controls.css';
import './workspace.css';
import { mountSettings } from './settings.js';
import { mountAppearance } from './appearance.js';
const disposeAppearance = mountAppearance();
const root = document.querySelector('main');
const controls = mountSettings(root);
window.addEventListener('pagehide', () => {
  controls.dispose();
  disposeAppearance();
}, { once: true });
