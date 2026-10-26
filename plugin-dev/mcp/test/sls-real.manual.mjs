// Explicit live read-only verification; credentials stay in local configuration and process memory.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, owner, openWorkspace } from '../../../desk/test/electron/helpers.js';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') { delete process.env[key]; }
}
const root = resolve('plugin-dev/mcp/examples/sls');
const python = `import importlib.util,json\ns=importlib.util.spec_from_file_location('sls','/Users/wujie/.codex/skills/sls-prod-triage/scripts/sls_session.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps(m.load_config('/Users/wujie/IdeaProjects/biz','br','appserver')))`;
const config = JSON.parse(execFileSync('python3', ['-c', python], { encoding: 'utf8' }));
const env = { SLS_ENDPOINT: config.endpoint, SLS_PROJECT: config.project, SLS_LOGSTORE: config.logStore,
  ALIBABA_CLOUD_ACCESS_KEY_ID: config.accessKeyId, ALIBABA_CLOUD_ACCESS_KEY_SECRET: config.accessKeySecret,
  ALIBABA_CLOUD_SECURITY_TOKEN: config.securityToken };
const manifest = JSON.parse(await readFile(join(root, 'mcp-service.json'), 'utf8'));
const files = await Promise.all(['server.mjs', 'mcp-service.json'].map(async path => ({ path, content: await readFile(join(root, path), 'utf8') })));
const definition = { id: 'sls-br-appserver', ...manifest, transport: 'script', interpreter: process.execPath, env, files };
const cleanup = [];
const directory = resolve('.test-results/sls-mcp');
await mkdir(directory, { recursive: true });
const report = { archive: 'mcp-services-0.3.1.plg', target: { country: 'br', service: 'appserver', project: config.project, logstore: config.logStore, endpoint: config.endpoint }, checks: [] };
try {
  const { app, page, data } = await launch({ after: fn => cleanup.push(fn) }, { openPlugin: false });
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('mcp-services', 'remove');
    await workDesk.plugins.remove('mcp-services', 'keep', preview.confirmationToken);
  });
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); },
    resolve('plugins/dist/mcp-services-0.3.1.plg'));
  await page.evaluate(() => workDesk.plugins.install());
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('mcp-services', method, args), { method, args });
  await invoke('mcp.save', definition);
  await invoke('mcp.start', definition.id);
  assert.equal((await invoke('mcp.tools', definition.id)).tools[0].name, 'sls_query');
  report.checks.push('package install, JS deployment, initialize and tools/list');
  const query = { query: '* | select count(*) as matched_logs limit 1', minutes: 5, lines: 1 };
  const result = await invoke('mcp.call', definition.id, 'sls_query', query);
  assert.ok(!result.isError, 'live SLS tool query must succeed');
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, 'ok');
  assert.equal(body.progress, 'Complete');
  assert.ok(body.logs.length === 1 && Number.isFinite(Number(body.logs[0].matched_logs)));
  report.query = body;
  report.checks.push('real HTTPS SLS GetLogs: Complete, one aggregate row');
  await openWorkspace(page, 'mcp-services');
  const frame = page.frameLocator('iframe[title="MCP 服务"]');
  assert.equal(await frame.locator('#ai-settings, #save-ai, #import-ai').count(), 0);
  await frame.locator('#tools').click();
  await frame.locator('#tool option[value="sls_query"]').waitFor({ state: 'attached' });
  await frame.locator('#arguments').fill(JSON.stringify(query));
  await frame.locator('#call').click();
  await frame.locator('#result').getByText(/matched_logs/).waitFor();
  // Do not capture password fields, even masked; only the result and tool controls are retained.
  await frame.locator('#result').screenshot({ path: join(directory, 'live-sls-result.png') });
  report.checks.push('MCP UI: removed AI section, discover and live tool call');
  const connections = await invoke('mcp.connections');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const connection = connections.services.find(value => value.id === definition.id);
  const client = new Client({ name: 'sls-agent-check', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    assert.equal((await client.listTools()).tools[0].name, 'sls_query');
    assert.ok(!(await client.callTool({ name: 'sls_query', arguments: query })).isError);
  } finally { await client.close(); }
  report.checks.push('authenticated Agent gateway: initialize, tools/list and real SLS call');
  // Verify the actual AI plugin's automatic launch contract, without exposing gateway tokens.
  const auto = await invoke('mcp.ai.launch', { clientId: 'codex' });
  assert.ok(auto.overrides.some(value => value.includes('mcp_servers.')));
  assert.ok(!JSON.stringify(auto).includes(config.accessKeySecret));
  report.checks.push('automatic Codex launch configuration contains SLS gateway and no upstream secret');
  if (process.env.SLS_REAL_CODEX === '1') {
    const cwd = join(data, 'agent-workspace');
    await mkdir(cwd, { recursive: true });
    const prompt = 'Use the available sls_query MCP tool exactly once with query "* | select count(*) as matched_logs limit 1", minutes 5, lines 1. You must actually invoke the tool. Reply only with status, progress and matched_logs from the result. Do not use shell or other tools.';
    const args = ['--no-daemon', '--no-alt-screen', '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`, prompt];
    await page.evaluate(({ owner, args }) => workDesk.plugins.invoke(owner, 'storage.saveAdapterConfig', [{ codex: { command: 'codex', args } }]), { owner, args });
    const before = (await invoke('mcp.logs', definition.id)).split('tool=sls_query status=ok').length;
    const session = await page.evaluate(({ owner, cwd }) => workDesk.plugins.invoke(owner, 'sessions.create', [
      { adapterId: 'codex', name: 'SLS MCP verification', cwd, permission: 'unrestricted' }
    ]), { owner, cwd });
    let called = false;
    for (const deadline = Date.now() + 150000; Date.now() < deadline;) {
      const logs = await invoke('mcp.logs', definition.id);
      if (logs.split('tool=sls_query status=ok').length > before) { called = true; break; }
      const state = await page.evaluate(({ owner, id }) => workDesk.plugins.invoke(owner, 'sessions.attach', [id]), { owner, id: session.id });
      if (state.exited) { break; }
      await delay(750);
    }
    await delay(3000);
    const snapshot = await page.evaluate(({ owner, id }) => workDesk.plugins.invoke(owner, 'sessions.attach', [id]), { owner, id: session.id });
    await writeFile(join(directory, 'codex-transcript.txt'), snapshot.data);
    assert.ok(called, 'Codex must actually invoke live sls_query; see codex-transcript.txt');
    await page.evaluate(({ owner, id }) => workDesk.plugins.invoke(owner, 'sessions.archive', [id]), { owner, id: session.id });
    report.checks.push('real Codex session through AI Agent plugin actually invoked sls_query successfully');
  }
  await invoke('mcp.stop', definition.id);
  await invoke('mcp.start', definition.id);
  assert.ok(!(await invoke('mcp.call', definition.id, 'sls_query', query)).isError);
  report.checks.push('stop/start preserves deployment and real query works again');
  report.passed = true;
} catch (error) {
  report.error = { message: error.message };
  process.exitCode = 1;
} finally {
  for (const fn of cleanup.reverse()) { await fn(); }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
