import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, openConfiguration } from '../../../../desk/test/electron/helpers.js';
import { withPackageSource } from '../../../../desk/src/main/common/plugin-package.js';
import { alive } from '../../../../desk/test/electron/helpers.js';

const owner = 'resource-monitor';
const archive = resolve('plugin-dev/dist/resource-monitor-0.1.2.plg');

// This Playwright version treats an async waitForFunction predicate as immediately truthy.
async function waitFor(page, predicate, argument) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`异步验收条件超时：${predicate.toString()}`);
}

async function install(app, page, source) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, source);
  await page.evaluate(() => workDesk.plugins.install());
}

async function probeSource(data, id) {
  const source = join(data, `source-${id}`);
  await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 2, dataVersion: 1,
    type: 'application', showIcon: true, loadOnStartup: true, background: 'service', main: 'index.mjs',
    views: [{ id: 'main', title: id, entry: 'index.html' }] }));
  await writeFile(join(source, 'index.html'), '<!doctype html><meta charset="UTF-8"><button id="ping">独立插件</button>');
  await writeFile(join(source, 'index.mjs'), `import {spawn} from 'node:child_process';
    import {createServer, get, Agent} from 'node:http';
    let child,server,timer,load,agent;
    const memory=Buffer.alloc(16*1024*1024,1);
    export async function activate(c) {
      child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      c.ownProcesses([child.pid]);
      c.methods.register('probe.info',()=>({pid:process.pid,child:child.pid,bytes:memory.length}));
      c.methods.register('probe.crash',()=>{process.exit(1)});
      server=createServer((req,res)=>res.end(memory.subarray(0,128*1024)));
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      agent=new Agent({keepAlive:true});
      timer=setInterval(()=>get({host:'127.0.0.1',port:server.address().port,agent},res=>res.resume()).on('error',()=>{}),100);
      load=setInterval(()=>{const until=performance.now()+30;while(performance.now()<until){Math.sqrt(Math.random())}},100);
      c.lifecycle.register({snapshot:()=>[],stop:async()=>{clearInterval(timer);clearInterval(load);agent.destroy();server.close();}});
    }
    export function deactivate(){clearInterval(timer);clearInterval(load);agent?.destroy();server?.close();}`);
  return source;
}

test('empty host and isolated plugin crashes keep siblings usable; monitoring stop never kills observed processes',
  { timeout: 120000 }, async t => {
    const { page, app, data } = await launch(t, { openPlugin: false,
      prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
    assert.deepEqual(await page.evaluate(() => workDesk.plugins.list()), []);
    assert.equal(await page.locator('iframe').count(), 0);
    await openConfiguration(page);
    await page.getByRole('button', { name: '关闭配置', exact: true }).click();
    for (const id of ['probe-one', 'probe-two']) {
      await install(app, page, await probeSource(data, id));
    }
    await install(app, page, archive);
    await waitFor(page, async id => {
      const snapshot = await workDesk.plugins.invoke(id, 'monitor.snapshot', []);
      const row = snapshot.latest?.rows.find(row => row.pluginId === 'probe-one');
      return row?.cpu > 0 && row?.memory > 16 * 1024 * 1024 && row?.received > 0 && row?.sent > 0;
    }, owner);
    const [one, two] = await page.evaluate(() => Promise.all(['probe-one', 'probe-two'].map(id =>
      workDesk.plugins.invoke(id, 'probe.info', []))));
    await page.locator('.shelf-app[data-plugin="probe-two"]').click();
    await page.frameLocator('.application-window iframe').locator('#ping').click();
    await assert.rejects(page.evaluate(() => workDesk.plugins.invoke('probe-one', 'probe.crash', [])), /插件/);
    await waitFor(page, async () => (await workDesk.plugins.list()).find(p => p.id === 'probe-one').state === 'disabled');
    await waitFor(page, async id => !(await workDesk.plugins.invoke(id, 'monitor.snapshot', [])).latest?.rows
      .some(row => row.pluginId === 'probe-one'), owner);
    assert.equal(alive(two.pid), true);
    assert.equal(alive(two.child), true);
    for (let i = 0; i < 40 && alive(one.child); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(alive(one.child), false);
    // Kill only the monitor's sandbox renderer, discovered from its current frame identity.
    const pids = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0].webContents.mainFrame;
      return { host: main.osProcessId, view: main.framesInSubtree.find(frame =>
        frame.url.startsWith('desk-plugin://resource-monitor/')).osProcessId };
    });
    assert.notEqual(pids.host, pids.view);
    process.kill(pids.view, 'SIGKILL');
    // Playwright reports an OOPIF failure as a page crash; Electron still addresses the surviving host.
    const host = source => app.evaluate(({ BrowserWindow }, source) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), source);
    const waitHost = async source => {
      for (let i = 0; i < 100; i++) {
        if (await host(source)) {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error(`宿主状态等待超时：${source}`);
    };
    await waitHost('!document.querySelector(".plugin-overlay")');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed()), false);
    const siblingView = await app.evaluate(async ({ BrowserWindow }) => {
      const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find(frame =>
        frame.url.startsWith('desk-plugin://probe-two/'));
      return frame.executeJavaScript('document.querySelector("#ping").click(); document.querySelector("#ping").textContent');
    });
    assert.equal(siblingView, '独立插件');
    assert.ok((await host('workDesk.plugins.invoke("resource-monitor","monitor.snapshot",[])')).running);
    await host('document.querySelector(".shelf-app[data-plugin=resource-monitor]").click()');
    await waitHost('Boolean(document.querySelector(".plugin-overlay"))');
    await host('(async()=>{const p=await workDesk.plugins.preview("resource-monitor","disable");await workDesk.plugins.disable("resource-monitor",p.confirmationToken)})()');
    await waitHost('!document.querySelector(".plugin-overlay")');
    assert.equal(alive(two.pid), true);
    assert.equal(alive(two.child), true);
    assert.equal((await host('workDesk.plugins.invoke("probe-two","probe.info",[])')).pid, two.pid);
    await host('workDesk.plugins.enable("resource-monitor")');
    await waitHost('Boolean(document.querySelector(".plugin-overlay"))');
  });

test('packaged monitor samples plugins, retains collapsed views, settings and data through reinstall', { timeout: 120000 }, async t => {
  const { page, app, data } = await launch(t, { openPlugin: false, prepareData: async data => {
    await writeFile(join(data, 'plugins.json'), '[]');
    await mkdir(join(data, 'plugins', owner), { recursive: true });
    await withPackageSource(archive, source => cp(source, join(data, 'plugins', owner), { recursive: true }));
  } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const overlay = page.locator('.plugin-overlay');
  await overlay.waitFor();
  const frame = overlay.frameLocator('iframe');
  await frame.locator('.metrics').waitFor();
  await waitFor(page, async id => {
    const { latest } = await workDesk.plugins.invoke(id, 'monitor.snapshot', []);
    return latest?.rows.some(row => row.pluginId === id && row.cpu !== null && row.memory > 0);
  }, owner);
  const snapshot = await page.evaluate(id => workDesk.plugins.invoke(id, 'monitor.snapshot', []), owner);
  assert.equal(snapshot.latest.processError, null);
  assert.equal(snapshot.latest.networkError, null);
  assert.ok(snapshot.history.length >= 2, JSON.stringify({ history: snapshot.history.length, latest: snapshot.latest, error: snapshot.error }));
  await frame.locator('[data-metric=cpu] .metric-value').filter({ hasNotText: '采集中' }).waitFor();
  assert.ok(await frame.locator('svg path').count() >= 4);
  const picker = frame.getByLabel('查看插件');
  const scroll = frame.locator('.table-scroll');
  await scroll.evaluate(node => { node.style.maxHeight = '20px'; node.scrollTop = 10; });
  const scrollTop = await scroll.evaluate(node => node.scrollTop);
  await picker.focus();
  await page.waitForTimeout(2200);
  assert.equal(await picker.evaluate(node => node === document.activeElement), true, 'polling must retain keyboard focus');
  assert.equal(await scroll.evaluate(node => node.scrollTop), scrollTop, 'polling must retain list scroll');
  await scroll.evaluate(node => { node.style.maxHeight = ''; node.scrollTop = 0; });
  await overlay.screenshot({ path: resolve('.test-results/resource-monitor-overlay.png') });
  await overlay.getByRole('button', { name: '收起悬浮面板', exact: true }).click();
  assert.equal(Math.round((await overlay.boundingBox()).height), 36);
  const prior = snapshot.latest.time;
  await waitFor(page, async ({ id, time }) => (await workDesk.plugins.invoke(id, 'monitor.snapshot', [])).latest.time > time,
    { id: owner, time: prior });
  await overlay.locator('.overlay-summary').filter({ hasText: 'CPU' }).waitFor();
  await overlay.screenshot({ path: resolve('.test-results/resource-monitor-bar.png') });
  await overlay.getByRole('button', { name: '展开悬浮面板', exact: true }).click();
  assert.equal(await overlay.getByRole('button', { name: '在窗口中打开', exact: true }).count(), 0);
  await frame.locator('body').evaluate(node => { node.dataset.retained = 'monitor'; });
  await page.locator('.shelf-app[data-plugin="resource-monitor"]').click();
  await page.locator('.shelf-app[data-plugin="resource-monitor"]').click();
  assert.equal(await page.locator('.plugin-overlay').count(), 1);
  assert.equal(await page.locator('.application-window, .window-tab').count(), 0);
  assert.equal(await frame.locator('body').getAttribute('data-retained'), 'monitor');
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="resource-monitor"]').getByRole('button', { name: /配置/ }).click();
  const settingsFrame = page.frameLocator('.plugin-settings-content iframe');
  await settingsFrame.getByLabel('采样间隔').selectOption('5');
  await settingsFrame.getByLabel('默认收起为横条').check();
  await settingsFrame.getByRole('button', { name: '保存设置', exact: true }).click();
  await settingsFrame.getByText('已保存', { exact: true }).waitFor();
  await page.locator('.plugin-settings').screenshot({ path: resolve('.test-results/resource-monitor-settings.png') });
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugin-data', owner, 'settings.json'), 'utf8')),
    { interval: 5, defaultCollapsed: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => { await workDesk.storage.savePreferences({ theme }); }, theme);
    await page.reload();
    await page.locator('.plugin-overlay').waitFor();
    const actual = await page.frameLocator('.plugin-overlay iframe').locator('html').getAttribute('data-theme');
    assert.equal(actual, theme);
  }
  await page.evaluate(async id => {
    const preview = await workDesk.plugins.preview(id, 'remove');
    await workDesk.plugins.remove(id, 'keep', preview.confirmationToken);
  }, owner);
  await overlay.waitFor({ state: 'detached' });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, archive);
  await page.evaluate(() => workDesk.plugins.install());
  await page.locator('.plugin-overlay[data-collapsed=false]').waitFor();
  await page.evaluate(() => localStorage.removeItem('plugin-overlay:resource-monitor:main'));
  await page.reload();
  await page.locator('.plugin-overlay[data-collapsed=true]').waitFor();
  assert.deepEqual(await page.evaluate(id => workDesk.plugins.invoke(id, 'monitor.settings', []), owner),
    { interval: 5, defaultCollapsed: true });
  await page.evaluate(async id => {
    const preview = await workDesk.plugins.preview(id, 'close');
    await workDesk.plugins.close(id, preview.confirmationToken);
  }, owner);
  await overlay.waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('.shelf-app').waitFor();
  assert.equal(await overlay.count(), 0);
  await page.locator('.shelf-app').click();
  await overlay.waitFor();
  assert.deepEqual(errors, []);
});


test('monitor explanations appear only on help hover or keyboard focus', { timeout: 60000 }, async t => {
  const { page } = await launch(t, { openPlugin: false, prepareData: async data => {
    await writeFile(join(data, 'plugins.json'), '[]');
    await mkdir(join(data, 'plugins', owner), { recursive: true });
    await withPackageSource(archive, source => cp(source, join(data, 'plugins', owner), { recursive: true }));
  } });
  const overlay = page.locator('.plugin-overlay');
  const frame = overlay.frameLocator('iframe');
  const help = frame.getByRole('button', { name: '统计口径说明', exact: true });
  await help.waitFor();
  const tooltip = frame.locator('#metrics-help');
  assert.equal(await tooltip.isVisible(), false);
  await help.hover();
  await tooltip.waitFor({ state: 'visible' });
  assert.match(await tooltip.textContent(), /CPU.*RSS/);
  assert.equal(await help.locator('svg').count(), 1);
  const bounds = await tooltip.boundingBox();
  const panel = await overlay.boundingBox();
  assert.ok(bounds.x >= panel.x && bounds.x + bounds.width <= panel.x + panel.width, 'tooltip must fit within the panel');
  await frame.getByLabel('查看插件').hover();
  await tooltip.waitFor({ state: 'hidden' });
  await help.focus();
  await tooltip.waitFor({ state: 'visible' });
  await page.waitForTimeout(2200);
  assert.equal(await help.evaluate(node => node === document.activeElement), true, 'sampling must retain help focus');
  assert.equal(await tooltip.isVisible(), true);
  await mkdir('.test-results', { recursive: true });
  await overlay.screenshot({ path: resolve('.test-results/resource-monitor-help.png') });
  await openConfiguration(page);
  await page.locator('.plugin-card[data-plugin="resource-monitor"]').getByRole('button', { name: /配置/ }).click();
  const settings = page.frameLocator('.plugin-settings-content iframe');
  const settingsHelp = settings.getByRole('button', { name: '收起状态说明', exact: true });
  await settingsHelp.waitFor();
  assert.equal(await settings.locator('#collapse-help').isVisible(), false);
  await settingsHelp.hover();
  await settings.locator('#collapse-help').waitFor({ state: 'visible' });
  assert.equal(await settings.getByRole('button', { name: '保存设置', exact: true }).isVisible(), true);
});
