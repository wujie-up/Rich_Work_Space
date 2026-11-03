import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Plugins } from '../../../desk/src/main/common/plugins.js';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { nativeGateway } from './fixtures/native-gateway.mjs';

const packages = ['ai-agent-sessions-0.6.124.plg', 'message-bridge-0.1.3.plg']
  .map(name => fileURLToPath(new URL(`../../dist/${name}`, import.meta.url)));

test('built packages start separate workers, survive peer failure, and retain isolated data', async t => {
  const cleanup = [];
  const storage = await temporaryStore({ after: work => cleanup.push(work) });
  const plugins = new Plugins({ storage });
  t.after(async () => {
    await plugins.forceQuit();
    for (const work of cleanup) { await work(); }
  });
  await plugins.load();
  assert.deepEqual(plugins.list(), []);
  for (const source of packages) {
    const record = await plugins.install(source);
    await plugins.enable(record.id);
    await plugins.start(record.id);
  }
  const ai = plugins.loaded.get('ai-agent-sessions');
  const bridge = plugins.loaded.get('message-bridge');
  assert.ok(ai.child.pid && bridge.child.pid);
  assert.notEqual(ai.child.pid, bridge.child.pid);
  assert.notEqual(ai.child.pid, process.pid);
  assert.notEqual(bridge.child.pid, process.pid);
  assert.equal(plugins.capabilities.discover().providers.filter(item => item.descriptor.id.startsWith('agent.bridge.')).length, 8);
  assert.deepEqual((await plugins.invoke('message-bridge', 'bridge.snapshot')).channels, []);
  const gateway = await nativeGateway({ after: work => cleanup.push(work) });
  const nativeContext = () => ({ origin: 'native', chain: ['message-bridge'], deadline: Date.now() + 30000 });
  await plugins.invoke('message-bridge', 'bridge.saveChannel',
    [{ id: 'native-fixture', type: 'wechat', enabled: true, ...gateway.channel }], nativeContext());
  let snapshot;
  for (let n = 0; n < 200; n++) {
    snapshot = await plugins.invoke('message-bridge', 'bridge.snapshot');
    if (snapshot.channels[0].status.state === 'connected') { break; }
    await delay(10);
  }
  assert.equal(snapshot.channels[0].status.state, 'connected');
  assert.equal(snapshot.channels[0].token, undefined);
  await plugins.invoke('message-bridge', 'bridge.removeChannel', ['native-fixture'], nativeContext());
  await storage.writeJson('plugin-data/message-bridge/retained-fixture.json', { retained: true });
  bridge.child.kill('SIGKILL');
  for (let n = 0; n < 200 && !bridge.closed; n++) { await delay(10); }
  assert.equal(bridge.closed, true);
  assert.equal(Boolean(ai.closed), false);
  assert.deepEqual(await plugins.invoke('ai-agent-sessions', 'conversation.list'), []);
  await plugins.operations.get('message-bridge');
  await plugins.enable('message-bridge');
  await plugins.start('message-bridge');
  assert.notEqual(plugins.loaded.get('message-bridge').child.pid, bridge.child.pid);
  assert.deepEqual(await storage.readJson('plugin-data/message-bridge/retained-fixture.json'), { retained: true });
  assert.deepEqual((await plugins.invoke('message-bridge', 'bridge.snapshot')).channels, []);
});
