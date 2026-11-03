import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { BuiltinTools } from '../src/main/common/builtin-tools.js';
import { McpServices } from '../src/main/common/services.js';

async function fixture(t) {
  const storage = await temporaryStore(t);
  const manager = new McpServices({ storage, pluginId: 'mcp-services' });
  const builtin = new BuiltinTools({ storage, pluginId: 'mcp-services', capabilities: { unregister: async () => {} } },
    { computer: { supported: false } });
  const calls = [];
  let bundle;
  let holdSave;
  let saveStarted;
  const saveArrived = new Promise(resolve => { saveStarted = resolve; });
  const saveGate = new Promise(resolve => { holdSave = resolve; });
  let blockSave = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/rpc') {
      let text = '';
      for await (const chunk of request) {
        text += chunk;
      }
      const { method, args } = JSON.parse(text);
      calls.push(method);
      try {
        if (method.startsWith('mcp.builtin.')) {
          assert.ok(['status', 'read', 'remove'].includes(method.slice(12)));
          response.end(JSON.stringify({ value: await builtin[method.slice(12)](...args) }));
          return;
        }
        assert.ok(['mcp.list', 'mcp.source', 'mcp.save', 'mcp.remove', 'mcp.logs'].includes(method), 'import must not start or execute a service');
        if (method === 'mcp.save' && blockSave) {
          saveStarted();
          await saveGate;
        }
        response.end(JSON.stringify({ value: await manager[method.slice(4)](...args) }));
      } catch (error) {
        response.end(JSON.stringify({ error: { message: error.message } }));
      }
      return;
    }
    if (request.url === '/app.js' || request.url === '/app.css') {
      response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(bundle.outputFiles.find(file => file.path.endsWith(request.url)).contents);
    } else if (request.url === '/view') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><main id="app"></main><script type="module" src="/app.js"></script>');
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{width:100vw;height:100vh;border:0;display:block}</style>
        <iframe title="MCP 服务" src="/view"></iframe><script>
        addEventListener('message',async event=>{
          if(event.origin!==location.origin||event.data.type!=='desk:invoke')return;
          const request=event.data;let result;
          if(request.method==='storage.getPreferences')result={value:{theme:'light'}};
          else result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({method:request.args[0],args:request.args[1]})})).json();
          event.source.postMessage({type:'desk:result',id:request.id,...result},location.origin);
        });</script>`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Keep the production bridge and lifecycle logic; only substitute this fixture's secure-local origin.
  bundle = await build({ entryPoints: [resolve('plugin-dev/mcp/src/renderer/app.js')], outfile: '/fixture/app.js',
    bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'fixture-origin', setup(builder) {
      builder.onLoad({ filter: /\/(api|page-lifecycle)\.js$/ }, async args => ({
        contents: (await readFile(args.path, 'utf8')).replaceAll('desk-host://desktop', origin), loader: 'js'
      }));
    } }] });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(5000);
  await page.goto(origin);
  const frame = page.frameLocator('iframe');
  return { page, frame, manager, storage, calls,
    holdNextSave() { blockSave = true; }, waitForSave: () => saveArrived, releaseSave: holdSave };
}

test('toolbar imports generated ZIPs into new services while add is at upper right and existing data stays unchanged',
  { timeout: 30000 }, async t => {
    const { page, frame, manager, calls, holdNextSave, waitForSave, releaseSave } = await fixture(t);
    const importButton = frame.getByRole('button', { name: '导入服务压缩包', exact: true });
    const add = frame.getByRole('button', { name: '添加服务', exact: true });
    await importButton.waitFor({ timeout: 3000 });
    assert.equal(await frame.locator('.workspace-tools #new').count(), 1);
    assert.equal(await frame.locator('#services #new').count(), 0);
    assert.equal(await add.locator('svg').count(), 1);
    await importButton.click();
    await frame.locator('#archive-file').setInputFiles(resolve('plugin-dev/dist/mcp-jenkins-1.1.0.zip'));
    await frame.locator('#config [name="name"]').waitFor();
    assert.equal(await frame.locator('[name="name"]').inputValue(), 'Jenkins · 部署与结果回查');
    assert.equal(await frame.locator('[name="entry"]').inputValue(), 'server.mjs');
    assert.equal((await manager.definitions()).length, 0, 'archive import is only a draft until configuration is saved');
    await frame.getByLabel('功能描述', { exact: true }).fill('触发 Jenkins 部署并回查本次构建结果。');
    await frame.locator('#script details').filter({ has: frame.locator('[name="script-env"]') }).locator('summary').click();
    await frame.locator('[name="script-env"]').fill(JSON.stringify({ JENKINS_URL: 'http://jenkins.test/',
      JENKINS_USERNAME: 'user', JENKINS_PASSWORD: 'local-password' }));
    holdNextSave();
    await frame.getByRole('button', { name: '保存', exact: true }).click();
    await waitForSave();
    assert.equal(await importButton.isDisabled(), true);
    assert.equal(await add.isDisabled(), true);
    releaseSave();
    await frame.getByRole('button', { name: '启用', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('iframe').contentDocument.querySelector('#save').disabled);
    const [saved] = await manager.definitions();
    assert.equal(saved.name, 'Jenkins · 部署与结果回查');
    assert.equal(saved.description, '触发 Jenkins 部署并回查本次构建结果。');
    assert.equal(saved.env.JENKINS_PASSWORD, 'local-password');
    assert.ok(!(await manager.source(saved.id)).includes('local-password'));
    assert.equal((await manager.list())[0].state, 'stopped');
    const files = await manager.deployments.files(saved);
    assert.equal(files.length, 5);
    await frame.locator('#archive-file').setInputFiles(resolve('plugin-dev/dist/feishu-doc-1.0.0.zip'));
    await frame.locator('[name="name"]').filter({ visible: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelector('[name=name]').value === '飞书文档 · feishu-doc');
    assert.equal(await frame.locator('[name="entry"]').inputValue(), 'server.cjs');
    assert.equal(await frame.locator('[name="id"]').inputValue(), '');
    assert.deepEqual(JSON.parse(await frame.locator('[name="script-env"]').inputValue()),
      { APP_ID: '', APP_SECRET: '', FEISHU_DOC_ENGINE_DIR: '', FEISHU_DOC_DATA_DIR: '', USER_ACCESS_TOKEN: '' });
    assert.deepEqual(await manager.definitions(), [saved]);
    assert.ok(!calls.includes('mcp.start'));
    await mkdir('.test-results/mcp-zip-import', { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.querySelector('iframe').contentWindow.postMessage({ type: 'desk:theme', theme }, location.origin), theme);
      await frame.locator(`html[data-theme="${theme}"]`).waitFor();
      for (const width of [1100, 600, 360]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(await frame.locator('body').evaluate(node => node.scrollWidth <= innerWidth), true);
        assert.equal(await frame.locator('#new').count(), 1);
        await frame.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ animations: 'disabled', path: join('.test-results/mcp-zip-import', `configuration-${theme}-${width}.png`) });
      }
    }
  });

test('cancelled or invalid ZIP selection preserves edits; toolbar supports themes, keyboard and narrow/tiled views',
  { timeout: 30000 }, async t => {
    const { page, frame, manager } = await fixture(t);
    const importButton = frame.getByRole('button', { name: '导入服务压缩包', exact: true });
    const add = frame.getByRole('button', { name: '添加服务', exact: true });
    await importButton.waitFor({ timeout: 3000 });
    await add.click();
    await frame.locator('[name="name"]').fill('尚未保存的配置');
    const chooser = page.waitForEvent('filechooser');
    await importButton.click();
    await (await chooser).setFiles([]);
    assert.equal(await frame.locator('[name="name"]').inputValue(), '尚未保存的配置');
    await frame.locator('#archive-file').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('broken') });
    await frame.locator('#status').getByText(/ZIP|压缩包/).waitFor();
    assert.equal(await frame.locator('[name="name"]').inputValue(), '尚未保存的配置');
    assert.deepEqual(await manager.definitions(), []);
    await frame.getByRole('button', { name: '返回服务列表', exact: true }).click();
    assert.equal(await frame.locator('#back').isHidden(), true);
    await mkdir('.test-results/mcp-zip-import', { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.querySelector('iframe').contentWindow.postMessage({ type: 'desk:theme', theme }, location.origin), theme);
      await frame.locator(`html[data-theme="${theme}"]`).waitFor();
      for (const width of [1100, 600, 360]) {
        await page.setViewportSize({ width, height: 800 });
        const bounds = await add.boundingBox();
        const importBounds = await importButton.boundingBox();
        assert.ok(bounds.x > importBounds.x && bounds.y < 60 && bounds.x + bounds.width <= width);
        assert.equal(await frame.locator('body').evaluate(node => node.scrollWidth <= innerWidth), true);
        await importButton.focus();
        await page.keyboard.press('Tab');
        assert.equal(await add.evaluate(node => node.matches(':focus-visible')), true);
        assert.notEqual(await add.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
        await frame.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ animations: 'disabled', path: join('.test-results/mcp-zip-import', `${theme}-${width}.png`) });
      }
    }
  });

test('legacy tool row supports keyboard deletion and stays absent after reload', { timeout: 30000 }, async t => {
  const { page, frame, manager, storage } = await fixture(t);
  await frame.getByRole('button', { name: '删除内置飞书文档与电脑工具', exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    for (const width of [1100, 600, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await frame.locator('html').evaluate((element, theme) => { element.dataset.theme = theme; }, theme);
      const button = frame.getByRole('button', { name: '删除内置飞书文档与电脑工具', exact: true });
      await button.focus();
      assert.equal(await button.isEnabled(), true);
      const bounds = await button.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    }
  }
  await frame.getByRole('button', { name: '删除内置飞书文档与电脑工具', exact: true }).press('Enter');
  await frame.getByRole('dialog').waitFor();
  assert.equal((await storage.readJson('plugin-data/mcp-services/builtin-tools.json', {})).removed, undefined);
  await frame.getByRole('button', { name: '确认删除', exact: true }).click();
  await frame.locator('#builtin-settings').waitFor({ state: 'detached' });
  assert.equal(await frame.locator('#builtin-settings').count(), 0);
  assert.equal((await storage.readJson('plugin-data/mcp-services/builtin-tools.json')).removed, true);
  assert.deepEqual(await manager.definitions(), []);
  await page.reload();
  await frame.locator('#new').waitFor();
  await page.waitForFunction(() => !document.querySelector('iframe').contentDocument.querySelector('#builtin-settings'));
  assert.equal(await frame.locator('#builtin-settings').count(), 0);
});

test('service configuration deletion requires explicit confirmation and cancellation preserves all configuration', { timeout: 30000 }, async t => {
  const { page, frame, manager, calls } = await fixture(t);
  const id = 'metabase-recovered';
  await manager.save({ id, name: '<mcp-metabase>', description: '只读查询', transport: 'http', url: 'https://example.test/mcp' });
  await page.reload();
  await frame.getByRole('button', { name: '配置 <mcp-metabase>', exact: true }).click();
  const remove = frame.getByRole('button', { name: '删除', exact: true });
  for (const dismissal of ['cancel', 'escape', 'outside']) {
    await remove.click();
    await frame.getByRole('dialog').waitFor();
    assert.ok((await frame.getByRole('dialog').innerText()).includes('<mcp-metabase>'));
    assert.equal(await frame.getByRole('dialog').locator('mcp-metabase').count(), 0);
    assert.equal(calls.filter(method => method === 'mcp.remove').length, 0);
    if (dismissal === 'cancel') { await frame.getByRole('button', { name: '取消', exact: true }).click(); }
    else if (dismissal === 'escape') { await frame.getByRole('dialog').press('Escape'); }
    else { await frame.locator('header').dispatchEvent('pointerdown'); }
    await frame.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal((await manager.definitions()).length, 1);
    assert.equal(await remove.evaluate(node => document.activeElement === node), true);
  }
  for (const theme of ['light', 'dark']) {
    for (const width of [1100, 600, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await frame.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
      await remove.click();
      const dialog = frame.getByRole('dialog');
      await dialog.waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await frame.getByRole('button', { name: '确认删除', exact: true }).focus();
      assert.equal(await frame.getByRole('button', { name: '确认删除', exact: true }).locator('svg').count(), 1);
      await dialog.press('Escape');
    }
  }
  await remove.click();
  await frame.getByRole('button', { name: '确认删除', exact: true }).click();
  await frame.locator('#details').waitFor({ state: 'hidden' });
  assert.equal((await manager.definitions()).length, 0);
  assert.equal(calls.filter(method => method === 'mcp.remove').length, 1);
});
