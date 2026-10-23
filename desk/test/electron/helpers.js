import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
export async function launch(t, { executablePath = require('electron'), reducedPath = false, openPlugin = true } = {}) {
  const data = await mkdtemp(join(tmpdir(), 'Work Desk 中文 '));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (reducedPath) { env.PATH = '/usr/bin:/bin'; }
  const packaged = !executablePath.includes('node_modules');
  const app = await electron.launch({ executablePath, args: [...(packaged ? [] : [resolve('.')]), `--desk-data=${data}`], env, timeout: 60000 });
  const hostProcess = app.process();
  t.after(async () => {
    // A preview/quit failure must not leave another Dock instance behind after the test ends.
    const watchdog = setTimeout(() => {
      if (hostProcess.exitCode === null) {
        hostProcess.kill('SIGKILL');
      }
    }, 5000);
    try {
      await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window && !window.webContents.isCrashed()) {
          await window.webContents.executeJavaScript(`(async () => {
            for (const plugin of await workDesk.plugins.list()) {
              if (plugin.state === 'enabled' && !plugin.operation) {
                const preview = await workDesk.plugins.preview(plugin.id, 'disable');
                await workDesk.plugins.disable(plugin.id, preview.confirmationToken);
              }
            }
          })()`);
        }
      });
    } catch {}
    await app.close().catch(() => hostProcess.kill('SIGKILL'));
    clearTimeout(watchdog);
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const logs = [];
  app.process().stdout?.on('data', (d) => logs.push(d.toString()));
  app.process().stderr?.on('data', (d) => logs.push(d.toString()));
  let page = await app.firstWindow();
  await page.addInitScript(() => {
    const methods = (group, names) => Object.fromEntries(names.map((name) => [name,
      (id, ...args) => window.workDesk.plugins.invoke(id, `${group}.${name}`, args)]));
    // Test driver for the public generic bridge, not part of the desktop's production API.
    window.agentDesk = {
      sessions: methods('sessions', ['list', 'create', 'write', 'resize', 'rename', 'archive', 'attach', 'readArchive',
        'restore', 'fork', 'deleteArchive', 'gitInfo', 'switchBranch']),
      storage: methods('storage', ['getLayout', 'saveLayout', 'getAdapterConfig', 'saveAdapterConfig'])
    };
  });
  await page.reload();
  await page.waitForSelector('.shelf-app');
  if (openPlugin) {
    await openWorkspace(page);
  }
  return { app, page, data, logs };
}
export const owner = 'ai-agent-sessions';
export async function configure(page, { child = false } = {}) {
  await page.evaluate(async ({ owner, command, args }) => {
    await window.agentDesk.storage.saveAdapterConfig(owner, { custom: { command, args } });
  }, { owner, command: process.execPath, args: [resolve('desk/test/fixtures/pty-cli.cjs'), ...(child ? ['--child'] : [])] });
}
export async function create(page, name = '测试终端', id = owner) {
  return page.evaluate(({ id, name, cwd }) => window.agentDesk.sessions.create(id, { adapterId: 'custom', name, cwd }),
    { id, name, cwd: resolve('.') });
}
export async function output(page, id, text, pluginId = owner) {
  const deadline = Date.now() + 15000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(({ pluginId, id }) => agentDesk.sessions.attach(pluginId, id), { pluginId, id });
    if (text instanceof RegExp ? text.test(snapshot.data) : snapshot.data.includes(text)) {
      return snapshot;
    }
    await delay(50);
  }
  throw Error(`Output not observed: ${text}; actual ${JSON.stringify(snapshot?.data)}`);
}
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function openWorkspace(page, id = owner) {
  if (await page.locator('#desktop').isVisible()) {
    await page.locator('#desktop').click();
  }
  const running = page.locator(`.session-bubble[data-plugin="${id}"]`).first();
  if (await running.count()) {
    await running.click();
  } else {
    await page.locator(`.shelf-app[data-plugin="${id}"]`).click();
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.application-window')].every((node) => ['open', 'minimized'].includes(node.dataset.phase)));
  await page.frameLocator('iframe.plugin-view:visible').locator('h1, .workspace-tools').waitFor();
  return page.frameLocator('iframe.plugin-view:visible');
}

export async function openConfiguration(page) {
  await page.locator('.desktop-surface').dispatchEvent('contextmenu', { clientX: 500, clientY: 300 });
  await page.getByRole('menuitem', { name: '添加插件', exact: true }).click();
  await page.getByRole('heading', { name: '插件中心', exact: true }).waitFor();
}

export async function toggleTheme(page) {
  await openConfiguration(page);
  await page.locator('#theme-settings').click();
  await page.locator('#theme').click();
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
}
