import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityGateway } from '../src/main/common/capability-gateway.js';

test('MCP debug sees only target temporary service; normal conversations and menu tasks exclude it', async t => {
  const capabilities = { discover: async () => ({ providers: ['target', 'other'].map(serviceId => ({
    state: 'ready', handle: { pluginId: 'mcp-services', capabilityId: serviceId }, descriptor: {
      id: `mcp.${serviceId}`, source: { serviceId, debug: true }, effects: ['mcp.tool'], inputSchema: { type: 'object' }
    }
  })) }) };
  for (const task of [undefined, { kind: 'plan' }, { kind: 'plan', mcpDebug: { serviceId: 'target', pluginId: 'mcp-services' } }]) {
    const gateway = new CapabilityGateway({ capabilities, task });
    await gateway.start();
    t.after(() => gateway.close());
    const tools = (await gateway.dispatch({ method: 'tools/list' })).tools;
    assert.equal(tools.length, task?.mcpDebug ? 1 : 0);
  }
});

test('菜单任务不可递归调用能力，普通对话也不暴露任务工具', async t => {
  const capabilities = { discover: async () => ({ catalogRevision: 1, providers: [
    { state: 'ready', handle: { capabilityId: 'read' }, descriptor: { id: 'document.read', inputSchema: { type: 'object' }, effects: ['document.read'] } },
    { state: 'ready', handle: { capabilityId: 'plan' }, descriptor: { id: 'agent.menu.plan.start.v1', inputSchema: { type: 'object' }, effects: ['workspace.read'] } }
  ] }) };
  for (const task of [undefined, { kind: 'plan' }, { kind: 'code' }]) {
    const gateway = new CapabilityGateway({ capabilities, task });
    await gateway.start();
    t.after(() => gateway.close());
    assert.equal((await gateway.dispatch({ method: 'tools/list' })).tools.length, task ? 0 : 1);
  }
});

test('gateway authenticates per-conversation bearer, binds full discovered handle, never accepts invented identity', async t => {
  const handle = { pluginId: 'mcp', instanceId: 'instance-1', capabilityId: 'read', version: 1, descriptorRevision: 3 };
  const invocations = [];
  const capabilities = {
    discover: async () => ({ catalogRevision: 1, providers: [{ handle, state: 'ready', descriptor: {
      id: 'read', title: 'Read', description: 'Read logs', inputSchema: { type: 'object' },
      effects: ['network.read', 'filesystem.read'] } }] }),
    invoke: async (...args) => { invocations.push(args); return { invocationId: 'i', traceId: 'trace', state: 'running' }; },
    getInvocation: async () => ({ invocationId: 'i', state: 'succeeded', result: { ok: true } }),
    cancel: async () => {}, subscribe: () => () => {}
  };
  const gateway = new CapabilityGateway({ capabilities, conversationId: 'conversation-1', onInvocation: () => {} });
  await gateway.start();
  t.after(() => gateway.close());
  const call = async (method, params, token = gateway.token) => fetch(gateway.url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  assert.equal((await call('tools/list', {}, 'invalid')).status, 401);
  const list = await (await call('tools/list', {})).json();
  assert.equal(list.result.tools.length, 1);
  assert.deepEqual(list.result.tools[0].annotations, { readOnlyHint: true, destructiveHint: false });
  const name = list.result.tools[0].name;
  const response = await (await call('tools/call', { name, arguments: { query: 'a' } })).json();
  assert.equal(response.result.isError, false);
  assert.deepEqual(invocations[0][0], handle);
  assert.equal(invocations[0][2].confirmation, undefined);
  const wrong = await (await call('tools/call', { name: 'invented', arguments: {} })).json();
  assert.equal(wrong.result.isError, true);
  await gateway.close();
  assert.equal(gateway.token, null);
});

test('gateway detects catalog revision changes and replaces stale discovered handles', async t => {
  const handle = { pluginId: 'p', instanceId: 'first', capabilityId: 'read', version: 1, descriptorRevision: 1 };
  let catalogRevision = 1;
  const capabilities = { discover: async () => ({ catalogRevision, providers: [{
    handle: { ...handle, instanceId: catalogRevision === 1 ? 'first' : 'second' }, state: 'ready', descriptor: {
      title: 'Read', description: 'Read', inputSchema: { type: 'object' }, effects: ['document.read'] }
  }] }) };
  const gateway = new CapabilityGateway({ capabilities });
  await gateway.start();
  t.after(() => gateway.close());
  const initial = await gateway.dispatch({ method: 'tools/list' });
  assert.equal(await gateway.refreshCatalog(), false);
  catalogRevision = 2;
  assert.equal(await gateway.refreshCatalog(), true);
  const next = await gateway.dispatch({ method: 'tools/list' });
  assert.notEqual(initial.tools[0].name, next.tools[0].name);
  const stale = await gateway.dispatch({ method: 'tools/call', params: { name: initial.tools[0].name, arguments: {} } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /失效/);
});
