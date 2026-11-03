import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { BuiltinTools } from '../src/main/common/builtin-tools.js';
import { validateDescriptor, jsonValue } from '../../../desk/src/main/common/capability-schema.js';
import { FeishuDocuments } from '../src/main/common/feishu-documents.js';

async function fixture(t, options = {}) {
  const registered = new Map();
  const requests = [];
  const cancelled = [];
  const storage = await temporaryStore(t);
  const context = { storage, pluginId: 'mcp-services', capabilities: {
    register: async (descriptor, handler) => registered.set(descriptor.id, { descriptor, handler }),
    unregister: async id => registered.delete(id)
  }, host: { messages: {
    request: async input => { requests.push(input); return { id: 'prompt', state: 'pending' }; },
    get: async () => ({ state: 'answered', answer: { text: '已完成授权，重试' } }),
    cancel: async id => cancelled.push(id)
  } } };
  const computer = { supported: true, permissions: async () => ({ screen: true, accessibility: true }),
    execute: async input => ({ content: [{ type: 'text', text: input.action }] }), authorize: async () => {} };
  const tools = new BuiltinTools(context, { computer, ...options });
  await tools.load();
  t.after(() => tools.close());
  return { tools, storage, registered, requests, cancelled, computer, context };
}

const call = (registered, id, input, signal = new AbortController().signal) => registered.get(id).handler(input, { signal });

test('built-in tools retain settings and existing service data across reload and disable', async t => {
  const { tools, registered, storage, context } = await fixture(t);
  assert.deepEqual([...registered.keys()], ['mcp.feishu.document.read', 'mcp.computer.control']);
  await storage.writeJson('plugin-data/mcp-services/services.json', [{ id: 'existing' }]);
  await tools.save({ feishuEnabled: true, computerEnabled: false, appId: 'app', appSecret: 'secret', userAccessToken: '' });
  assert.equal(registered.has('mcp.computer.control'), false);
  assert.equal((await tools.read()).appSecret, 'secret');
  assert.deepEqual(await storage.readJson('plugin-data/mcp-services/services.json'), [{ id: 'existing' }]);
  assert.doesNotMatch(JSON.stringify([...registered.values()].map(value => value.descriptor)), /secret/);
  await tools.close();
  const reopened = new BuiltinTools(context, { computer: { supported: true } });
  await reopened.load();
  assert.equal((await reopened.read()).computerEnabled, false);
  await reopened.close();
});

test('computer permission requests require an explicit centered human answer before action', async t => {
  let permitted = false;
  let executed = 0;
  const computer = { supported: true, permissions: async () => ({ screen: permitted, accessibility: permitted }),
    authorize: async () => { permitted = true; }, execute: async () => { executed++; return { content: [] }; } };
  const { registered, requests } = await fixture(t, { computer });
  await call(registered, 'mcp.computer.control', { action: 'click', x: 10, y: 12 });
  assert.equal(executed, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].required, true);
  assert.equal(requests[0].placement, 'center');
});

test('cancellation closes a pending permission popup and never operates the computer', async t => {
  let executed = false;
  const { registered, requests, cancelled, context } = await fixture(t, { computer: {
    supported: true, permissions: async () => ({ screen: false, accessibility: false }),
    execute: async () => { executed = true; }
  } });
  context.host.messages.get = async () => ({ state: 'pending' });
  const controller = new AbortController();
  const pending = call(registered, 'mcp.computer.control', { action: 'screenshot' }, controller.signal);
  while (!requests.length) { await new Promise(resolve => setImmediate(resolve)); }
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.deepEqual(cancelled, ['prompt']);
  assert.equal(executed, false);
});

test('Feishu missing credentials prompts without exposing credentials and retries after configuration', async t => {
  let attempts = 0;
  const { registered, requests } = await fixture(t, { documents: { read: async () => {
    if (++attempts === 1) { throw Object.assign(Error('请在 MCP 服务中配置飞书凭据'), { code: 'FEISHU_AUTH_REQUIRED' }); }
    return { content: [{ type: 'text', text: 'document' }] };
  } } });
  const result = await call(registered, 'mcp.feishu.document.read', { url: 'https://team.feishu.cn/docx/abc' });
  assert.equal(result.content[0].text, 'document');
  assert.equal(requests[0].optionsOnly, true);
  assert.match(requests[0].question, /MCP/);
});

test('Feishu wiki resolves a docx document through official APIs, retaining no content in settings', async () => {
  const calls = [];
  const documents = new FeishuDocuments({ fetch: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('/get_node') ? { code: 0, data: { node: { obj_type: 'docx', obj_token: 'document', title: '需求' } } }
      : { code: 0, data: { content: '需求正文' } }));
  } });
  const result = await documents.read({ url: 'https://team.feishu.cn/wiki/wikiToken' }, { userAccessToken: 'private-token' }, new AbortController().signal);
  assert.match(result.content[0].text, /需求正文/);
  assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=wikiToken');
  assert.match(calls[1].url, /docx\/v1\/documents\/document\/raw_content/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-token');
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  await assert.rejects(documents.read({ url: 'https://attacker.test/wiki/token' }, { userAccessToken: 'secret' }), /飞书|Lark/);
  assert.equal(calls.length, 2);
});

test('Feishu application token is obtained only from the official region and cached until expiry', async () => {
  const calls = [];
  const documents = new FeishuDocuments({ fetch: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('/auth/') ? { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
      : { code: 0, data: { content: 'read' } }));
  } });
  for (let i = 0; i < 2; i++) {
    await documents.read({ url: 'https://team.larksuite.com/docx/document' }, { appId: 'app', appSecret: 'secret' });
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal');
  assert.deepEqual(JSON.parse(calls[0].options.body), { app_id: 'app', app_secret: 'secret' });
});


test('built-in descriptors satisfy the real host schema and contain no legacy connection selection', async t => {
  const { registered } = await fixture(t);
  for (const { descriptor } of registered.values()) {
    validateDescriptor(descriptor);
    assert.equal(descriptor.source.serviceId, undefined);
  }
});

test('user rejection and plugin stop cancel permissions without executing an action', async t => {
  let executed = false;
  const { tools, registered, context, requests, cancelled } = await fixture(t, { computer: {
    supported: true, permissions: async () => ({ screen: false, accessibility: false }),
    execute: async () => { executed = true; }
  } });
  context.host.messages.get = async () => ({ state: 'answered', answer: { text: '取消本次操作' } });
  await assert.rejects(call(registered, 'mcp.computer.control', { action: 'screenshot' }), /用户取消/);
  context.host.messages.get = async () => ({ state: 'pending' });
  const pending = call(registered, 'mcp.computer.control', { action: 'screenshot' });
  const rejected = assert.rejects(pending, /abort/i);
  while (requests.length < 2) { await new Promise(resolve => setImmediate(resolve)); }
  await tools.close();
  await rejected;
  assert.equal(tools.active.size, 0);
  assert.equal(registered.size, 0);
  assert.equal(cancelled.length, 2);
  assert.equal(executed, false);
});

test('Feishu rejected cached application tokens can be renewed on the user retry', async () => {
  let issued = 0;
  const documents = new FeishuDocuments({ fetch: async (url, options) => {
    if (url.includes('/auth/')) {
      return Response.json({ code: 0, tenant_access_token: `token-${++issued}`, expire: 7200 });
    }
    return options.headers.Authorization === 'Bearer token-1'
      ? new Response('{}', { status: 401 }) : Response.json({ code: 0, data: { content: 'renewed' } });
  } });
  const input = { url: 'https://team.feishu.cn/docx/document' };
  const config = { appId: 'app', appSecret: 'secret' };
  await assert.rejects(documents.read(input, config), { code: 'FEISHU_AUTH_REQUIRED' });
  const result = await documents.read(input, config);
  assert.match(result.content[0].text, /renewed/);
  assert.equal(issued, 2);
});

test('Feishu document size accounts for UTF-8 and fits the host result budget', async () => {
  let content = '需求'.repeat(100000);
  const documents = new FeishuDocuments({ fetch: async () => Response.json({ code: 0, data: { content } }) });
  const input = { url: 'https://team.feishu.cn/docx/document' };
  const config = { userAccessToken: 'secret' };
  jsonValue(await documents.read(input, config), 'INVALID_RESULT');
  content = '"'.repeat(600000);
  await assert.rejects(documents.read(input, config), /过大/);
  content = '需求'.repeat(150000);
  await assert.rejects(documents.read(input, config), /过大/);
});

test('removing legacy tools persists absence, cancels calls and preserves independent services and credentials', async t => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const { tools, storage, registered, context, computer } = await fixture(t, { documents: {
    read: async (_input, _config, signal) => {
      started();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  } });
  await tools.save({ feishuEnabled: true, computerEnabled: true, appId: 'app', appSecret: 'secret', userAccessToken: '' });
  await storage.writeJson('plugin-data/mcp-services/services.json', [{ id: 'feishu-doc' }]);
  const staleHandler = registered.get('mcp.feishu.document.read').handler;
  const rejected = assert.rejects(call(registered, 'mcp.feishu.document.read', { url: 'https://team.feishu.cn/docx/test' }));
  await pending;
  await tools.remove();
  await rejected;
  assert.equal(registered.size, 0);
  assert.equal(tools.active.size, 0);
  assert.equal((await tools.read()).removed, true);
  assert.equal((await tools.read()).appSecret, 'secret');
  assert.deepEqual(await tools.status(), { removed: true });
  assert.deepEqual(await storage.readJson('plugin-data/mcp-services/services.json'), [{ id: 'feishu-doc' }]);
  await assert.rejects(staleHandler({ url: 'https://team.feishu.cn/docx/test' }, {}), /已删除/);
  const reopened = new BuiltinTools(context, { computer });
  await reopened.load();
  assert.equal(registered.size, 0);
  await reopened.close();
});
