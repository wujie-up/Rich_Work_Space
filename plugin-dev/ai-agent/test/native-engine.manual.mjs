// This check only uses fresh temporary data. It deliberately does not use a real account.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { ManagedRuntime } from '../src/main/common/managed-runtime.js';
import { AppServer } from '../src/main/common/app-server.js';
import { CapabilityGateway } from '../src/main/common/capability-gateway.js';

const root = await mkdtemp(join(tmpdir(), 'rws-native-check-'));
const events = [];
let server;
let gateway;
try {
  const runtime = new ManagedRuntime({ root, tar });
  await runtime.install(process.argv[2]);
  const launch = await runtime.launch();
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  gateway = new CapabilityGateway({ conversationId: 'native-check', capabilities: {
    discover: async () => ({ catalogRevision: 1, providers: [{ state: 'ready',
      handle: { pluginId: 'fixture', instanceId: 'one', capabilityId: 'read', version: 1, descriptorRevision: 1 },
      descriptor: { title: 'Read fixture', description: 'Read local fixture', effects: ['read'], inputSchema: { type: 'object', properties: {} } } }] })
  }, onInvocation: () => {} });
  await gateway.start();
  server = new AppServer({ onEvent: message => events.push(message.method) });
  const initialized = await server.start({ ...launch, cwd: root, env: { ...launch.env, WORK_DESK_MCP_TOKEN: gateway.token },
    args: [...launch.args, '-c', `mcp_servers.work_desk.url=${JSON.stringify(gateway.url)}`,
      '-c', 'mcp_servers.work_desk.bearer_token_env_var="WORK_DESK_MCP_TOKEN"', '-c', 'mcp_servers.work_desk.required=true'] });
  assert.ok(initialized.userAgent);
  const account = await server.request('account/read', { refreshToken: false });
  assert.equal(account.account, null, 'must not inherit system account/keychain');
  const models = await server.request('model/list', {});
  assert.ok(Array.isArray(models.data));
  const { thread } = await server.request('thread/start', { cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  assert.ok(thread.id);
  const status = await server.request('mcpServerStatus/list', {});
  assert.equal(status.data.some(entry => entry.name === 'work_desk' && Object.keys(entry.tools).length === 1), true);
  const turn = await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Say hello.' }] });
  assert.ok(turn.turn.id);
  let interrupt = 'accepted';
  try {
    await server.request('turn/interrupt', { threadId: thread.id, turnId: turn.turn.id });
  } catch (error) {
    assert.match(error.message, /no active turn/);
    interrupt = 'turn already completed without authentication';
  }
  console.log(JSON.stringify({ runtimeId: launch.runtimeId, account: 'isolated-null', models: models.data.length,
    nativeThread: true, nativeTurn: true, nativeInterrupt: interrupt, mcpTools: 1, events,
    profileDirectories: await readdir(join(root, 'profiles/default')), authentication: 'not tested: requires user login' }, null, 2));
} finally {
  server?.close();
  await gateway?.close();
  // Wait for native file handles to close before removing the temporary profile.
  await new Promise(resolve => setTimeout(resolve, 300));
  await rm(root, { recursive: true, force: true });
}
