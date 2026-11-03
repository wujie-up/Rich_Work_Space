// Usage: node test/session-messages.native.manual.mjs <managed-codex-binary>
// The real CLI uses disposable data and a loopback model fixture; no credentials or live sessions are loaded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpRelay } from '../src/main/common/mcp-relay.js';
import { sessionTools } from '../src/main/common/session-messages.js';
import { createCodexAdapter } from '../src/main/common/adapters/codex.js';

const root = await mkdtemp(join(tmpdir(), 'agent-message-approval-'));
const executed = [];
const results = [];
let requests = 0;
const relay = new McpRelay({ builtin: {
  tools: sessionTools,
  call: async name => { executed.push(name); return { receipt: name }; }
} });
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) { body += chunk; }
  const input = JSON.parse(body);
  requests++;
  const catalog = (input.tools || []).flatMap(tool => tool.tools
    ? tool.tools.map(entry => ({ ...entry, namespace: tool.name })) : [tool]);
  const outputs = (input.input || []).filter(item => item.type === 'function_call_output');
  results.push(...outputs.map(item => String(item.output)));
  const names = ['agent_sessions_list', 'agent_session_send', 'agent_group_task', 'agent_messages_read'];
  const items = requests === 1 ? names.map((name, index) => {
    const tool = catalog.find(tool => tool.name === name || tool.name.endsWith(`__${name}`));
    assert.ok(tool, `Native catalog missing ${name}`);
    return { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: tool.name, namespace: tool.namespace,
      arguments: JSON.stringify(name === 'agent_session_send' ? { targetId: 'member', requestId: 'local', text: 'fixture' }
        : name === 'agent_group_task' ? { action: 'start', terminationCondition: 'fixture complete' } : {}) };
  }) : [{ id: 'msg_final', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'LOCAL_APPROVAL_CHECK_COMPLETE', annotations: [] }] }];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [output_index, item] of items.entries()) {
    response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index, item })}\n\n`);
  }
  response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {
    id: `resp_${requests}`, object: 'response', status: 'completed', created_at: Math.floor(Date.now() / 1000), output: items,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  } })}\n\n`);
});
try {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const overrides = await relay.start('codex', []);
  await writeFile(join(root, 'config.toml'), 'model_provider="fixture"\nmodel="fixture-model"\n'
    + `[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\n`
    + 'wire_api="responses"\nrequires_openai_auth=false\n');
  const launch = createCodexAdapter().buildLaunch({ permission: 'unrestricted', sessionDataDir: root, launchOverrides: overrides });
  const child = spawn(resolve(process.argv[2]), [...launch.args,
    'exec', '--skip-git-repo-check', 'Run local tool approval checks'],
  { cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  assert.equal(code, 0, output.slice(-2000));
  assert.deepEqual(executed, ['agent_sessions_list', 'agent_session_send', 'agent_group_task', 'agent_messages_read']);
  assert.ok(results.length >= 4);
  assert.ok(results.every(result => !result.includes('MCP tool call requires approval, but approval policy is never')));
  console.log(JSON.stringify({ executed, requests, provider: 'local fixture only' }));
} finally {
  await relay.close();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
