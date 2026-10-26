import test from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../src/main/common/index.js';
import { Sessions } from '../src/main/common/sessions.js';
import { EngineManager } from '../src/main/common/engines.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('managed new, resume and fork launches discover fresh desktop MCP configuration', async t => {
  const storage = await temporaryStore(t);
  let sessions;
  let generation = 1;
  t.mock.method(Sessions.prototype, 'loadPlugin', async function () { sessions = this; });
  t.mock.method(EngineManager.prototype, 'launch', async () => ({
    command: '/managed/codex', args: ['--isolated'], runtimeId: 'installed', env: { CODEX_HOME: '/isolated' }
  }));
  const requests = [];
  const context = {
    pluginId: 'ai-agent-sessions', storage, importModule: async () => ({}),
    methods: { register() {} }, views: { register() {} }, lifecycle: { register() {} },
    capabilities: { register: async () => {} },
    services: {
      register() {}, discover: async () => [{}],
      invoke: async (_, input) => {
        requests.push(input);
        return { version: 1, overrides: [`mcp_servers.desk_test.url="http://localhost/${generation}/mcp"`] };
      }
    }
  };
  await activate(context);
  for (const mode of ['new', 'resume', 'fork']) {
    const launch = await sessions.adapter(context.pluginId, 'codex').buildLaunch({
      mode, runtimeId: 'installed', contextId: 'context', sessionDataDir: '/tmp/session', cwd: '/project', permission: 'request-approval'
    });
    assert.equal(launch.command, '/managed/codex');
    assert.equal(launch.env.CODEX_HOME, '/isolated');
    assert.equal(launch.args[0], '--isolated');
    assert.ok(launch.args.includes(`mcp_servers.desk_test.url="http://localhost/${generation}/mcp"`));
    if (mode !== 'new') {
      assert.deepEqual(launch.args.slice(-2), [mode, 'context']);
    }
    generation += 1;
  }
  assert.deepEqual(requests.map(value => value.mode), ['new', 'resume', 'fork']);
  context.services.invoke = async (_, input) => {
    assert.equal(input.clientId, 'claude');
    return { version: 1, mcpConfig: { mcpServers: { desk_logs: {
      type: 'http', url: 'http://localhost/mcp', headers: { Authorization: 'Bearer temporary' }
    } } } };
  };
  const claude = await sessions.adapter(context.pluginId, 'claude').buildLaunch({ mode: 'resume', contextId: 'claude-context' });
  assert.equal(JSON.parse(claude.args[claude.args.indexOf('--mcp-config') + 1]).mcpServers.desk_logs.type, 'http');
  assert.deepEqual(claude.args.slice(-2), ['--resume', 'claude-context']);
  context.services.invoke = async () => { throw Error('provider unavailable'); };
  await assert.rejects(sessions.adapter(context.pluginId, 'codex').buildLaunch({ mode: 'new' }), /provider unavailable/);
});
