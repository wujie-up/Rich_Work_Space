import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';
import { Sessions } from '../src/main/common/sessions.js';
import { Conversations } from '../src/main/common/conversations.js';

test('reconnect controls support light/dark, narrow/tiled layouts, keyboard and retained drafts', { timeout: 60000 }, async t => {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const owner = 'localhost';
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_id, work) => work(),
    processControl: async session => session.terminal.kill(), adapter: () => ({ capabilities: { restore: true },
      buildLaunch: () => ({ command: 'fixture', args: [], env: {} }), resolveContext: async session => session.contextId }) });
  const terminal = await sessions.create(owner, { adapterId: 'codex', cwd: storage.root, contextId: 'native-context', name: '数据库查询' });
  sessions.get(owner, terminal.id).activity = 'idle';
  t.after(() => sessions.stopAndArchive(owner, 'quit'));
  const engines = [{ id: 'codex', name: 'Codex', state: 'ready', pin: { version: 'fixture' } }];
  const conversations = new Conversations({ storage, pluginId: owner, runtime: { launch: async () => ({
    runtimeId: 'fixture', profileId: 'default', args: [], env: {}, launchSettings: {} }) },
    Engine: class {
      constructor(options) { Object.assign(this, options); }
      async start() {}
      async request(method) { return method === 'thread/start' ? { thread: { id: 'native-thread' } } : {}; }
      close() {}
    }, createGateway: () => ({ url: 'http://localhost/fixture', token: 'fixture', start: async () => {}, close: async () => {},
      refreshCatalog: async () => false }), emit: () => {}, ownProcesses: () => {} });
  await conversations.load();
  await conversations.create({ cwd: storage.root });
  t.after(() => conversations.stop());
  const calls = [];
  let bundles = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/rpc') {
      let body = ''; for await (const chunk of request) { body += chunk; }
      const { method, args } = JSON.parse(body);
      calls.push(method);
      try {
        let value;
        if (method === 'storage.getPreferences') { value = { theme: 'light' }; }
        else if (method === 'host.getWindowContext') { value = { id: 'fixture-window' }; }
        else if (method === 'host.listWindows') { value = [{ id: 'fixture-window' }]; }
        else if (method === 'plugin.invoke') {
          const [name, input] = args;
          if (name.startsWith('sessions.')) { value = await sessions[name.slice(9)](owner, ...input); }
          else if (name.startsWith('conversation.')) { value = await conversations[name.slice(13)](...input); }
          else if (name === 'adapters.list') { value = [{ id: 'codex', name: 'Codex', capabilities: { restore: true, inputProtocol: 'codex' } }]; }
          else if (name === 'engines.list') { value = engines; }
          else if (name === 'engines.config') { value = { defaultEngine: 'codex' }; }
          else if (name.startsWith('storage.get')) { value = {}; }
          else if (!name.startsWith('storage.save')) { throw Error('Unexpected method: ' + name); }
        } else { throw Error('Unexpected method: ' + method); }
        response.end(JSON.stringify({ value }));
      } catch (error) { response.end(JSON.stringify({ error: { message: error.message } })); }
      return;
    }
    const bundle = bundles.find(file => file.path.endsWith(request.url));
    if (bundle) {
      response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(bundle.contents);
    } else if (request.url.startsWith('/view')) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(await readFile(`plugin-dev/ai-agent/src/resource/${request.url.includes('conversation') ? 'conversation' : 'index'}.html`, 'utf8'));
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0;display:block}</style>
        <iframe src="/view${request.url.includes('conversation') ? '?conversation' : ''}"></iframe><script>
        addEventListener('message',async event=>{
          if(event.origin!==location.origin||event.data.type!=='desk:invoke')return;
          const message=event.data;
          const result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({method:message.method,args:message.args})})).json();
          event.source.postMessage({type:'desk:result',id:message.id,...result},location.origin);
        });</script>`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://localhost:${server.address().port}`;
  for (const entry of ['app', 'conversation']) {
    const bundle = await build({ entryPoints: [resolve(`plugin-dev/ai-agent/src/renderer/${entry}.js`)], outfile: `/fixture/${entry}.js`,
      bundle: true, write: false, format: 'esm', platform: 'browser', loader: { '.html': 'text' }, plugins: [{ name: 'fixture-origin', setup(builder) {
        builder.onLoad({ filter: /\/(api|page-lifecycle)\.js$/ }, async args => ({
          contents: (await readFile(args.path, 'utf8')).replaceAll('desk-host://desktop', origin), loader: 'js'
        }));
      } }] });
    bundles.push(...bundle.outputFiles);
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(5000);
  await page.goto(origin);
  let frame = page.frameLocator('iframe');
  const button = frame.getByRole('button', { name: '重新连接工具', exact: true });
  await button.waitFor();
  await mkdir('.test-results/mcp-reconnect', { recursive: true });
  for (const theme of ['light', 'dark']) {
    for (const width of [1100, 600, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await frame.locator('html').evaluate((node, theme) => {
        node.dataset.theme = theme;
        window.dispatchEvent(new CustomEvent('desk-theme', { detail: theme }));
      }, theme);
      await button.focus();
      assert.equal(await button.isEnabled(), true);
      assert.equal(await button.locator('svg').count(), 1);
      const bounds = await button.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await frame.locator('html').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: `.test-results/mcp-reconnect/terminal-${theme}-${width}.png`, animations: 'disabled' });
    }
  }
  await button.press('Enter');
  await frame.locator(`[data-session="${terminal.id}"]`).waitFor({ state: 'detached' });
  assert.equal(sessions.list(owner).sessions[0].contextId, 'native-context');
  await page.goto(origin + '/?conversation');
  frame = page.frameLocator('iframe');
  await frame.locator('#history').selectOption([...conversations.records.keys()][0]);
  await frame.locator('#prompt').fill('未提交的消息');
  for (const theme of ['light', 'dark']) {
    for (const width of [1100, 600, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await frame.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
      await frame.locator('#reconnect-tools').focus();
      const bounds = await frame.locator('#reconnect-tools').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await frame.locator('html').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: `.test-results/mcp-reconnect/conversation-${theme}-${width}.png`, animations: 'disabled' });
    }
  }
  await frame.locator('#reconnect-tools').focus();
  await frame.locator('#reconnect-tools').press('Enter');
  await frame.locator('#conversation-notice').filter({ hasText: '工具已重新连接' }).waitFor();
  assert.equal(await frame.locator('#prompt').inputValue(), '未提交的消息');
});
