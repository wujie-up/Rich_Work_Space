const { app, BrowserWindow, protocol, net } = require('electron');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

app.setPath('userData', process.argv.find(arg => arg.startsWith('--test-data=')).slice(12));
protocol.registerSchemesAsPrivileged(['desk-host', 'desk-plugin'].map(scheme => ({
  scheme, privileges: { standard: true, secure: true }
})));

// Use the built plugin view with deterministic samples, independently of live plugins and host installation locks.
app.whenReady().then(async () => {
  protocol.handle('desk-plugin', request => net.fetch(pathToFileURL(resolve('plugin-dev/resource-monitor',
    new URL(request.url).pathname.slice(1))).href));
  protocol.handle('desk-host', () => new Response(`<!doctype html><meta charset="UTF-8">
    <style>html,body{height:100%;margin:0;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
    <iframe src="desk-plugin://resource-monitor/dist/renderer/index.html" sandbox="allow-scripts allow-same-origin"></iframe>
    <script>
      const settings = { interval: 2, defaultCollapsed: false };
      window.addEventListener('message', event => {
        const { type, id, method, args } = event.data;
        if (type !== 'desk:invoke') { return; }
        let value = { theme: 'light' };
        if (method === 'plugin.invoke') {
          value = settings;
          if (args[0] === 'monitor.saveSettings') { Object.assign(settings, args[1]); }
          if (args[0] === 'monitor.snapshot') {
            const total = { cpu: 3.8, memory: 485280973, received: 42700, sent: 7885 };
            const latest = { time: Date.now(), total, rows: Array.from({ length: 14 }, (_, i) => ({
              ...total, pluginId: 'plugin-' + i, name: '监控插件 ' + (i + 1), processCount: 1
            })) };
            value = { settings, latest, history: [latest], error: null };
          }
        }
        event.source.postMessage({ type: 'desk:result', id, value }, event.origin);
      });
    </script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const window = new BrowserWindow({ width: 520, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('desk-host://desktop/index.html');
});
app.on('window-all-closed', () => app.quit());
