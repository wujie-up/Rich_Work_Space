import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { temporaryStore, fixture } from '../../../../desk/test/helpers.js';
import { Plugins } from '../../../../desk/src/main/common/plugins.js';

test('MCP alone publishes AI launch config and imports old Adapter selections without reading its data', async t => {
  const storage = await temporaryStore(t);
  const plugins = new Plugins({ storage });
  t.after(async () => {
    for (const runtime of plugins.loaded.values()) {
      await runtime.close();
    }
  });
  await plugins.install(resolve('plugins/plugins/mcp'));
  const peer = await fixture(storage, 'ai-consumer');
  await writeFile(join(peer, 'index.mjs'), `export function activate(c) {
    c.methods.register('test.discover', () => c.services.discover('agent.launch-config.v1'));
    c.methods.register('test.launch', async () => {
      const [provider] = await c.services.discover('agent.launch-config.v1');
      return c.services.invoke(provider, { clientId: 'codex' });
    });
  } export function deactivate() {}`);
  await plugins.install(peer);
  assert.equal((await plugins.invoke('ai-consumer', 'test.discover'))[0].pluginId, 'mcp-services');
  assert.deepEqual(await plugins.invoke('ai-consumer', 'test.launch'), { version: 1, overrides: [] });
  const selection = [{ pluginId: 'mcp-services', serviceId: 'echo' }];
  await storage.writeJson('plugin-data/ai-mcp-adapter/config.json', selection);
  assert.deepEqual((await plugins.invoke('mcp-services', 'mcp.ai.list')).selected, []);
  await plugins.invoke('mcp-services', 'mcp.ai.save', [selection]);
  assert.deepEqual(await storage.readJson('plugin-data/mcp-services/ai-config.json'), selection);
  assert.deepEqual(await storage.readJson('plugin-data/ai-mcp-adapter/config.json'), selection);
  assert.deepEqual(await plugins.invoke('ai-consumer', 'test.launch'), {version:1,overrides:[]});
  await assert.rejects(plugins.invoke('mcp-services', 'mcp.ai.save', [[null]]));
  await assert.rejects(plugins.invoke('mcp-services', 'mcp.ai.save', [selection.concat(selection)]));
});
