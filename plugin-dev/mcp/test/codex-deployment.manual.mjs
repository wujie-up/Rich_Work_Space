// Explicit smoke test: real Codex and MCP processes, isolated from installed plugin data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, owner } from '../../../desk/test/electron/helpers.js';
import { remoteFixture } from './remote-fixture.mjs';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') { delete process.env[key]; }
}
const cleanup = [];
const report = { cases: [], archive: 'mcp-services-0.3.0.plg' };
const remote = await remoteFixture();
cleanup.push(() => remote.close());
const directory = resolve('.test-results/mcp-deployment');
await mkdir(directory, { recursive: true });
try {
  const { app, page, data } = await launch({ after: fn => cleanup.push(fn) }, { openPlugin: false });
  await page.evaluate(async () => {
    const preview = await workDesk.plugins.preview('mcp-services', 'remove');
    await workDesk.plugins.remove('mcp-services', 'keep', preview.confirmationToken);
  });
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
  }, resolve('plugins/dist/mcp-services-0.3.0.plg'));
  await page.evaluate(() => workDesk.plugins.install());
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('mcp-services', method, args), { method, args });
  for (const [language, entry, interpreter] of [
    ['python', 'server.py', execFileSync('which', ['python3'], { encoding: 'utf8' }).trim()],
    ['javascript', 'server.mjs', process.execPath]
  ]) {
    await invoke('mcp.save', { id: language, name: language, transport: 'script', language, entry, interpreter,
      fields: [{ name: 'ENDPOINT', label: 'Address', required: true }, { name: 'API_KEY', label: 'Key', secret: true }],
      env: { ENDPOINT: `https://${language}.example.test`, API_KEY: `test-key-${language}` },
      files: [{ path: entry, content: await readFile(new URL(`./script-fixture.${language === 'python' ? 'py' : 'mjs'}`, import.meta.url), 'utf8') }] });
    await invoke('mcp.start', language);
  }
  await invoke('mcp.save', { id: 'remote', name: 'Remote forwarding', transport: 'http', url: remote.url, apiKey: remote.secret });
  await invoke('mcp.start', 'remote');
  const cwd = join(data, 'Agent MCP verification');
  await mkdir(cwd);
  const marker = `DEPLOY_${Date.now()}`;
  const prompt = `Call each of these available MCP tools exactly once: python_query, javascript_query, verification_echo. Pass text "${marker}" to each. You must actually call all three MCP tools, then reply with all three returned results. Do not call shell or other tools.`;
  const args = ['--no-daemon', '--no-alt-screen', '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`, prompt];
  await page.evaluate(({ owner, args }) => workDesk.plugins.invoke(owner, 'storage.saveAdapterConfig', [{ codex: { command: 'codex', args } }]), { owner, args });
  const session = await page.evaluate(({ owner, cwd }) => workDesk.plugins.invoke(owner, 'sessions.create', [
    { adapterId: 'codex', name: 'Three MCP deployments', cwd, permission: 'unrestricted' }
  ]), { owner, cwd });
  let transcript = '';
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const logs = await Promise.all(['python', 'javascript'].map(id => invoke('mcp.logs', id)));
    const snapshot = await page.evaluate(({ owner, id }) => workDesk.plugins.invoke(owner, 'sessions.attach', [id]), { owner, id: session.id });
    transcript = snapshot.data;
    if (logs[0].includes(`CALL:python_query:${marker}`) && logs[1].includes(`CALL:javascript_query:${marker}`)
      && remote.calls.some(call => call.arguments.text === marker)) {
      await delay(4000);
      transcript = (await page.evaluate(({ owner, id }) => workDesk.plugins.invoke(owner, 'sessions.attach', [id]), { owner, id: session.id })).data;
      for (const name of ['python_query', 'javascript_query', 'verification_echo']) { report.cases.push({ tool: name, agentCalled: true, marker }); }
      break;
    }
    await delay(750);
  }
  await writeFile(join(directory, 'codex-three-services.txt'), transcript);
  assert.equal(report.cases.length, 3, 'Agent must actually invoke all three tools');
  const archived = await page.evaluate(({ owner, id }) => workDesk.plugins.invoke(owner, 'sessions.archive', [id]), { owner, id: session.id });
  report.contextId = archived.contextId;
  report.passed = true;
} catch (error) {
  report.error = { message: error.message };
  process.exitCode = 1;
} finally {
  for (const fn of cleanup.reverse()) { await fn(); }
  await writeFile(join(directory, 'codex-three-services.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
