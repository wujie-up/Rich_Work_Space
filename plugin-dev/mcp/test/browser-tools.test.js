import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { BrowserTools } from '../src/main/common/browser-tools.js';

async function fixture(t) {
  const storage = await temporaryStore(t);
  const handlers = new Map();
  const descriptors = [];
  const calls = [];
  const locator = { click: async () => calls.push('click'), fill: async text => calls.push(['fill', text]),
    press: async key => calls.push(['press', key]), selectOption: async value => calls.push(['select', value]),
    ariaSnapshot: async () => '- heading "真实页面"\n- button "提交"' };
  const page = { once: () => {}, setDefaultTimeout: () => {}, url: () => 'http://localhost/test', title: async () => '真实页面',
    goto: async url => calls.push(['goto', url]), locator: () => locator,
    getByRole: (role, options) => { calls.push([role, options]); return locator; },
    screenshot: async () => Buffer.from('image'), close: async () => calls.push('page.close') };
  const context = { newPage: async () => page, storageState: async () => ({ cookies: [], origins: [] }), close: async () => {} };
  const server = Object.assign(new EventEmitter(), { process: () => ({ pid: 12345 }), wsEndpoint: () => 'ws://owned',
    close: async () => { calls.push('server.close'); server.emit('close'); } });
  const chromium = { launchServer: async () => { calls.push('launch'); return server; },
    connect: async () => ({ newContext: async () => context, close: async () => {} }) };
  const owned = [];
  const messages = { request: async input => { calls.push(input); return { id: 'approval' }; },
    get: async () => ({ state: 'answered', answer: { text: '已完成，继续' } }), cancel: async id => calls.push(['cancel', id]) };
  page.bringToFront = async () => calls.push('front');
  const tools = new BrowserTools({ storage, pluginId: 'mcp-services', ownProcesses: pids => owned.push(pids), host: { messages },
    capabilities: { register: async (descriptor, handler) => { descriptors.push(descriptor); handlers.set(descriptor.id, handler); },
      unregister: async id => handlers.delete(id) } }, { chromium });
  t.after(() => tools.close());
  await tools.load();
  return { tools, invoke: input => handlers.get('mcp.browser.control')(input, {}), descriptors, calls, page, owned, handlers, server, messages };
}

test('browser capability registers independently from removed legacy built-ins and launches lazily', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0);
  assert.match(f.descriptors[0].description, /request_user/);
  assert.equal(f.descriptors[0].execution.cancellable, true);
  const opened = await f.invoke({ action: 'open', url: 'http://localhost/test' });
  const body = JSON.parse(opened.content[0].text);
  assert.ok(body.tabId);
  assert.match(body.snapshot, /提交/);
  assert.deepEqual(f.owned[0], [12345]);
  await f.invoke({ action: 'tabs' });
  assert.equal(f.calls.filter(value => value === 'launch').length, 1);
});

test('named element operations, screenshot and explicit tab targeting share one real browser session', async t => {
  const f = await fixture(t);
  const { tabId } = JSON.parse((await f.invoke({ action: 'open', url: 'https://example.com' })).content[0].text);
  await f.invoke({ action: 'fill', tabId, role: 'textbox', name: '需求', text: '内容' });
  await f.invoke({ action: 'click', tabId, role: 'button', name: '提交' });
  await f.invoke({ action: 'press', tabId, selector: '#field', key: 'Enter' });
  const image = await f.invoke({ action: 'screenshot', tabId });
  assert.equal(image.content[0].mimeType, 'image/png');
  assert.ok(f.calls.some(value => value[0] === 'textbox' && value[1].exact));
  await assert.rejects(f.invoke({ action: 'click', tabId }), /role.*selector/);
  await assert.rejects(f.invoke({ action: 'snapshot', tabId: 'unknown' }), /标签页/);
  await assert.rejects(f.invoke({ action: 'open', url: 'javascript:alert(1)' }), /HTTP/);
});

test('cancelling a browser operation closes only its owned tab and releases the call', async t => {
  const f = await fixture(t);
  const { tabId } = JSON.parse((await f.invoke({ action: 'open', url: 'https://example.com' })).content[0].text);
  f.page.locator = () => ({ ariaSnapshot: () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = f.handlers.get('mcp.browser.control')({ action: 'snapshot', tabId }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(f.calls.includes('page.close'));
});

test('closing the plugin cleans up its browser process and unregisters the capability', async t => {
  const f = await fixture(t);
  await f.invoke({ action: 'open', url: 'http://localhost/test' });
  await f.tools.close();
  assert.ok(f.calls.includes('server.close'));
  assert.deepEqual(f.owned.at(-1), []);
  assert.equal(f.handlers.size, 0);
});

test('a manually closed browser releases ownership and can be opened again', async t => {
  const f = await fixture(t);
  await f.invoke({ action: 'open', url: 'http://localhost/test' });
  f.server.emit('close');
  assert.deepEqual(f.owned.at(-1), []);
  assert.equal(JSON.parse((await f.invoke({ action: 'tabs' })).content[0].text).tabs.length, 0);
  await f.invoke({ action: 'open', url: 'http://localhost/test' });
  assert.equal(f.calls.filter(value => value === 'launch').length, 2);
});

test('login and authorization always request a required host popup and respect cancellation', async t => {
  const f = await fixture(t);
  const { tabId } = JSON.parse((await f.invoke({ action: 'open', url: 'https://example.com' })).content[0].text);
  const result = await f.invoke({ action: 'request_user', tabId, text: '请登录并授权文档读取' });
  assert.equal(JSON.parse(result.content[0].text).confirmed, true);
  const popup = f.calls.find(value => value?.title === '浏览器需要用户操作');
  assert.equal(popup.required, true);
  assert.equal(popup.placement, 'center');
  assert.ok(f.calls.includes('front'));
  f.messages.get = async () => ({ state: 'answered', answer: { text: '取消本次操作' } });
  await assert.rejects(f.invoke({ action: 'request_user', tabId, text: '是否继续？' }), /用户取消/);
});
