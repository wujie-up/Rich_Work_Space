import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient } from '../src/main/common/agent-client.js';

test('uses the host authorization lease id for readiness, invocation and revoke', async () => {
  const methods = ['catalog', 'bind', 'submit', 'read', 'respond', 'cancel', 'suspend', 'unbind'];
  const ids = [];
  const client = new AgentClient({
    discover: async () => ({ providers: methods.map(method => ({ state: 'ready', handle: { pluginId: 'ai-agent-sessions', id: method },
      descriptor: { id: `agent.bridge.${method}.v1` } })) }),
    authorize: async () => ({ id: 'host-lease' }),
    authorization: async id => { assert.equal(id, 'host-lease'); return { state: 'granted' }; },
    invoke: async (handle, input, options) => { ids.push(options.authorizationId); return { invocationId: 'call' }; },
    getInvocation: async () => ({ state: 'succeeded', result: { targets: [] } }),
    revoke: async id => { ids.push(id); }
  });
  await client.authorize();
  assert.deepEqual(await client.call('catalog'), { targets: [] });
  await client.revoke();
  assert.deepEqual(ids, ['host-lease', 'host-lease']);
  assert.equal(await client.ready(), false);
});
