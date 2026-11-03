import { join } from 'node:path';
import { createBrowserPlatform } from '../os/index.js';
import { BrowserSession } from './browser.js';
import { EngineStore } from './engine.js';
import { browserResource, registerCapabilities } from './capabilities.js';

let session;
let store;
let stopped = true;

export async function activate(context) {
  stopped = false;
  const root = await context.storage.path(`plugin-data/${context.pluginId}`);
  // Initialize Playwright's registry against this plugin's engine space, never the user's shared cache.
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, 'engines');
  const { chromium } = await import('playwright-core');
  const platform = createBrowserPlatform({ ownProcesses: pids => context.ownProcesses(pids) });
  store = new EngineStore({ root, platform, chromium });
  session = new BrowserSession({ root: join(root, 'browsers', (await store.settings()).engine),
    platform, chromium, executable: await store.executable() });
  const getSession = async () => {
    if (stopped) {
      throw Error('浏览器插件已停止');
    }
    return session;
  };
  const status = async () => ({ ...await store.status(), running: Boolean(session?.process),
    tabs: session ? await session.tabs() : [] });
  // RPC and Agent capabilities must acquire the same host lock through an engine switch.
  const operationOptions = { resource: () => browserResource, resourceExclusive: true };
  context.methods.register('browser.status', status);
  context.methods.register('browser.settings', async input => {
    await session?.close();
    const status = await store.save(input);
    // Separate profiles avoid downgrading a Chrome profile with the pinned Chromium version.
    session.root = join(root, 'browsers', status.engine);
    session.executable = await store.executable();
    return status;
  }, { ...operationOptions, exclusive: true });
  context.methods.register('browser.install', () => store.install(), { ...operationOptions, nativeOnly: true, exclusive: true });
  context.methods.register('browser.open', async input => {
    if (!(await store.status()).ready) {
      throw Error('请先安装 Chromium，或明确选择本机 Chrome');
    }
    return (await getSession()).act({ steps: [{ op: 'open', url: input.url }] });
  }, operationOptions);
  context.methods.register('browser.openHtml', async input => {
    if (!(await store.status()).ready) {
      throw Error('请先安装 Chromium，或明确选择本机 Chrome');
    }
    return (await getSession()).openHtml(input);
  }, { ...operationOptions, nativeOnly: true });
  context.methods.register('browser.focus', async tabId => (await getSession()).act({ tabId, steps: [{ op: 'focus' }] }), operationOptions);
  context.methods.register('browser.close', async () => { await session?.close(); return status(); }, { ...operationOptions, exclusive: true });
  await registerCapabilities(context, getSession);
  context.lifecycle.register({
    snapshot: () => [
      ...(session?.process ? [{ id: 'browser', name: 'AI 浏览器窗口', state: 'running' }] : []),
      ...(store.installation.state === 'running' ? [{ id: 'engine-install', name: 'Chromium 安装', state: 'running' }] : [])
    ],
    stop: deactivate
  });
}

export async function deactivate() {
  stopped = true;
  await store?.stop();
  await session?.close();
  session = null;
  store = null;
}
