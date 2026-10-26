import { chromium } from 'playwright';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const server = http.createServer(async (req, res) => {
  const ai = req.url.startsWith('/ai/');
  const name = ai ? req.url.slice(4) : req.url.slice(1) || 'index.html';
  if (!['index.html', 'app.js', 'app.css', 'conversation.html', 'conversation.js', 'conversation.css'].includes(name)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(resolve(ai ? 'plugin-dev/ai-agent/dist/renderer' : 'plugin-dev/codex-capture/dist/renderer', name)));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
async function bridge(page, handler) {
  await page.exposeFunction('_fixtureCall', handler);
  await page.addInitScript(() => {
    window.postMessage = message => {
      if (message.type !== 'desk:invoke') { return; }
      window._fixtureCall(message.method, message.args).then(value => {
        window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'desk-host://desktop',
          data: { type: 'desk:result', id: message.id, value } }));
      }).catch(error => window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'desk-host://desktop',
        data: { type: 'desk:result', id: message.id, error: { message: error.message } } })));
    };
  });
}
try {
  const page = await browser.newPage();
  const windows = [{ id: 'window-one', name: '窗口 1', conversations: [
    { id: 'one-codex', name: '窗口一 Codex', engineId: 'codex', supported: true },
    { id: 'one-claude', name: '窗口一 Claude', engineId: 'claude', supported: true }] },
  { id: 'window-two', name: '窗口 2', conversations: [{ id: 'two-codex', name: '窗口二 Codex', engineId: 'codex', supported: true }] }];
  let target = null;
  let enabled = false;
  const status = () => ({ enabled, state: enabled ? 'captured' : 'stopped', target, logDirectory: '/private/fixture/capture' });
  const log = () => [
    { type: 'request.start', headers: { authorization: '[REDACTED]' } },
    { type: 'request.text', text: `${target.conversationId} <script>window.injected=true</script>` },
    { type: 'response.text', text: `RESPONSE_${target.conversationId}` }, { type: 'response.end' }
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
  await bridge(page, async (_method, [method, args]) => {
    if (method === 'capture.sources') { return [{ version: 2, pluginId: 'ai-agent', instanceId: 'instance', windows }]; }
    if (method === 'capture.status') { return status(); }
    if (method === 'capture.configure') { target = args[0].target || target; enabled = args[0].enabled; return status(); }
    if (method === 'capture.list') { return target ? [{ id: 'a'.repeat(36), bytes: Buffer.byteLength(log()), at: new Date().toISOString() }] : []; }
    if (method === 'capture.read') { const data = Buffer.from(log()); return { data: data.toString('base64'), offset: data.length, bytes: data.length }; }
    throw Error(`Unexpected capture method ${method}`);
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#agent-window').options.length === 3);
  assert.equal(await page.locator('#upstream').count(), 0);
  assert.equal(await page.locator('#toggle').isDisabled(), true);
  await page.selectOption('#agent-window', '0/window-one');
  await page.selectOption('#conversation', 'one-codex');
  await page.waitForFunction(() => !document.querySelector('#toggle').disabled);
  await page.locator('#toggle').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已捕获'));
  await page.waitForFunction(() => document.querySelector('#output').textContent.includes('RESPONSE_one-codex'));
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.selectOption('#conversation', 'one-claude');
  await page.waitForFunction(() => document.querySelector('#output').textContent.includes('RESPONSE_one-claude'));
  assert.ok(!(await page.locator('#output').textContent()).includes('one-codex'));
  await page.selectOption('#agent-window', '0/window-two');
  await page.selectOption('#conversation', 'two-codex');
  await page.waitForFunction(() => document.querySelector('#output').textContent.includes('RESPONSE_two-codex'));
  assert.ok(!(await page.locator('#output').textContent()).includes('one-claude'));
  for (const [width, height] of [[1100, 760], [560, 680]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `.test-results/agent-capture-v2-${width}.png` });
  }

  const groups = new Map();
  const records = new Map();
  const engine = id => ({ id, name: id, state: 'ready', pin: { version: 'fixture', platform: 'darwin', url: 'local', sha256: 'fixture' },
    installation: { state: 'idle' }, sources: { auth: 'fixture', skills: [], rules: [] } });
  const aiHandler = async (method, values) => {
    if (method === 'host.getLaunchContext') { return null; }
    const [name, args] = values;
    if (name === 'conversation.registerWindow') { const { id } = args[0]; if (!groups.has(id)) { groups.set(id, { id, name: `窗口 ${groups.size + 1}` }); } return groups.get(id); }
    if (name === 'conversation.listWindows') { return [...groups.values()]; }
    if (name === 'conversation.list') { return [...records.values()]; }
    if (name === 'engines.list') { return [engine('codex'), engine('claude')]; }
    if (name === 'engines.config') { return { defaultEngine: 'codex', engines: {} }; }
    if (name === 'conversation.account') { return { account: null }; }
    if (name === 'conversation.create') { const record = { ...args[0], id: randomUUID(), name: `对话 ${records.size + 1}`, state: 'idle', events: [] }; records.set(record.id, record); return record; }
    throw Error(`Unexpected AI method ${name}`);
  };
  const one = await browser.newPage();
  const two = await browser.newPage();
  await bridge(one, aiHandler);
  await bridge(two, aiHandler);
  await one.goto(`${base}/ai/conversation.html`);
  await one.waitForFunction(() => document.querySelector('#send').disabled === false);
  await one.locator('#new').click();
  await one.waitForFunction(() => document.querySelector('#history').options.length === 2);
  const firstWindow = await one.locator('#window-group').inputValue();
  await two.goto(`${base}/ai/conversation.html`);
  await two.waitForFunction(() => document.querySelector('#send').disabled === false);
  assert.equal(await two.locator('#history option').count(), 1);
  await two.locator('#new').click();
  await two.waitForFunction(() => document.querySelector('#history').options.length === 2);
  const secondWindow = await two.locator('#window-group').inputValue();
  assert.notEqual(firstWindow, secondWindow);
  await one.reload();
  await one.waitForFunction(() => document.querySelector('#history').options.length === 2);
  assert.equal(await one.locator('#window-group').inputValue(), firstWindow);
  assert.ok((await one.locator('#history').textContent()).includes('对话 1'));
  assert.ok(!(await one.locator('#history').textContent()).includes('对话 2'));
  await one.selectOption('#window-group', secondWindow);
  await one.waitForFunction(() => document.querySelector('#history').textContent.includes('对话 2'));
  assert.ok(!(await one.locator('#history').textContent()).includes('对话 1'));
  console.log('PASS: capture window->dialogue selection, no mixed output, safe text, responsive layouts; AI groups isolate histories, survive reload and reopen historical groups');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
