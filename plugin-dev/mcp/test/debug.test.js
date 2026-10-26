import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpServices } from '../src/main/common/services.js';
const require = createRequire(import.meta.url);
const until = async predicate => {
  for (let n = 0; n < 200; n++) {
    const value = await predicate();
    if (value) { return value; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('debug timeout');
};
async function fixture(t, mode) {
  const { McpDebug } = await import('../src/main/common/debug.js');
  const storage = await temporaryStore(t);
  const published = new Map();
  const invocations = new Map();
  let cancelled = 0;
  let calls = 0;
  const capabilities = {
    register: async (descriptor, handler) => published.set(descriptor.id, { descriptor, handler }),
    unregister: async id => published.delete(id),
    discover: async () => ({ providers: (mode === 'missing-ai' ? [] : ['start', 'read', 'cancel']).map(action => ({ state: 'ready', handle: { pluginId: 'ai', action },
      descriptor: { id: action === 'start' ? 'agent.mcp.debug.start.v1' : `agent.task.${action}.v1` } })) }),
    invoke: async (handle, input) => {
      let result = { state: 'running' };
      if (handle.action === 'start') {
        const entries = [...published.values()].filter(entry => entry.descriptor.source.serviceId === input.serviceId);
        assert.equal(entries.length, 2);
        assert.equal(entries[0].descriptor.source.debug, true);
        assert.ok(!(await services.connections()).services.some(service => service.id === input.serviceId));
        if (mode !== 'no-call' && mode !== 'wait') {
          const tools = await entries[0].handler({});
          if (tools.tools.length && mode !== 'describe') {
            result = await entries[1].handler({ name: tools.tools[0].name, arguments: { text: 'AI-DEBUG' } }, {});
            calls++;
          }
        }
      }
      if (handle.action === 'read') { result = { state: mode === 'wait' ? 'running' : 'succeeded', output: 'model says passed' }; }
      if (handle.action === 'cancel') { cancelled++; result = { state: 'cancelled' }; }
      const invocationId = String(invocations.size);
      invocations.set(invocationId, { state: 'succeeded', result });
      return { invocationId };
    },
    getInvocation: async id => invocations.get(id), cancel: async () => {}
  };
  const context = { storage, capabilities, pluginId: 'mcp-services', ownProcesses: () => {},
    importModule: name => import(pathToFileURL(require.resolve(name)).href) };
  const services = new McpServices(context);
  const debug = new McpDebug(context, services);
  t.after(async () => { await debug.close(); await services.close(); });
  const input = { id: 'saved', name: 'Echo', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./debug-fixture.mjs', import.meta.url)), ...(mode === 'empty' ? ['--empty'] : mode === 'error' ? ['--error'] : [])], env: {} };
  await services.save(input);
  await services.start(input.id);
  const before = await services.definitions();
  return { debug, services, input, before, calls: () => calls, cancelled: () => cancelled, published };
}
for (const mode of ['call', 'no-call', 'describe', 'empty', 'error']) {
  test(`AI debug ${mode}: actual evidence, saved service isolation and cleanup`, async t => {
    const f = await fixture(t, mode);
    const { id } = f.debug.start(f.input, '使用一个工具测试连通性');
    const result = await until(() => { const state = f.debug.read(id); return state.cleaned && state; });
    assert.equal(result.state, mode === 'call' ? 'passed' : 'incomplete');
    assert.equal(result.evidence.calls.length, f.calls());
    if (mode === 'call') { assert.equal(result.evidence.calls[0].result.content[0].text, 'AI-DEBUG'); }
    assert.deepEqual(await f.services.definitions(), f.before);
    assert.equal((await f.services.list())[0].state, 'running');
    assert.equal(f.services.running.size, 1);
    assert.equal(f.cancelled(), 1);
    assert.equal(f.published.size, 2);
  });
}
test('cancelling debug during service startup waits for and cleans the owned runtime', async t => {
  const f = await fixture(t, 'wait');
  const connect = f.services.connect.bind(f.services);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.services.connect = async (...args) => { await gate; return connect(...args); };
  const { id } = f.debug.start(f.input, '测试');
  await until(() => f.services.starting.size);
  const stopping = f.debug.cancel(id);
  release();
  await stopping;
  assert.equal(f.debug.read(id).state, 'cancelled');
  assert.equal(f.debug.read(id).cleaned, true);
  assert.equal(f.services.running.size, 1);
});

test('missing AI provider fails with a clear reason and still cleans the temporary service', async t => {
  const f = await fixture(t, 'missing-ai');
  const { id } = f.debug.start(f.input);
  const result = await until(() => { const state = f.debug.read(id); return state.state === 'cleanup-failed' || state.cleaned ? state : false; });
  assert.equal(result.cleaned, true);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /请启用/);
  assert.equal(f.services.running.size, 1);
});

test('cancelling running AI debug stops its task and keeps the saved runtime', async t => {
  const f = await fixture(t, 'wait');
  const { id } = f.debug.start(f.input);
  await until(() => f.debug.read(id).state === 'running' && f.debug.get(id).taskStarted);
  const result = await f.debug.cancel(id);
  assert.equal(result.cleaned, true);
  assert.equal(result.state, 'cancelled');
  assert.equal(f.cancelled(), 1);
  assert.equal(f.services.running.size, 1);
});

test('debug executes unsaved source and configuration then removes its deployment', async t => {
  const f = await fixture(t, 'call');
  const code = (await readFile(new URL('./script-fixture.mjs', import.meta.url), 'utf8')).replace('JS:', 'UNSAVED:');
  const { id } = f.debug.start({ ...f.input, transport: 'script', language: 'javascript', entry: 'server.mjs',
    interpreter: process.execPath, source: code, fields: [{ name: 'ENDPOINT', label: '地址', required: true }],
    env: { ENDPOINT: 'https://unsaved.example.test' } });
  const result = await until(() => { const state = f.debug.read(id); return state.cleaned && state; });
  assert.equal(result.state, 'passed');
  assert.equal(result.evidence.calls[0].result.content[0].text, 'UNSAVED:AI-DEBUG:https://unsaved.example.test');
  const config = f.debug.get(id).config;
  await assert.rejects(access(await f.services.deployments.directory(config.id, config.deployment)), { code: 'ENOENT' });
  assert.deepEqual(await f.services.definitions(), f.before);
});

test('cleanup waits for an asynchronous AI cancellation acknowledgement', async t => {
  const f = await fixture(t, 'call');
  const capabilities = f.services.context.capabilities;
  const getInvocation = capabilities.getInvocation;
  let pending = true;
  capabilities.getInvocation = async id => {
    const invocation = await getInvocation(id);
    if (invocation.result?.state === 'cancelled' && pending) {
      pending = false;
      return { state: 'running' };
    }
    return invocation;
  };
  const { id } = f.debug.start(f.input);
  const result = await until(() => {
    const state = f.debug.read(id);
    return state.cleaned || state.state === 'cleanup-failed' ? state : false;
  });
  assert.equal(result.state, 'passed');
  assert.equal(result.cleaned, true);
  assert.equal(pending, false);
});

test('AI cancellation failure releases local deployment and remains retryable without claiming complete cleanup', async t => {
  const f = await fixture(t, 'wait');
  const { id } = f.debug.start({ ...f.input, transport: 'script', language: 'javascript', entry: 'server.mjs',
    interpreter: process.execPath, source: await readFile(new URL('./script-fixture.mjs', import.meta.url), 'utf8'),
    env: { ENDPOINT: 'https://cleanup.example.test' } });
  await until(() => f.debug.get(id).taskStarted);
  const capabilities = f.services.context.capabilities;
  const discover = capabilities.discover;
  capabilities.discover = async () => ({ providers: [] });
  const result = await f.debug.cancel(id);
  assert.equal(result.state, 'cleanup-failed');
  assert.equal(result.cleaned, false);
  assert.equal(f.services.running.size, 1);
  const config = f.debug.get(id).config;
  await assert.rejects(access(await f.services.deployments.directory(config.id, config.deployment)), { code: 'ENOENT' });
  assert.throws(() => f.debug.start(f.input), /先结束/);
  capabilities.discover = discover;
  assert.equal((await f.debug.cancel(id)).cleaned, true);
});
