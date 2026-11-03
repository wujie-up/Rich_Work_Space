import { SettingsStore } from './settings.js';
import { QueryJobs } from './jobs.js';
import { BrowserSession } from './browser-session.js';
import { ExtensionSession } from './extension-session.js';
import { WebClient } from './web-client.js';
import { PingCodeClient } from './client.js';
import { createBrowserPlatform } from '../os/index.js';
import { join } from 'node:path';

let jobs;
let browser;
let extension;
let stopped = true;

export async function activate(context) {
  stopped = false;
  const root = await context.storage.path(`plugin-data/${context.pluginId}`);
  const store = new SettingsStore(root);
  browser = new BrowserSession({ root: join(root, 'browser'), platform: createBrowserPlatform({
    ownProcesses: pids => context.ownProcesses(pids) }) });
  extension = new ExtensionSession({ root });
  const sessionFor = config => config.webMode === 'window' ? browser : extension;
  const prepare = async config => {
    if (stopped) { throw Error('插件已停止'); }
    if (config.authMode === 'web' && config.webMode !== 'window') {
      await extension.start(config.site);
    }
  };
  const version = config => config.authMode === 'web' ? `${config.revision}:${sessionFor(config).status().epoch}` : config.revision;
  const readSettings = async () => {
    const config = await store.read();
    let sessionError;
    try { await prepare(config); } catch (error) { sessionError = error.message; }
    return { ...config, revision: version(config), webSession: sessionError
      ? { ...sessionFor(config).status(), state: 'error', error: sessionError } : sessionFor(config).status() };
  };
  jobs = new QueryJobs({ snapshot: async () => {
    const config = await store.snapshot();
    await prepare(config);
    return { ...config, revision: version(config) };
  } }, { clientFactory: config => config.authMode === 'web' ? new WebClient(config, sessionFor(config)) : new PingCodeClient(config) });
  context.methods.register('pingcode.settings', readSettings);
  context.methods.register('pingcode.saveSettings', async change => {
    const before = await store.snapshot();
    await store.save(change);
    const after = await store.snapshot();
    if (after.site !== before.site || after.authMode !== before.authMode || after.webMode !== before.webMode) {
      jobs.cancelAll();
      await browser.close();
      await extension.stop();
    }
    return readSettings();
  }, { exclusive: true });
  context.methods.register('pingcode.login', async () => {
    const config = await store.snapshot();
    if (stopped) { throw Error('插件已停止'); }
    if (config.authMode !== 'web') {
      throw Error('请先保存网页登录模式，再打开登录窗口');
    }
    return sessionFor(config).open(config.site);
  });
  context.methods.register('pingcode.session', async () => sessionFor(await store.snapshot()).status());
  context.methods.register('pingcode.checkLogin', async () => sessionFor(await store.snapshot()).check());
  context.methods.register('pingcode.logout', async () => {
    jobs.cancelAll();
    const config = await store.snapshot();
    if (config.webMode === 'window') {
      await browser.close({ logout: true });
    } else {
      await extension.disconnect();
    }
    return sessionFor(config).status();
  });
  context.methods.register('pingcode.start', input => jobs.start(input));
  context.methods.register('pingcode.status', id => jobs.status(id));
  context.methods.register('pingcode.cancel', id => jobs.cancel(id));
  context.lifecycle.register({ snapshot: () => [
    ...[...jobs.jobs.values()].filter(job => job.state === 'running').map(job => ({ id: job.id, name: 'PingCode 查询', state: 'running' })),
    ...(browser.process ? [{ id: 'login-browser', name: 'PingCode 登录窗口', state: 'running' }] : [])
  ], stop: async () => { stopped = true; await jobs.stop(); await browser.close(); await extension.stop(); } });
}

export async function deactivate() {
  stopped = true;
  await jobs?.stop();
  await browser?.close();
  await extension?.stop();
  jobs = null;
  browser = null;
  extension = null;
}
