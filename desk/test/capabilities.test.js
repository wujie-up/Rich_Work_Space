import test from 'node:test';
import assert from 'node:assert/strict';
import { Capabilities } from '../src/main/common/capabilities.js';
import { temporaryStore } from './helpers.js';

const descriptor = { id: 'document.read', version: 1, title: 'Read', description: 'Read a document',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  outputSchema: { type: 'string' }, effects: ['filesystem.read'], confirmation: 'policy',
  execution: { timeoutMs: 2000, cancellable: true, retry: 'never' } };
async function setup(t, handler = async input => input.path) {
  const storage = await temporaryStore(t);
  const runtime = { id: 'provider', instanceId: 'one', services: [], executeCapability: handler,
    notifyCapability() {}, cancelCapability() {} };
  const consumer = { id: 'consumer', instanceId: 'two', services: [], notifyCapability() {} };
  const loaded = new Map([['provider', runtime], ['consumer', consumer]]);
  const capabilities = new Capabilities({ storage, loaded, usable: () => true });
  await capabilities.load();
  await capabilities.register(runtime, descriptor);
  const handle = capabilities.discover().providers[0].handle;
  return { capabilities, runtime, consumer, handle, storage };
}
async function finished(capabilities, caller, id) {
  for (let n = 0; n < 100; n++) {
    const value = capabilities.get(caller, id);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.state)) {
      await capabilities.flush();
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('task did not finish');
}
test('registry shares services, validates schemas and invalidates changed handles', async t => {
  const { capabilities: c, runtime, consumer, handle } = await setup(t);
  assert.equal(runtime.services[0].contract, 'desk.capabilities.v1');
  await assert.rejects(c.invoke(consumer, handle, { path: 3 }), { code: 'INPUT_INVALID' });
  const task = await c.invoke(consumer, handle, { path: 'hello' });
  assert.equal((await finished(c, consumer, task.invocationId)).result, 'hello');
  await c.register(runtime, { ...descriptor, title: 'Changed' }, true);
  await assert.rejects(c.invoke(consumer, handle, { path: 'a' }), { code: 'CAPABILITY_CHANGED' });
  assert.throws(() => c.get(runtime, task.invocationId), { code: 'INVOCATION_FORBIDDEN' });
});
test('output validation, deadlines and cancellation do not close provider', async t => {
  const { capabilities: c, runtime, consumer, handle } = await setup(t, async () => 42);
  let task = await c.invoke(consumer, handle, { path: 'secret' });
  assert.equal((await finished(c, consumer, task.invocationId)).error.code, 'OUTPUT_INVALID');
  runtime.executeCapability = () => new Promise(() => {});
  task = await c.invoke(consumer, handle, { path: 'secret' }, { timeoutMs: 20 });
  assert.equal((await finished(c, consumer, task.invocationId)).error.code, 'CALL_TIMEOUT');
  runtime.executeCapability = (_input, context) => new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(Object.assign(Error('cancel'), { code: 'CANCELLED' })), { once: true });
  });
  task = await c.invoke(consumer, handle, { path: 'secret' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await c.cancel(consumer, task.invocationId)).state, 'cancelling');
  assert.equal((await finished(c, consumer, task.invocationId)).state, 'cancelled');
  assert.equal(runtime.closed, undefined);
});
test('cycles, provider revocation and restart interrupted records', async t => {
  const { capabilities: c, runtime, consumer, handle, storage } = await setup(t, () => new Promise(() => {}));
  await assert.rejects(c.invoke(consumer, handle, { path: 'a' }, {}, { chain: ['provider', 'consumer'], deadline: Date.now() + 1000 }), { code: 'SERVICE_CYCLE' });
  const task = await c.invoke(consumer, handle, { path: 'private-input' });
  c.revoke(runtime);
  assert.equal(c.discover().providers.length, 0);
  assert.equal((await finished(c, consumer, task.invocationId)).error.code, 'PROVIDER_UNAVAILABLE');
  await c.flush();
  const saved = await storage.readJson(`capability-invocations/${task.invocationId}.json`);
  assert.equal(JSON.stringify(saved).includes('private-input'), false);
  await storage.writeJson('capability-invocations/unfinished.json', { invocationId: 'unfinished', state: 'running' });
  const restarted = new Capabilities({ storage, loaded: new Map(), usable: () => true });
  await restarted.load();
  assert.equal((await storage.readJson('capability-invocations/unfinished.json')).state, 'interrupted');
});
test('write approval is bound to trusted host, descriptor and exact input', async t => {
  const { capabilities: c, runtime, consumer } = await setup(t);
  await c.register(runtime, { ...descriptor, effects: ['filesystem.write'] }, true);
  const handle = c.discover().providers[0].handle;
  const task = await c.invoke(consumer, handle, { path: 'x' }, { confirmed: true });
  assert.equal(c.get(consumer, task.invocationId).approvalRequired, true);
  await c.approve(task.invocationId, true);
  assert.equal((await finished(c, consumer, task.invocationId)).state, 'succeeded');
});
