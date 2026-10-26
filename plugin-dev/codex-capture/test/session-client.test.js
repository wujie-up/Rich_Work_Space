import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCaptureClient } from '../src/main/common/session-client.js';

test('old or missing AI reports unsupported instead of pretending recording', async () => {
  const client = new SessionCaptureClient({ discover: async () => [] });
  assert.deepEqual(await client.sources(), []);
  assert.equal((await client.status()).enabled, false);
  await assert.rejects(client.configure({ enabled: true, target: { pluginId: 'missing', instanceId: 'x', windowId: 'y', conversationId: 'z' } }), /Agent/);
});

test('selection stops old conversation, leases only selected target, body reads stay scoped', async () => {
  const calls = [];
  const provider = { pluginId: 'ai-agent', contract: 'agent.capture.v2', method: 'capture.service' };
  const client = new SessionCaptureClient({ discover: async () => [provider], invoke: async (_provider, input) => {
    calls.push(input);
    if (input.action === 'catalog') { return { version: 2, instanceId: 'instance', windows: [] }; }
    if (input.action === 'read') { return { data: 'YQ==', offset: 1, bytes: 1 }; }
    return { enabled: input.enabled ?? true, state: 'waiting' };
  } });
  const one = { pluginId: provider.pluginId, instanceId: 'instance', windowId: 'window', conversationId: 'one' };
  const two = { ...one, conversationId: 'two' };
  await client.configure({ target: one, enabled: true });
  await client.configure({ target: two, enabled: true });
  assert.ok(calls.some(input => input.action === 'configure' && input.conversationId === 'one' && input.enabled === false));
  await client.renew();
  assert.equal(calls.at(-1).conversationId, 'two');
  assert.equal((await client.read('log', 0)).data, 'YQ==');
  assert.equal(calls.at(-1).windowId, 'window');
  await client.stop();
  assert.equal(calls.at(-1).enabled, false);
});

test('a delayed status retains its original target when selection changes during the request', async () => {
  let resolveStatus;
  let started;
  const statusStarted = new Promise(resolve => { started = resolve; });
  const provider = { pluginId: 'agent', contract: 'agent.capture.v2' };
  const client = new SessionCaptureClient({ discover: async () => [provider], invoke: async (_provider, input) => {
    if (input.action === 'status') { started(); return new Promise(resolve => { resolveStatus = resolve; }); }
    return { enabled: input.enabled, state: input.enabled ? 'captured' : 'stopped' };
  } });
  const a = { pluginId: 'agent', instanceId: 'runtime', windowId: 'window', conversationId: 'a' };
  const b = { ...a, conversationId: 'b' };
  await client.configure({ target: a, enabled: true });
  const pending = client.status();
  await statusStarted;
  await client.configure({ target: b, enabled: false });
  resolveStatus({ enabled: true, state: 'captured', logDirectory: '/capture/a' });
  assert.deepEqual((await pending).target, a);
  assert.deepEqual(client.target, b);
});

test('a different viewer window cannot read the newly selected dialogue under an old target label', async () => {
  const provider = { pluginId: 'agent', contract: 'agent.capture.v2' };
  let bodyReads = 0;
  const client = new SessionCaptureClient({ discover: async () => [provider], invoke: async (_provider, input) => {
    if (input.action === 'list' || input.action === 'read') { bodyReads++; }
    return { enabled: input.enabled };
  } });
  const a = { pluginId: 'agent', instanceId: 'runtime', windowId: 'window-a', conversationId: 'a' };
  const b = { ...a, windowId: 'window-b', conversationId: 'b' };
  await client.configure({ target: a, enabled: true });
  await client.configure({ target: b, enabled: true });
  assert.throws(() => client.list(a), /目标/);
  assert.throws(() => client.read('log', 0, a), /目标/);
  assert.equal(bodyReads, 0);
  await client.stop();
});
