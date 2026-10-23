const { app, BrowserWindow, protocol } = require('electron');
const { join } = require('node:path');

app.setPath('userData', process.argv.find(arg => arg.startsWith('--test-data=')).slice(12));
protocol.registerSchemesAsPrivileged([{ scheme: 'desk-plugin', privileges: { standard: true, secure: true } }]);

// Exercise the actual desktop renderer without discovering or starting business plugins.
app.whenReady().then(async () => {
  protocol.handle('desk-plugin', () => new Response('<!doctype html><meta charset="UTF-8"><h1>桌面契约测试页面</h1>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const window = new BrowserWindow({ width: 1200, height: 800,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  await window.loadFile(join(__dirname, '../../../dist/renderer/index.html'));
});
app.on('window-all-closed', () => app.quit());
