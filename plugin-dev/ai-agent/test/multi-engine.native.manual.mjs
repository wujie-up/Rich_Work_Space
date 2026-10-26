import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as tar from 'tar';
import { EngineManager } from '../src/main/common/engines.js';
import { AppServer } from '../src/main/common/app-server.js';
import { ClaudeEngine } from '../src/main/common/claude-engine.js';
import { CapabilityGateway } from '../src/main/common/capability-gateway.js';

const root = await mkdtemp(join(tmpdir(), 'deckpg-multi-engine-native-'));
const manager = new EngineManager({ root, tar });
const results = [];
const servers = [];
const gateways = [];
try {
  for (const [id, archive] of [['codex', process.argv[2]], ['claude', process.argv[3]]]) {
    await manager.runtime(id).install(archive);
    const launch = await manager.launch(undefined, id);
    const server = id === 'codex' ? new AppServer() : new ClaudeEngine();
    servers.push(server);
    const gateway = new CapabilityGateway({ conversationId: 'native-check', capabilities: {
      discover: async () => ({ catalogRevision: 1, providers: [{ state: 'ready',
        handle: { pluginId: 'fixture', instanceId: 'one', capabilityId: 'read', version: 1, descriptorRevision: 1 },
        descriptor: { id: 'fixture.read', title: 'Read fixture', description: 'Read local fixture', effects: ['document.read'],
          inputSchema: { type: 'object', properties: {} } } }] })
    }, onInvocation: () => {} });
    await gateway.start();
    gateways.push(gateway);
    await server.start({ ...launch, cwd: launch.env.HOME, gateway: { url: gateway.url, token: gateway.token },
      env: { ...launch.env, WORK_DESK_MCP_TOKEN: gateway.token },
      args: [...launch.args, '-c', `mcp_servers.work_desk.url=${JSON.stringify(gateway.url)}`,
        '-c', 'mcp_servers.work_desk.bearer_token_env_var="WORK_DESK_MCP_TOKEN"', '-c', 'mcp_servers.work_desk.required=true'] });
    if (id === 'codex') {
      assert.equal((await server.request('account/read', { refreshToken: false })).account, null);
      assert.ok((await server.request('model/list')).data.length);
      await server.request('thread/start', { cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
      const status = await server.request('mcpServerStatus/list');
      assert.equal(status.data.some(entry => entry.name === 'work_desk' && Object.keys(entry.tools).length === 1), true);
    } else {
      assert.equal((await manager.account('account/read')).account, null);
      const status = await server.request('mcp_status');
      assert.equal(status.mcpServers.some(entry => entry.name === 'work_desk' && entry.status === 'connected'), true);
    }
    results.push({ engine: id, version: launch.runtimeVersion, install: 'passed', isolatedAccount: 'logged-out', nativeProtocol: 'passed', nativeToolDiscovery: 'passed' });
    await server.closeTask();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const server of servers) { await server.closeTask(); }
  for (const gateway of gateways) { await gateway.close(); }
  manager.stop();
  await rm(root, { recursive: true, force: true });
}
