import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpServices } from '../src/main/common/services.js';
const require = createRequire(import.meta.url);
const importModule = name => import(pathToFileURL(require.resolve(name)).href);

test('real MCP tool publication, calls and desired-state recovery preserve configuration', async t => {
  const storage = await temporaryStore(t);
  const published = new Map();
  const context = { storage, pluginId: 'mcp-services', importModule, ownProcesses: () => {}, capabilities: {
    register: async (descriptor, handler) => { published.set(descriptor.id, { descriptor, handler }); },
    unregister: async id => published.delete(id)
  } };
  let services = new McpServices(context);
  t.after(() => services.close());
  await services.save({ id: 'echo', name: 'Echo', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixture.mjs', import.meta.url))], env: { KEEP_SECRET: 'not-in-catalog' } });
  const before = await storage.readJson(services.key);
  await services.start('echo');
  const [describe, entry] = published.values();
  assert.equal((await describe.handler({}, {})).tools[0].name, 'echo');
  assert.equal(entry.descriptor.source.serviceId, 'echo');
  assert.ok(!JSON.stringify(entry.descriptor).includes('not-in-catalog'));
  assert.equal((await entry.handler({ name: 'echo', arguments: { text: 'before-restart' } }, { signal: new AbortController().signal })).content[0].text,
    'before-restart');
  await services.close();
  assert.equal(published.size, 0);
  assert.deepEqual(await storage.readJson(services.desiredKey), ['echo']);
  services = new McpServices(context);
  await services.restore();
  assert.equal((await services.list())[0].state, 'running');
  assert.equal((await [...published.values()][1].handler({ name: 'echo', arguments: { text: 'after-restart' } },
    { signal: new AbortController().signal })).content[0].text, 'after-restart');
  assert.deepEqual(await storage.readJson(services.key), before);
  await services.stop('echo');
  assert.deepEqual(await storage.readJson(services.desiredKey), []);
  assert.equal(published.size, 0);
  await services.close();
  services = new McpServices(context);
  await services.restore();
  assert.equal((await services.list())[0].state, 'stopped');
});

test('publishing a service never lists upstream tools until AI requests its description', async () => {
  const { McpCapabilities } = await import('../src/main/common/capabilities.js');
  const published = [];
  let lists = 0;
  const capabilities = new McpCapabilities({ capabilities: {
    register: async (descriptor, handler) => published.push({ descriptor, handler }), unregister: async () => {}
  } }, { active: () => ({ config: { name: 'Example' } }), tools: async () => { lists++; return { tools: [] }; } });
  await capabilities.publish('example');
  assert.equal(lists, 0);
  assert.equal(published.length, 2);
  await published[0].handler({});
  assert.equal(lists, 1);
});

test('manual stop cancels a service still restoring and concurrent starts retain both desired IDs', async t => {
  const storage = await temporaryStore(t);
  const services = new McpServices({ storage, pluginId: 'mcp-services', importModule, ownProcesses: () => {} });
  t.after(() => services.close());
  await services.save({ id: 'echo', name: 'Echo', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixture.mjs', import.meta.url))] });
  const connect = services.connect.bind(services);
  let release;
  const opening = new Promise(resolve => { release = resolve; });
  services.connect = async (...args) => { await opening; return connect(...args); };
  const pending = services.start('echo', false);
  await new Promise(resolve => setTimeout(resolve, 20));
  const stopping = services.stop('echo');
  release();
  await assert.rejects(pending);
  await stopping;
  assert.equal(services.running.size, 0);
  assert.deepEqual(await storage.readJson(services.desiredKey), []);
  await Promise.all([services.desired('one', true), services.desired('two', true)]);
  assert.deepEqual((await storage.readJson(services.desiredKey)).sort(), ['one', 'two']);
});
