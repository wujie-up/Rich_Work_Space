import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { certificate } from '../../../web/src/server/certificate.js';

test('remote access view stays readable and operable across themes, states and narrow layouts', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wd-access-renderer-'));
  const tls = await certificate(directory);
  const html = await readFile(new URL('../src/resource/index.html', import.meta.url), 'utf8');
  const output = await build({ entryPoints: [new URL('../src/renderer/app.js', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'browser', outfile: join(directory, 'app.js'), write: false });
  const assets = new Map(output.outputFiles.map(file => [file.path.split('/').at(-1), file.contents]));
  const plugin = createServer(tls, (request, response) => {
    const name = request.url.slice(1);
    response.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(assets.get(name) || html);
  });
  await new Promise(resolve => plugin.listen(0, '127.0.0.1', resolve));
  // This parent supplies only fixture RPC results; no plugin backend, Keychain or user data is opened.
  const parent = createServer(tls, (_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>
      <iframe title="插件视图" src="https://127.0.0.1:${plugin.address().port}/"></iframe><script>
      window.state = {running:false, pending:[], devices:[], connections:[]}; window.calls=[];
      addEventListener('message', event => {
        if(event.source !== document.querySelector('iframe').contentWindow || event.origin !== 'https://127.0.0.1:${plugin.address().port}' || event.data.type !== 'desk:invoke') return;
        const [method,args]=event.data.args; calls.push({method,args}); let value=state;
        if(method==='access.start') state.running=true;
        if(method==='access.stop') state.running=false;
        if(method==='pairing.create') value={ticket:'fixture-only',expiresAt:Date.now()+120000};
        event.source.postMessage({type:'desk:result',id:event.data.id,value},event.origin);
      });</script>`);
  });
  await new Promise(resolve => parent.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await Promise.all([parent, plugin].map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`https://127.0.0.1:${parent.address().port}`);
  const frame = page.frameLocator('iframe');
  await frame.locator('#status').filter({ hasText: '远程访问已关闭' }).waitFor();
  await mkdir('.test-results/web-access', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await frame.locator('html').evaluate((html, theme) => { html.dataset.theme = theme; }, theme);
    assert.equal(await frame.locator('body').evaluate(body => getComputedStyle(body).backgroundColor),
      theme === 'dark' ? 'rgb(24, 24, 24)' : 'rgb(247, 247, 247)');
    for (const selector of ['#toggle', '#assistant']) {
      const button = frame.locator(selector);
      assert.equal(await button.evaluate(button => getComputedStyle(button).color === getComputedStyle(document.body).color), true);
      await button.focus();
      assert.equal(await button.evaluate(button => document.activeElement === button), true);
      assert.equal(await button.getAttribute('title'), await button.getAttribute('aria-label'));
      assert.equal(await button.locator('svg[aria-hidden="true"]').count(), 1);
    }
    assert.equal(await frame.locator('#invite').isDisabled(), true);
    assert.equal(await frame.locator('.risk').count(), 1);
    await frame.locator('#help').focus();
    await frame.getByRole('tooltip').waitFor({ state: 'visible' });
    await frame.locator('#toggle').focus();
    await page.screenshot({ path: `.test-results/web-access/redesign-${theme}.png` });
  }
  await frame.locator('#toggle').click();
  await frame.locator('#invite:enabled').waitFor();
  await frame.locator('#invite').click();
  await frame.locator('#invitation').waitFor({ state: 'visible' });
  assert.match(await frame.locator('#ticket').inputValue(), /fixture-only/);
  await frame.locator('#toggle').click();
  await frame.locator('#invitation').waitFor({ state: 'hidden' });
  await frame.locator('#toggle').click();
  await frame.locator('#invite:enabled').waitFor();
  const deviceId = 'a'.repeat(64);
  await page.evaluate(deviceId => {
    state.devices = [{ label: '我的 iPhone', deviceId }];
    state.pending = [{ label: '待确认 iPhone', fingerprint: '0123456789abcdef01234567', requestId: 'fixture-request' }];
    state.connections = [{ deviceId, path: 'relay', streams: 3 }];
  }, deviceId);
  await frame.locator('#devices').getByText('我的 iPhone', { exact: true }).waitFor();
  assert.equal(await frame.locator('#devices-count').textContent(), '1');
  assert.match(await frame.locator('#connections').textContent(), /我的 iPhone[\s\S]*加密中继/);
  assert.match(await frame.locator('#pending').textContent(), /0123456789abcdef01234567/);
  for (const theme of ['dark', 'light']) {
    await frame.locator('html').evaluate((html, theme) => { html.dataset.theme = theme; }, theme);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `.test-results/web-access/redesign-populated-${theme}.png` });
  }
  for (const width of [360, 560, 1100]) {
    await page.setViewportSize({ width, height: 760 });
    assert.equal(await frame.locator('html').evaluate(html => html.scrollWidth <= html.clientWidth), true);
    await frame.locator('#help').focus();
    const tooltip = await frame.getByRole('tooltip').boundingBox();
    assert.ok(tooltip.x >= 0 && tooltip.x + tooltip.width <= width);
    await frame.locator('#toggle').focus();
    if (width === 360) {
      await page.screenshot({ path: '.test-results/web-access/redesign-narrow.png', fullPage: true });
    }
  }
  await frame.getByRole('button', { name: '确认配对设备 待确认 iPhone' }).click();
  await frame.getByRole('button', { name: '撤销设备 我的 iPhone 并断开连接' }).click();
  await page.waitForFunction(() => calls.some(call => call.method === 'devices.revoke'));
  const calls = await page.evaluate(() => calls);
  assert.ok(calls.some(call => call.method === 'pairing.confirm' && call.args[0] === 'fixture-request'));
  assert.ok(calls.some(call => call.method === 'devices.revoke' && call.args[0] === deviceId));
  assert.deepEqual(errors, []);
});
