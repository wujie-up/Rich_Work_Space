import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpServices } from '../src/main/common/services.js';
import { LaunchConfig } from '../src/main/common/launch-config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const require = createRequire(import.meta.url);
const fields = [{ name: 'ENDPOINT', label: '业务地址', required: true }, { name: 'API_KEY', label: '密钥', secret: true, required: true }];
async function definition(language) {
  const extension = language === 'python' ? 'py' : 'mjs';
  return { id: language, name: language, transport: 'script', language, entry: `server.${extension}`,
    interpreter: language === 'javascript' ? process.execPath : 'python3', fields,
    env: { ENDPOINT: 'https://logs.example.test', API_KEY: 'deployment-private-key' },
    files: [{ path: `server.${extension}`, content: await readFile(new URL(`./script-fixture.${extension}`, import.meta.url), 'utf8') }] };
}
function manager(storage, pids = new Set()) {
  return new McpServices({ storage, pluginId: 'mcp-services', importModule: name => import(pathToFileURL(require.resolve(name)).href),
    ownProcesses: values => { pids.clear(); values.forEach(pid => pids.add(pid)); } });
}
for (const language of ['python', 'javascript']) {
  test(`deploy ${language}: real process, Agent gateway, restart and secret isolation`, async t => {
    const storage = await temporaryStore(t);
    const pids = new Set();
    const services = manager(storage, pids);
    t.after(() => services.close());
    const input = await definition(language);
    await services.save(input);
    const saved = (await services.definitions())[0];
    assert.equal(saved.language, language);
    assert.ok(!saved.files);
    await services.start(language);
    await assert.rejects(services.save({ ...input, env: {} }), /必填/);
    assert.equal((await services.list())[0].state, 'running');
    const launch = new LaunchConfig({ storage, pluginId: 'mcp-services', services: { discover: async () => [] } }, () => services.connections());
    const { overrides } = await launch.launch({ clientId: 'codex' });
    assert.equal(overrides.length, 2);
    assert.ok(!overrides.join('').includes(input.env.API_KEY));
    const connection = (await services.connections()).services[0];
    const client = new Client({ name: 'agent-verification', version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    const tool = (await client.listTools()).tools[0].name;
    assert.match((await client.callTool({ name: tool, arguments: { text: 'REAL' } })).content[0].text, /REAL:https:\/\/logs.example.test/);
    await client.close();
    const owned = [...pids];
    await services.stop(language);
    assert.deepEqual((await launch.launch({ clientId: 'codex' })).overrides, []);
    owned.forEach(pid => assert.throws(() => process.kill(pid, 0)));
    assert.ok(!(await services.logs(language)).includes(input.env.API_KEY));
    const restarted = manager(storage);
    t.after(() => restarted.close());
    await restarted.start(language);
    assert.match((await restarted.call(language, tool, { text: 'RESTART' })).content[0].text, /RESTART/);
    await restarted.stop(language);
    await restarted.save({ ...saved, env: { ...saved.env, ENDPOINT: 'https://new.example.test' } });
    assert.equal((await restarted.definitions())[0].deployment, saved.deployment);
  });
}

test('deployment validates paths, entry, fields and missing runtime while preserving old definitions', async t => {
  const storage = await temporaryStore(t);
  const services = manager(storage);
  t.after(() => services.close());
  const input = await definition('javascript');
  await services.save(input);
  const before = await services.definitions();
  const invalid = [
    { files: [{ path: '../escape.mjs', content: '' }] },
    { files: [{ path: '/absolute.mjs', content: '' }] },
    { files: [{ path: 'server.mjs', content: '' }, { path: 'server.mjs', content: '' }] },
    { entry: 'absent.mjs' }, { language: 'shell' }, { fields: [{ name: 'BAD-NAME' }] },
    { fields: [fields[0], fields[0]] }, { env: { API_KEY: 'only-key' } },
    { files: [{ path: 'server.mjs', content: 'x'.repeat(4 * 1024 * 1024 + 1) }] },
    { deployment: '/tmp/escape', files: undefined }
  ];
  for (const patch of invalid) { await assert.rejects(services.save({ ...input, ...patch })); }
  assert.deepEqual(await services.definitions(), before);
  await services.save({ ...before[0], interpreter: '/missing/python' });
  await assert.rejects(services.start(input.id), /启动失败/);
  assert.equal((await services.list())[0].state, 'error');
});

test('editing loaded source retains auxiliary files and saving running configuration stops only its instance', async t => {
  const storage = await temporaryStore(t);
  const services = manager(storage);
  t.after(() => services.close());
  const input = await definition('javascript');
  input.files.push({ path: 'lib/helper.mjs', content: 'export const value = 1;' });
  await services.save(input);
  const saved = (await services.definitions())[0];
  assert.equal(await services.source(saved.id), input.files[0].content);
  await services.start(saved.id);
  await services.save({ ...saved, source: `${input.files[0].content}\n// updated`, env: { ...saved.env, ENDPOINT: 'https://updated.test' } });
  const updated = (await services.definitions())[0];
  assert.equal((await services.list())[0].state, 'stopped');
  assert.notEqual(updated.deployment, saved.deployment);
  const files = await services.deployments.files(updated);
  assert.equal(files.find(file => file.path === 'lib/helper.mjs').content, input.files[1].content);
  assert.match(await services.source(saved.id), /updated$/);
  assert.equal(updated.env.API_KEY, saved.env.API_KEY);
  await services.start(saved.id);
  assert.equal((await services.list())[0].state, 'running');
});

test('reading or editing a deployment rejects symbolic links without stopping its runtime', async t => {
  const storage = await temporaryStore(t);
  const services = manager(storage);
  t.after(() => services.close());
  await services.save(await definition('javascript'));
  const saved = (await services.definitions())[0];
  await services.start(saved.id);
  await symlink('/etc/hosts', join(await services.deployments.directory(saved.id, saved.deployment), 'outside'));
  await assert.rejects(services.source(saved.id), /非普通文件/);
  await assert.rejects(services.save({ ...saved, source: 'updated' }), /非普通文件/);
  assert.equal((await services.list())[0].state, 'running');
});

test('Python runtime caches never enter editable source or copied deployments', async t => {
  const storage = await temporaryStore(t);
  const services = manager(storage);
  t.after(() => services.close());
  const input = await definition('python');
  await services.save(input);
  const saved = (await services.definitions())[0];
  const root = await services.deployments.directory(saved.id, saved.deployment);
  await mkdir(join(root, '__pycache__'));
  await writeFile(join(root, '__pycache__/helper.cpython.pyc'), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal(await services.source(saved.id), input.files[0].content);
  await services.save({ ...saved, source: input.files[0].content + '\n# edited' });
  assert.deepEqual((await services.deployments.files((await services.definitions())[0])).map(file => file.path), ['server.py']);
});
