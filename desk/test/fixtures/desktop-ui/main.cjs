const { app, BrowserWindow, protocol, net } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

app.setPath('userData', process.argv.find(arg => arg.startsWith('--test-data=')).slice(12));
protocol.registerSchemesAsPrivileged(['desk-plugin', 'desk-host'].map(scheme => ({ scheme, privileges: { standard: true, secure: true } })));

// Exercise the actual desktop renderer without discovering or starting business plugins.
app.whenReady().then(async () => {
  protocol.handle('desk-host', request => new URL(request.url).pathname.startsWith('/plugin-icons/') ? new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 5h16v14H4Z" fill="none" stroke="gray"/></svg>',
    { headers: { 'Content-Type': 'image/svg+xml' } })
    : net.fetch(pathToFileURL(join(__dirname, '../../../dist/renderer', new URL(request.url).pathname.slice(1))).href));
  protocol.handle('desk-plugin', request => new Response(new URL(request.url).pathname === '/settings.html'
    ? `<!doctype html><meta charset="UTF-8"><input aria-label="测试配置"><script>
      window.addEventListener('message', event => {
        if (event.data.type === 'desk:result') document.body.dataset.result = JSON.stringify(event.data);
      });
      parent.postMessage({ type: 'desk:invoke', id: 'settings-probe', method: 'plugin.invoke', args: ['settings.read'] }, '*');
      </script>`
    : `<!doctype html><meta charset="UTF-8"><h1>桌面契约测试页面</h1><script>
      parent.postMessage({type:'desk:overlay-summary',text:'CPU 12%  内存 40 MB'}, 'desk-host://desktop');
      </script>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const { windowOptions } = await import('../../../src/main/os/index.js');
  const window = new BrowserWindow({ width: 1200, height: 800, ...windowOptions,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  await window.loadURL('desk-host://desktop/index.html');
});
app.on('window-all-closed', () => app.quit());
