import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginHostOrigin, pluginIdentity } from '../../desk/src/resource/plugin-host.js';
test('plugin bridge preserves native protocol and validates HTTPS parent without wildcards', () => {
  assert.equal(pluginHostOrigin({ protocol: 'desk-plugin:' }), 'desk-host://desktop');
  const location = { protocol: 'https:', hostname: 'localhost', origin: 'https://localhost:1235', search: '?deskPlugin=mcp' };
  assert.equal(pluginHostOrigin(location, 'https://localhost:1234/'), 'https://localhost:1234');
  assert.throws(() => pluginHostOrigin(location, 'https://evil.test:1234/'));
  assert.throws(() => pluginHostOrigin(location, 'http://localhost:1234/'));
  assert.equal(pluginIdentity(location), 'mcp');
  assert.equal(pluginIdentity({ protocol: 'desk-plugin:', hostname: 'ai-agent-sessions' }), 'ai-agent-sessions');
});
