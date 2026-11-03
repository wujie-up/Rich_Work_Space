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
  // Simulate history written by a host version without pending-call recovery records.
  await storage.io.rm(await storage.path('capability-recovery.json'), { force: true });
  const restarted = new Capabilities({ storage, loaded: new Map(), usable: () => true });
  await restarted.load();
  assert.equal((await storage.readJson('capability-invocations/unfinished.json')).state, 'interrupted');
});

test('startup migrates legacy history once, preserving completed records without reading them again', async t => {
  const storage = await temporaryStore(t);
  const completed = { invocationId: 'done', state: 'succeeded', finishedAt: 123 };
  await storage.writeJson('capability-invocations/done.json', completed);
  await storage.writeJson('capability-invocations/legacy.json', { invocationId: 'legacy', state: 'running' });
  const restart = () => new Capabilities({ storage, loaded: new Map(), usable: () => true });
  await restart().load();
  assert.deepEqual(await storage.readJson('capability-invocations/done.json'), completed);
  assert.equal((await storage.readJson('capability-invocations/legacy.json')).state, 'interrupted');
  const readJson = storage.readJson.bind(storage);
  storage.readJson = (key, ...args) => {
    assert.equal(key.startsWith('capability-invocations/'), false, 'completed history must stay on disk until requested');
    return readJson(key, ...args);
  };
  await restart().load();
});

test('startup recovers pending calls and retains a completed history when its pending marker remains', async t => {
  const { capabilities: c, consumer, handle, storage } = await setup(t, () => new Promise(() => {}));
  const task = await c.invoke(consumer, handle, { path: 'x' });
  await c.flush();
  const pendingKey = `capability-pending/${task.invocationId}.json`;
  assert.ok(await storage.readJson(pendingKey));
  const restarted = new Capabilities({ storage, loaded: new Map(), usable: () => true });
  await restarted.load();
  assert.equal((await storage.readJson(`capability-invocations/${task.invocationId}.json`)).state, 'interrupted');
  assert.equal(await storage.readJson(pendingKey), null);
  c.cancel(consumer, task.invocationId);
  c.finish(c.invocations.get(task.invocationId), 'cancelled');
  await c.flush();
  const completed = await storage.readJson(`capability-invocations/${task.invocationId}.json`);
  await storage.writeJson(pendingKey, { invocationId: task.invocationId, state: 'running' });
  await restarted.load();
  assert.deepEqual(await storage.readJson(`capability-invocations/${task.invocationId}.json`), completed);
  assert.equal(await storage.readJson(pendingKey), null);
});

test('completed calls retain history and remove pending recovery records', async t => {
  const { capabilities: c, consumer, handle, storage } = await setup(t);
  const task = await c.invoke(consumer, handle, { path: 'x' });
  await finished(c, consumer, task.invocationId);
  assert.equal(await storage.readJson(`capability-pending/${task.invocationId}.json`), null);
  assert.equal((await storage.readJson(`capability-invocations/${task.invocationId}.json`)).state, 'succeeded');
});

test('pending-only writes recover after a crash, and failed terminal writes keep recovery records', async t => {
  const storage = await temporaryStore(t);
  const c = new Capabilities({ storage, loaded: new Map(), usable: () => true });
  await c.load();
  await storage.writeJson('capability-pending/early-crash.json', { invocationId: 'early-crash', state: 'queued' });
  await c.load();
  assert.equal((await storage.readJson('capability-invocations/early-crash.json')).state, 'interrupted');
  await c.persist({ invocationId: 'write-failure', state: 'running' });
  const writeJson = storage.writeJson.bind(storage);
  storage.writeJson = (key, value) => value.state === 'succeeded' ? Promise.reject(Error('disk full')) : writeJson(key, value);
  await assert.rejects(c.persist({ invocationId: 'write-failure', state: 'succeeded' }), /disk full/);
  assert.equal((await storage.readJson('capability-pending/write-failure.json')).state, 'running');
  storage.writeJson = writeJson;
  await c.load();
  assert.equal((await storage.readJson('capability-invocations/write-failure.json')).state, 'interrupted');
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

test('approval wait does not consume execution time; execution still times out', async t => {
  const { capabilities: c, runtime, consumer } = await setup(t, () => new Promise(() => {}));
  await c.register(runtime, { ...descriptor, effects: ['filesystem.write'] }, true);
  const handle = c.discover().providers[0].handle;
  const task = await c.invoke(consumer, handle, { path: 'x' }, { timeoutMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(c.get(consumer, task.invocationId).approvalRequired, true);
  await c.approve(task.invocationId, true);
  assert.equal((await finished(c, consumer, task.invocationId)).error.code, 'CALL_TIMEOUT');
});

test('pending approval can be denied, cancelled or ended by its parent', async t => {
  let executions = 0;
  const { capabilities: c, runtime, consumer } = await setup(t, async () => { executions++; return 'x'; });
  await c.register(runtime, { ...descriptor, effects: ['filesystem.write'] }, true);
  const handle = c.discover().providers[0].handle;
  const denied = await c.invoke(consumer, handle, { path: 'x' });
  await c.approve(denied.invocationId, false);
  assert.equal(c.get(consumer, denied.invocationId).state, 'cancelled');
  const cancelled = await c.invoke(consumer, handle, { path: 'x' });
  c.cancel(consumer, cancelled.invocationId);
  await assert.rejects(c.approve(cancelled.invocationId, true), { code: 'APPROVAL_STALE' });
  const parent = new AbortController();
  const interrupted = await c.invoke(consumer, handle, { path: 'x' }, {}, { signal: parent.signal });
  parent.abort();
  assert.equal(c.get(consumer, interrupted.invocationId).state, 'interrupted');
  const expired = await c.invoke(consumer, handle, { path: 'x' }, {}, { deadline: Date.now() + 20 });
  assert.equal((await finished(c, consumer, expired.invocationId)).error.code, 'CALL_TIMEOUT');
  assert.equal(executions, 0);
  await c.flush();
});

test('approval cannot start an expired parent call or extend a live parent deadline', async t => {
  let executions = 0;
  const { capabilities: c, runtime, consumer } = await setup(t, () => { executions++; return new Promise(() => {}); });
  await c.register(runtime, { ...descriptor, effects: ['filesystem.write'] }, true);
  const handle = c.discover().providers[0].handle;
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const expired = await c.invoke(consumer, handle, { path: 'x' }, {}, { deadline: 100020 });
  t.mock.timers.tick(30);
  await c.approve(expired.invocationId, true);
  assert.equal(c.get(consumer, expired.invocationId).error.code, 'CALL_TIMEOUT');
  assert.equal(executions, 0);
  const live = await c.invoke(consumer, handle, { path: 'x' }, {}, { deadline: 100050 });
  await c.approve(live.invocationId, true);
  assert.equal(c.get(consumer, live.invocationId).deadline, 100050);
  assert.equal((await finished(c, consumer, live.invocationId)).error.code, 'CALL_TIMEOUT');
  assert.equal(executions, 1);
});

test('scoped consent requires host confirmation and rejects another instance or changed handle', async t => {
  const { capabilities: c, consumer, runtime } = await setup(t);
  await c.register(runtime, { ...descriptor, id: 'document.write', effects: ['filesystem.write'], confirmation: 'always' });
  const handle = c.discover({ id: 'document.write' }).providers[0].handle;
  const lease = await c.authorizations.request(consumer, { scopeKey: 'flow-one', providers: [handle] });
  assert.equal(lease.state, 'pending');
  let invocation = await c.invoke(consumer, handle, { path: 'one' }, { authorizationId: lease.id });
  assert.equal(c.get(consumer, invocation.invocationId).approvalRequired, true);
  c.cancel(consumer, invocation.invocationId);
  await c.messages.respond(c.messages.list()[0].id, { text: '允许并记住' });
  invocation = await c.invoke(consumer, handle, { path: 'two' }, { authorizationId: lease.id });
  assert.equal((await finished(c, consumer, invocation.invocationId)).result, 'two');
  assert.equal(c.authorizations.allows({ ...consumer }, lease.id, handle), false);
  await c.register(runtime, { ...descriptor, id: 'document.write', effects: ['filesystem.write'], confirmation: 'always' }, true);
  assert.equal(c.authorizations.allows(consumer, lease.id, c.discover({ id: 'document.write' }).providers[0].handle), false);
  c.revoke(runtime);
  assert.equal(c.authorizations.get(consumer, lease.id).state, 'revoked');
});


test('remembered consent is tied to installed code and a revoked pending grant cannot revive', async t => {
  const { capabilities: c, runtime, consumer } = await setup(t);
  runtime.packageIdentity = 'code-v1';
  consumer.packageIdentity = 'consumer-v1';
  const handle = c.discover().providers[0].handle;
  const input = { scopeKey: 'remember', providers: [handle] };
  const first = await c.authorizations.request(consumer, input);
  await c.messages.respond(c.messages.list()[0].id, { text: '允许并记住' });
  assert.equal((await c.authorizations.request(consumer, input)).state, 'granted');
  runtime.packageIdentity = 'code-v2';
  const changed = await c.authorizations.request(consumer, input);
  assert.equal(changed.state, 'pending');
  c.authorizations.revoke(consumer, changed.id);
  assert.equal(c.authorizations.get(consumer, first.id).state, 'granted');
  assert.equal(c.authorizations.get(consumer, changed.id).state, 'revoked');
});


test('revocation during consent loading cannot create an authorization or popup for a stopped runtime', async t => {
  const { capabilities: c, consumer, handle } = await setup(t);
  let finish;
  c.authorizations.storage = { readJson: () => new Promise(resolve => { finish = resolve; }) };
  const request = c.authorizations.request(consumer, { scopeKey: 'flow', providers: [handle] });
  c.authorizations.revokeRuntime(consumer);
  finish({});
  const lease = await request;
  assert.equal(lease.state, 'revoked');
  assert.equal(c.messages.list().length, 0);
});

test('automatic authorization skips the popup without remembering consent or granting other callers and handles', async t => {
  const { capabilities: c, consumer, runtime, storage } = await setup(t);
  await c.register(runtime, { ...descriptor, id: 'mcp.call', effects: ['mcp.tool'], confirmation: 'always' });
  const handle = c.discover({ id: 'mcp.call' }).providers[0].handle;
  const input = { scopeKey: 'payout-audit', providers: [handle] };
  const lease = await c.authorizations.request(consumer, { ...input, approval: 'automatic' });
  assert.equal(lease.state, 'granted');
  assert.equal(c.messages.list().length, 0);
  const invocation = await c.invoke(consumer, handle, { path: 'query' }, { authorizationId: lease.id });
  assert.equal(c.get(consumer, invocation.invocationId).approvalRequired, false);
  assert.equal((await finished(c, consumer, invocation.invocationId)).result, 'query');
  assert.equal(c.authorizations.allows({ ...consumer }, lease.id, handle), false);
  assert.equal(c.authorizations.allows(consumer, lease.id, c.discover({ id: 'document.read' }).providers[0].handle), false);
  assert.deepEqual(await storage.readJson('capability-consents.json', {}), {});
  assert.equal((await c.authorizations.request(consumer, input)).state, 'pending');
  c.revoke(runtime);
  assert.equal(c.authorizations.get(consumer, lease.id).state, 'revoked');
  assert.equal(c.authorizations.allows(consumer, lease.id, handle), false);
  assert.equal(c.messages.list().length, 0);
});

test('automatic authorization rejects stale handles and invalid approval modes', async t => {
  const { capabilities: c, consumer, runtime, handle } = await setup(t);
  await assert.rejects(c.authorizations.request(consumer, { scopeKey: 'flow', providers: [handle], approval: true }),
    { code: 'INPUT_INVALID' });
  await c.register(runtime, { ...descriptor, title: 'Changed' }, true);
  await assert.rejects(c.authorizations.request(consumer, { scopeKey: 'flow', providers: [handle], approval: 'automatic' }),
    { code: 'CAPABILITY_CHANGED' });
  assert.equal(c.messages.list().length, 0);
});
