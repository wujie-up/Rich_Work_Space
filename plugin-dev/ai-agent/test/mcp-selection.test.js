import test from 'node:test';
import assert from 'node:assert/strict';
import { filterLaunchServices, serviceAllowed, serviceCatalog } from '../src/main/common/mcp-selection.js';

test('selecting no MCP service removes terminal servers without excluding unrelated capabilities', () => {
  const selection = { mode: 'selected', services: [] };
  assert.deepEqual(filterLaunchServices('codex', ['mcp_servers.desk_abc.url="http://localhost"'], selection), []);
  assert.deepEqual(filterLaunchServices('claude', { mcpServers: { desk_abc: {} } }, selection), { mcpServers: {} });
  assert.equal(serviceAllowed({ handle: { pluginId: 'files' }, descriptor: { id: 'files.read' } }, selection), true);
  assert.equal(serviceAllowed({ handle: { pluginId: 'mcp' }, descriptor: { source: { serviceId: 'sls' } } }, selection), false);
});

test('service discovery groups the two wrapper capabilities and exposes no handles or credentials', () => {
  const catalog = serviceCatalog({ providers: ['describe', 'call'].map(action => ({ state: 'ready', handle: { pluginId: 'mcp', token: 'private' },
    descriptor: { id: action, title: `SLS · ${action}`, source: { serviceId: 'sls' } } })) });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].serviceId, 'sls');
  assert.equal(JSON.stringify(catalog).includes('private'), false);
  assert.equal(serviceAllowed({ handle: { pluginId: 'mcp' }, descriptor: { source: { serviceId: 'sls' } } },
    { mode: 'selected', services: [{ pluginId: 'mcp', serviceId: 'sls' }] }), true);
});

test('selected missing services fail explicitly instead of silently starting without tools', () => {
  const selected = { mode: 'selected', services: [{ pluginId: 'mcp', serviceId: 'missing' }] };
  assert.throws(() => filterLaunchServices('codex', [], selected), /不可用/);
  assert.throws(() => filterLaunchServices('claude', { mcpServers: {} }, selected), /不可用/);
});
