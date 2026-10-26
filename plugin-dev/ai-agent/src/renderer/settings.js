import './conversation.css';
import { engineSettings } from './engine-settings.js';
const onError = error => { document.getElementById('notice').textContent = error.message; };
await engineSettings({ onError }).refresh().catch(onError);
