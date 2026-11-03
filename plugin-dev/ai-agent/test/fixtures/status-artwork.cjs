const { app, BrowserWindow } = require('electron');

const fixture = process.argv.find(arg => arg.startsWith('--fixture=')).slice(10);
app.setPath('userData', `${fixture}/data`);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 880, height: 660, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadFile(`${fixture}/index.html`);
});
app.on('window-all-closed', () => app.quit());
