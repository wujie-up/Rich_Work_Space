import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAdapter } from '../src/main/common/adapters/claude.js';

test('Claude terminal uses native session IDs, explicit permission and empty system MCP settings', () => {
  const adapter = createClaudeAdapter();
  const launch = adapter.buildLaunch({ sessionDataDir: '/tmp/logs/abc', permission: 'plan' });
  assert.deepEqual(launch.args.slice(-2), ['--session-id', 'abc']);
  assert.ok(launch.args.includes('--strict-mcp-config'));
  assert.equal(adapter.resolveContext({ sessionDataDir: '/tmp/logs/abc' }), 'abc');
  assert.deepEqual(adapter.buildLaunch({ mode: 'resume', contextId: 'abc' }).args.slice(-2), ['--resume', 'abc']);
  assert.throws(() => adapter.buildLaunch({ permission: 'unrestricted' }), /权限/);
  assert.throws(() => adapter.buildLaunch({ mode: 'resume' }), /上下文/);
});


test('Claude receives explicit desktop MCP connections without importing system MCP settings', () => {
  const config = { mcpServers: { desk_test: { type: 'http', url: 'http://127.0.0.1:123/mcp', headers: { Authorization: 'Bearer temporary' } } } };
  const launch = createClaudeAdapter().buildLaunch({ mode: 'resume', contextId: 'abc', launchOverrides: config });
  assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf('--mcp-config') + 1]), config);
  assert.ok(launch.args.includes('--strict-mcp-config'));
  assert.deepEqual(launch.args.slice(-2), ['--resume', 'abc']);
});
