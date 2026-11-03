// Explicit live verification through the host and Agent MCP gateway. Live DeskPG files are read only.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { Capabilities } from '../../../desk/src/main/common/capabilities.js';
import { CapabilityGateway } from '../../ai-agent/src/main/common/capability-gateway.js';
import { Conversations } from '../../ai-agent/src/main/common/conversations.js';
import { AgentTasks } from '../../ai-agent/src/main/common/tasks.js';
import { ManagedRuntime, prepareProfile, managedArgs } from '../../ai-agent/src/main/common/managed-runtime.js';
import { McpServices } from '../src/main/common/services.js';
import { BrowserTools } from '../src/main/common/browser-tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const cleanup = [];
const storage = await temporaryStore({ after: fn => cleanup.push(fn) });
const output = resolve('plugin-dev/dist/verification/browser-feishu-0.4.27');
await mkdir(output, { recursive: true });
const report = { version: '0.4.27', checks: [], liveDeskPGRestarted: false, liveDataModified: false };
const handlers = new Map();
const provider = { id: 'mcp-services', instanceId: 'isolated-real-check', services: [],
  executeCapability: (input, context) => handlers.get(context.capabilityId)(input, context) };
const agent = { id: 'ai-agent-sessions', instanceId: 'isolated-agent-check', services: [] };
const host = new Capabilities({ storage, loaded: new Map([[provider.id, provider], [agent.id, agent]]), usable: () => true });
const require = createRequire(import.meta.url);
const context = { storage, pluginId: provider.id, ownProcesses: () => {}, importModule: name => import(pathToFileURL(require.resolve(name)).href),
  capabilities: { register: async (descriptor, handler) => { handlers.set(descriptor.id, handler); await host.register(provider, descriptor); },
    unregister: (id, version) => host.unregister(provider, id, version) },
  host: { messages: { request: input => host.messages.request(provider, input), get: id => host.messages.get(provider, id),
    cancel: id => host.messages.cancel(provider, id) } } };
const browser = new BrowserTools(context);
const services = new McpServices(context);
const client = new Client({ name: 'real-workflow-tools-check', version: '1' });
let gateway;
let game;
let conversations;
let tasks;
try {
  await host.load();
  await browser.load();
  const liveRoot = join(homedir(), 'Library/Application Support/Work Desk/plugin-data/mcp-services');
  const config = JSON.parse(await readFile(join(liveRoot, 'services.json'), 'utf8')).find(value => value.id === 'feishu-doc');
  assert.ok(config, 'Configured Feishu service must exist');
  const deployment = join('plugin-data', provider.id, 'deployments', config.id, config.deployment);
  await cp(join(liveRoot, 'deployments', config.id, config.deployment), await storage.path(deployment), { recursive: true });
  const isolatedAuth = join(storage.root, 'feishu-private');
  await cp(config.env.FEISHU_DOC_DATA_DIR, isolatedAuth, { recursive: true });
  const isolatedConfig = { ...config, env: { ...config.env, FEISHU_DOC_DATA_DIR: isolatedAuth } };
  await storage.writeJson(services.key, [isolatedConfig]);
  await services.start(config.id, false);
  const authorization = await host.authorizations.request(agent, {
    scopeKey: 'explicit-browser-feishu-real-verification', providers: host.discover().providers.map(value => value.handle)
  });
  await host.messages.respond(host.messages.list()[0].id, { text: '允许并记住' });
  gateway = await new CapabilityGateway({ task: { kind: 'plan', background: { authorizationId: authorization.id } },
    capabilities: { discover: () => host.discover(), invoke: (handle, input, options) => host.invoke(agent, handle, input, options),
      getInvocation: id => host.get(agent, id), cancel: id => host.cancel(agent, id) }, onInvocation: () => {} }).start();
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), {
    requestInit: { headers: { Authorization: `Bearer ${gateway.token}` } }
  }));
  const catalog = (await client.listTools()).tools;
  const browserTool = catalog.find(value => /浏览器/.test(value.title));
  assert.ok(browserTool);
  report.checks.push('Browser discovered by Agent gateway with full host authorization');
  const browserCall = async input => {
    const result = await client.callTool({ name: browserTool.name, arguments: input });
    assert.ok(!result.isError, JSON.stringify(result));
    return input.action === 'screenshot' ? result : JSON.parse(result.content[0].text);
  };
  game = spawn(process.execPath, [join(homedir(), 'Documents/通用/pokemon-pixel-battle/scripts/serve.mjs')],
    { env: { ...process.env, PORT: '4187' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(game.stdout, 'data');
  const page = await browserCall({ action: 'open', url: 'http://127.0.0.1:4187/' });
  assert.match(page.title, /宝可梦/);
  report.browser = { title: page.title, actions: ['open', 'snapshot'] };
  await writeFile(join(output, 'game-initial-snapshot.txt'), page.snapshot);
  const started = await browserCall({ action: 'click', tabId: page.tabId, selector: '#start' });
  assert.doesNotMatch(started.snapshot, /配置双方阵容，点击开始对战/);
  const attack = await browserCall({ action: 'click', tabId: page.tabId, selector: '#moves button:first-child' });
  assert.match(attack.snapshot, /伤害|回合|攻击/);
  await browserCall({ action: 'click', tabId: page.tabId, selector: '#restart' });
  const selection = await browserCall({ action: 'select', tabId: page.tabId, role: 'combobox', name: '我方添加宝可梦', text: 'pikachu' });
  assert.match(selection.snapshot, /皮卡丘/);
  const screenshot = await browserCall({ action: 'screenshot', tabId: page.tabId });
  await writeFile(join(output, 'game-browser.png'), Buffer.from(screenshot.content[0].data, 'base64'));
  report.browser.actions.push('start battle', 'attack', 'restart', 'select', 'screenshot');
  report.checks.push('Real Pokémon application: start, attack, restart, select through the Agent gateway');
  const publicPage = await browserCall({ action: 'open', url: 'https://www.python.org/' });
  assert.match(publicPage.title, /Python/);
  await browserCall({ action: 'fill', tabId: publicPage.tabId, selector: '#id-search-field', text: 'asyncio' });
  const searched = await browserCall({ action: 'press', tabId: publicPage.tabId, selector: '#id-search-field', key: 'Enter' });
  assert.match(searched.url, /search/);
  report.checks.push('Real public HTTPS page: Python website search form fill and Enter navigation');
  const describe = catalog.find(value => /飞书.*工具说明/.test(value.title));
  const call = catalog.find(value => /飞书.*调用工具/.test(value.title));
  assert.ok(describe && call);
  const toolResult = await client.callTool({ name: describe.name, arguments: {} });
  assert.ok(!toolResult.isError);
  const tools = JSON.parse(toolResult.content[0].text).tools;
  await writeFile(join(output, 'feishu-tool-schemas.json'), JSON.stringify(tools, null, 2));
  report.feishu = { discovered: tools.map(value => value.name) };
  const url = new URL(process.env.FEISHU_VERIFY_URL || 'https://zc7iozpelf.feishu.cn/wiki/PcUZwb5dViS9lakCH4ecYIMKn7b');
  const invoke = async (tool, args) => {
    const result = await client.callTool({ name: call.name, arguments: { name: tool.name, arguments: args } });
    assert.ok(!result.isError, JSON.stringify(result).slice(0, 1200));
    return JSON.parse(result.content[0].text);
  };
  let documentId = url.pathname.split('/')[2];
  if (url.pathname.startsWith('/wiki/')) {
    const result = await invoke(tools.find(value => /wiki.*getNode/.test(value.name)), { params: { token: documentId } });
    assert.ok(result.node?.obj_token, 'Feishu wiki response must contain document token');
    documentId = result.node.obj_token;
  }
  const document = await invoke(tools.find(value => /document.*rawContent/.test(value.name)), { path: { document_id: documentId } });
  assert.ok(document.content?.length > 20, 'Feishu must return document body');
  report.feishu.documentCharacters = document.content.length;
  report.feishu.documentSha256 = createHash('sha256').update(document.content).digest('hex');
  report.checks.push('Configured Feishu MCP: real wiki resolution and document raw content through Agent gateway');
  if (process.env.VERIFY_NATIVE_AGENT === '1') {
    const liveAgent = join(homedir(), 'Library/Application Support/Work Desk/plugin-data/ai-agent-sessions');
    const runtime = await new ManagedRuntime({ root: liveAgent }).status();
    assert.equal(runtime.state, 'ready');
    const env = await prepareProfile(join(storage.root, 'native-profile'));
    await cp(join(liveAgent, 'profiles/default/codex/auth.json'), join(env.CODEX_HOME, 'auth.json'));
    const invocations = [];
    conversations = new Conversations({ storage, pluginId: agent.id, ownProcesses: () => {}, emit: () => {},
      capabilities: { discover: () => host.discover(), invoke: (handle, input, options) => {
        invocations.push({ capabilityId: handle.capabilityId, action: input.action, name: input.name });
        return host.invoke(agent, handle, input, options);
      }, getInvocation: id => host.get(agent, id), cancel: id => host.cancel(agent, id) },
      runtime: { launch: async () => ({ command: runtime.command, runtimeId: runtime.runtimeId, env, args: managedArgs }) } });
    await conversations.load();
    tasks = new AgentTasks({ conversations, storage, pluginId: agent.id });
    await tasks.load();
    const input = { taskKey: 'b'.repeat(64), prompt: '验证工作台工具，必须真实调用工具，不要用 shell、网络请求或自行编写脚本代替。'
      + '1. 使用浏览器工具打开 http://127.0.0.1:4187/ ，点击开始对战，点击第一个招式进行攻击，读取页面确认发生攻击。'
      + `2. 使用飞书 MCP 的工具说明、调用工具，读取 ${url.href} 的文档正文（wiki 先解析 obj_token）。`
      + '不要修改文档或授权配置，不要输出文档正文。完成后仅返回 JSON 对象 {"passed":true,"browser":true,"feishu":true,"characters":实际文档字符数}。'
      + '只有真实工具成功才可返回 true；失败返回 passed:false 和原因。' };
    await tasks.start('plan', input, { background: { authorizationId: authorization.id } });
    const deadline = Date.now() + 240000;
    let result;
    while (true) {
      result = await tasks.read(input);
      assert.equal((result.requests || []).length, 0, 'Unexpected native approval: user confirmation must not be simulated');
      if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(result.state)) { break; }
      assert.ok(Date.now() < deadline, 'Real model verification timed out');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    report.nativeAgent = { runtime: runtime.version, state: result.state, output: result.output, invocations };
    assert.equal(result.state, 'succeeded', result.error);
    const answer = JSON.parse(result.output);
    assert.equal(answer.passed && answer.browser && answer.feishu, true);
    assert.ok(invocations.some(value => value.action === 'click'));
    assert.ok(invocations.some(value => value.name === 'docx_v1_document_rawContent'));
    report.checks.push('Real managed Codex with real model: browser battle and Feishu document body via workflow background task');
  }
  report.passed = true;
} catch (error) {
  report.error = { message: error.message };
  console.error(error);
  process.exitCode = 1;
} finally {
  await tasks?.stop();
  for (const id of conversations?.engines.keys() || []) { await conversations.cancelTask(id); }
  await conversations?.stop();
  await client.close();
  await gateway?.close();
  await browser.close();
  await services.close();
  game?.kill();
  await host.flush();
  for (const fn of cleanup.reverse()) { await fn(); }
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
