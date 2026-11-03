import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, alive, openWorkspace, toggleTheme } from '../../../../desk/test/electron/helpers.js';

// A packaged host loads only the two current packages and a tiny isolation probe. No real business services are used.
test('current packages contain MCP restarts, owner-only cleanup and plugin failures while retaining history', { timeout: 90000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false,
    prepareData: data => writeFile(join(data, 'plugins.json'), '[]') });
  assert.equal((await page.evaluate(() => workDesk.plugins.list())).filter(plugin => plugin.state === 'enabled').length, 0);
  await page.locator('.desktop-surface').waitFor();
  const oldTheme = await page.locator('html').getAttribute('data-theme');
  await toggleTheme(page);
  assert.notEqual(await page.locator('html').getAttribute('data-theme'), oldTheme);
  const install = async (source, id) => {
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await page.evaluate(() => workDesk.plugins.install());
    await page.evaluate(async id => {
      const plugin = (await workDesk.plugins.list()).find(value => value.id === id);
      if (plugin.state !== 'enabled') { await workDesk.plugins.enable(id); }
    }, id);
  };
  await install(resolve('plugin-dev/dist/mcp-services-0.4.26.plg'), 'mcp-services');
  await install(resolve('plugin-dev/dist/ai-agent-sessions-0.6.62.plg'), 'ai-agent-sessions');
  const invoke = (id, method, args = []) => page.evaluate(({ id, method, args }) => workDesk.plugins.invoke(id, method, args), { id, method, args });
  const selectId = 'ai-agent-sessions';
  const cli = join(data, 'relay-cli.cjs');
  await writeFile(cli, String.raw`const args=process.argv.slice(2);
const address=args.find(v=>/^mcp_servers\.desk_[^.]+\.url=/.test(v));
const header=args.find(v=>/^mcp_servers\.desk_[^.]+\.http_headers=/.test(v));
const url=JSON.parse(address.slice(address.indexOf('=')+1));
const token=JSON.parse(header.slice(header.indexOf('"'),header.lastIndexOf('"')+1));
async function call(text){
 const response=await fetch(url,{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'echo',arguments:{text}}})});
 const value=await response.json();console.log('RESULT='+JSON.stringify(value.result||value.error));
}
console.log('READY '+url);call('before-restart').catch(e=>console.log('FAILED='+e.message));
process.stdin.resume();process.stdin.on('data',()=>call('after-restart').catch(e=>console.log('FAILED='+e.message)));`);
  await invoke('mcp-services', 'mcp.save', [{ id: 'echo', name: 'fixture', transport: 'stdio', command: process.execPath,
    args: [resolve('plugin-dev/mcp/test/fixture.mjs')], env: {} }]);
  await invoke('mcp-services', 'mcp.start', ['echo']);
  await invoke(selectId, 'storage.saveAdapterConfig', [{ codex: { mode: 'legacy', command: process.execPath, args: [cli] } }]);
  const session = await invoke(selectId, 'sessions.create', [{ adapterId: 'codex', mode: 'new', cwd: data, name: '保留历史' }]);
  let output;
  for (let attempt = 0; attempt < 100; attempt++) {
    output = await invoke(selectId, 'sessions.attach', [session.id]);
    if (output.data.includes('/mcp/desk_')) { break; }
    await page.waitForTimeout(20);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    output = await invoke(selectId, 'sessions.attach', [session.id]);
    if (/RESULT=.*before-restart/.test(output.data)) { break; }
    await page.waitForTimeout(20);
  }
  assert.match(output.data, /RESULT=.*before-restart/);
  const url = output.data.match(/READY (http:\/\/127\.0\.0\.1:\d+\/mcp\/desk_[a-z0-9]+)/)?.[1];
  assert.ok(url, output.data);
  assert.equal((await fetch(url)).status, 401);
  await invoke('mcp-services', 'mcp.stop', ['echo']);
  await invoke('mcp-services', 'mcp.start', ['echo']);
  assert.equal(alive(session.pid), true);
  assert.equal((await fetch(url)).status, 401, 'AI relay survives MCP provider restart');
  await invoke(selectId, 'sessions.write', [session.id, 'call\r']);
  for (let attempt = 0; attempt < 100; attempt++) {
    output = await invoke(selectId, 'sessions.attach', [session.id]);
    if (/RESULT=.*after-restart/.test(output.data)) { break; }
    await page.waitForTimeout(20);
  }
  assert.match(output.data, /RESULT=.*after-restart/);
  const probeId = 'relay-isolation-probe';
  const probe = join(data, probeId);
  await mkdir(probe);
  await writeFile(join(probe, 'plugin.json'), JSON.stringify({ id: probeId, name: '隔离夹具', version: '1.0.0', apiVersion: 2,
    dataVersion: 1, type: 'application', showIcon: true, loadOnStartup: false, background: 'service', singleInstance: true,
    main: 'index.mjs', views: [{ id: 'probe', title: '隔离夹具', entry: 'index.html' }], closeDescription: '关闭测试夹具' }));
  await writeFile(join(probe, 'index.mjs'), `export function activate(c){c.methods.register('ping',()=>({pid:process.pid}));
c.views.register({id:'probe',title:'隔离夹具',entry:'index.html'});}export function deactivate(){}`);
  await writeFile(join(probe, 'index.html'), '<!doctype html><h1>probe</h1>');
  await install(probe, probeId);
  const other = await invoke(probeId, 'ping');
  process.kill(other.pid, 'SIGKILL');
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await page.evaluate(async id => (await workDesk.plugins.list()).find(plugin => plugin.id === id), probeId);
    if (state.state === 'disabled' && !state.operation) { break; }
    await page.waitForTimeout(20);
  }
  assert.equal(alive(session.pid), true);
  await invoke(selectId, 'sessions.write', [session.id, 'after-crash\r']);
  await invoke(selectId, 'sessions.archive', [session.id]);
  assert.equal(alive(session.pid), false);
  await assert.rejects(fetch(url));
  const archive = await invoke(selectId, 'sessions.readArchive', [session.id]);
  assert.match(archive.output, /READY/);
  assert.equal(archive.name, '保留历史');
  assert.equal((await invoke('mcp-services', 'mcp.list'))[0].state, 'running');
  await page.evaluate(id => workDesk.plugins.enable(id), probeId);
  page.setDefaultTimeout(5000);
  try { await openWorkspace(page, probeId); } catch (error) {
    await page.screenshot({ path: resolve('.test-results/mcp-reconnect/isolation-failure.png') });
    throw error;
  }
  const renderer = await app.evaluate(({ BrowserWindow }, id) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return { host: contents.getOSProcessId(), plugin: contents.mainFrame.frames
      .find(frame => frame.url.startsWith(`desk-plugin://${id}/`)).osProcessId };
  }, probeId);
  assert.notEqual(renderer.host, renderer.plugin);
  process.kill(renderer.plugin, 'SIGKILL');
  const hostState = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return { crashed: contents.isCrashed(), pid: contents.getOSProcessId() };
  });
  assert.deepEqual(hostState, { crashed: false, pid: renderer.host });
  const healthy = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
    "workDesk.plugins.invoke('mcp-services','mcp.list',[])"));
  assert.equal(healthy[0].state, 'running');
});
