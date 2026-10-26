import { cleanApplicationEntries } from './installation.js';
export { loadLoginPath } from './environment.js';
export { stopProcessGroups } from '../posix/processes.js';
// Expose native control bounds so the shared desktop can reserve space without OS branches.
export const windowOptions = { titleBarStyle: 'hiddenInset', titleBarOverlay: { height: 38 } };
export const hideOnClose = true;

// Electron replaces the same-name installation or focuses it if already running; user data lives outside the bundle.
export async function ensureInstallation(app, checkEntries = cleanApplicationEntries) {
  if (!app.isPackaged) {
    return true;
  }
  if (app.isInApplicationsFolder()) {
    await checkEntries().catch(error => console.error('[host:installation-entries]', { message: error.message }));
    return true;
  }
  console.info('[host:install]', { action: 'move-to-applications' });
  if (!app.moveToApplicationsFolder()) {
    throw Error('请将 DeckPg 安装到应用程序目录后再启动。');
  }
  return false;
}
