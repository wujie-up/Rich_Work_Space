import test from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../src/main/common/index.js';
import { Sessions } from '../src/main/common/sessions.js';
import { EngineManager } from '../src/main/common/engines.js';
import { createConversationMcp } from '../src/main/common/launch-config.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('structured native MCP honors chat selection, preserves background scope and excludes read-only tasks', async t => {
  let discovered = 0;
  const context = { pluginId: 'ai-agent-sessions', importModule: name => import(name), services: {
    discover: async () => { discovered++; return [{}]; },
    invoke: async () => ({ version: 1, overrides: ['mcp_servers.desk_fixture.url="http://127.0.0.1:123/mcp"',
      'mcp_servers.desk_fixture.http_headers={ Authorization = "Bearer fixture" }'] })
  } };
  const selection = { mode: 'selected', services: [] };
  const launch = { launchSettings: { mcp: selection } };
  assert.equal(await createConversationMcp(context, { engineId: 'claude' }, launch), null);
  assert.equal(await createConversationMcp(context, { task: { kind: 'plan' } }, launch), null);
  assert.equal(await createConversationMcp(context, { task: { kind: 'code' } }, launch), null);
  assert.equal(discovered, 0);
  const chat = await createConversationMcp(context, { id: 'chat' }, launch);
  t.after(() => chat.connection.close());
  assert.deepEqual(chat.args, []);
  const task = await createConversationMcp(context, { id: 'background', task: { background: { authorizationId: 'fixture' } } }, launch);
  t.after(() => task.connection.close());
  assert.ok(task.args.some(arg => arg.startsWith('mcp_servers.desk_fixture.url=')));
  assert.equal((await fetch(`${task.connection.url}/desk_fixture`)).status, 401);
  await task.connection.close();
  assert.equal(task.connection.server, null);
  context.services.invoke = async () => { throw Error('launch service unavailable'); };
  await assert.rejects(createConversationMcp(context, { id: 'failed' }, launch), /launch service unavailable/);
});

test('managed new, resume and fork launches discover fresh desktop MCP configuration', async t => {
  const storage = await temporaryStore(t);
  let sessions;
  let generation = 1;
  t.mock.method(Sessions.prototype, 'loadPlugin', async function () { sessions = this; });
  const launches = [];
  t.mock.method(EngineManager.prototype, 'launch', async (profileId, engineId, options) => {
    launches.push({ profileId, engineId, options });
    return { command: '/managed/codex', args: ['--isolated'], runtimeId: 'installed', env: { CODEX_HOME: '/isolated' } };
  });
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
      mode, runtimeId: 'old-installation', profileId: 'saved-account', launchSettings: { provider: null },
      contextId: 'context', sessionDataDir: '/tmp/session', cwd: '/project', permission: 'request-approval'
    });
    assert.equal(launch.command, '/managed/codex');
    assert.equal(launch.env.CODEX_HOME, '/isolated');
    assert.equal(launch.args[0], '--isolated');
    assert.equal(launch.runtimeId, 'installed');
    assert.deepEqual(launches.at(-1), { profileId: 'saved-account', engineId: 'codex',
      options: { runtimeId: undefined, snapshot: { provider: null } } });
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

test('production terminal launch owns a live relay and releases it on spawn failure or target archive', async t => {
  const { fakePty } = await import('../../../desk/test/helpers.js');
  const storage = await temporaryStore(t);
  const pty = fakePty();
  let sessions;
  t.mock.method(Sessions.prototype, 'loadPlugin', async function () { sessions = this; });
  t.mock.method(EngineManager.prototype, 'launch', async () => ({ command: '/managed/codex', args: [],
    runtimeId: 'installed', profileId: 'default', env: {}, isolated: true }));
  const context = { pluginId: 'ai-agent-sessions', storage, ownProcesses: () => {}, emit: () => {},
    resources: { report: () => {} }, importModule: async name => name === 'node-pty' ? pty : import(name),
    methods: { register() {} }, views: { register() {} }, lifecycle: { register() {} },
    capabilities: { register: async () => {}, discover: async () => ({ providers: [] }) },
    services: { register() {}, discover: async () => [{}],
      invoke: async () => ({ version: 1, overrides: ['mcp_servers.desk_test.url="http://127.0.0.1:123/mcp"',
        'mcp_servers.desk_test.http_headers={ Authorization = "Bearer upstream-secret" }'] }) } };
  await activate(context);
  sessions.capture = null;
  sessions.processControl = async session => session.terminal.kill();
  t.after(() => sessions.stopAndArchive(context.pluginId, 'quit'));
  const launch = sessions.adapter(context.pluginId, 'codex').buildLaunch;
  const relays = [];
  sessions.adapter(context.pluginId, 'codex').buildLaunch = async input => {
    const built = await launch(input);
    relays.push(built.mcpConnection);
    return built;
  };
  const spawn = sessions.spawn;
  sessions.spawn = () => { throw Error('spawn failed'); };
  await assert.rejects(sessions.create(context.pluginId, { adapterId: 'codex', cwd: storage.root, mode: 'new' }),
    { code: 'SESSION_LAUNCH_FAILED' });
  assert.equal(relays[0].server, null);
  sessions.spawn = spawn;
  const created = await sessions.create(context.pluginId, { adapterId: 'codex', cwd: storage.root, mode: 'new' });
  const peer = await sessions.create(context.pluginId, { adapterId: 'codex', cwd: storage.root, mode: 'new' });
  assert.equal((await fetch(relays[1].url)).status, 401);
  await sessions.archive(context.pluginId, created.id);
  assert.equal(relays[1].server, null);
  assert.equal((await fetch(relays[2].url)).status, 401);
  assert.equal(sessions.get(context.pluginId, peer.id).exited, false);
});
