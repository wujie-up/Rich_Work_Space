import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pluginResources } from '../../../web/src/server/static-resources.js';
import { createInterface } from 'node:readline';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { WebWorkspace } from '../../../web/src/server/workspace.js';
import * as engine from '../node_modules/@number0/iroh/index.js';
import { AccessService } from '../src/main/common/access.js';

test('actual Swift assistant forwarding and certificate pin log in to an isolated Web workspace', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wd-swift-peer-'));
  const assistants = resolve('plugin-dev/web-access/assistants');
  const output = execFileSync('swift', ['build', '--package-path', assistants, '--show-bin-path'], { encoding: 'utf8' }).trim();
  const source = join(assistants, 'Shared/Client');
  const files = (await readdir(source)).filter(name => name.endsWith('.swift')).map(name => join(source, name));
  const binary = join(root, 'PeerCheck');
  execFileSync('swiftc', ['-swift-version', '5', '-parse-as-library', '-target', 'arm64-apple-macosx15.0',
    '-I', output, '-I', join(output, 'include'), ...files, join(assistants, 'test/PeerCheck.swift'),
    join(output, 'DeskLinkCore.o'), join(output, 'IrohLib.o'), join(output, 'libiroh_ffi.a'),
    '-framework', 'CoreWLAN', '-framework', 'SystemConfiguration', '-o', binary], { timeout: 60000, stdio: 'pipe' });
  await cp(join(output, 'DeskLink_DeskLinkClient.bundle'), join(root, 'DeskLink_DeskLinkClient.bundle'), { recursive: true });
  const storage = new Storage(root);
  const plugin = await storage.path('plugins/example');
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, 'index.html'), `<script>
    parent.postMessage('desk-plugin-fixture', new URL(location.href).searchParams.get('parent'));
  </script>`);
  await writeFile(join(plugin, 'cached.css'), 'body { color: black; }');
  const page = await readFile(join(plugin, 'index.html'), 'utf8');
  await writeFile(join(plugin, 'index.html'), '<link rel="stylesheet" href="cached.css">' + page);
  const inventory = Object.fromEntries(await Promise.all(['index.html', 'cached.css'].map(async name =>
    [name, createHash('sha256').update(await readFile(join(plugin, name))).digest('hex')])));
  await writeFile(join(plugin, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files: inventory }));
  const resources = await pluginResources(plugin);
  const plugins = { list: () => [{ id: 'example', state: 'enabled', views: [{ entry: 'index.html' }] }], assertEnabled: id => assert.equal(id, 'example') };
  await mkdir(join(root, 'web'), { recursive: true });
  await cp(resolve('web/dist'), join(root, 'web/dist'), { recursive: true });
  const web = new WebWorkspace({ root, storage, plugins, handlers: { 'plugins.list': plugins.list } });
  let appRequests = 0;
  const handle = web.handle.bind(web);
  web.handle = (request, response) => {
    if (['/app.js', '/app.css'].includes(new URL(request.url, 'https://localhost').pathname)) { appRequests++; }
    if (request.url.startsWith('/index.html?deskShell=')) { request.url = '/index.html?deskShell=' + '0'.repeat(64); }
    return handle(request, response);
  };
  const counts = new Map();
  const pluginResource = web.pluginResource.bind(web);
  web.pluginResource = (request, response, id, path) => {
    counts.set(path, (counts.get(path) || 0) + 1);
    return pluginResource(request, response, id, path);
  };
  const owner = { id: 'web-access', instanceId: 'swift-test' };
  const native = { ...engine, Endpoint: { bind: async options => {
    const builder = engine.Endpoint.builder();
    builder.applyMinimal();
    builder.bindAddr('127.0.0.1:0');
    builder.secretKey(options.secretKey);
    builder.alpns(options.alpns);
    return builder.bind();
  } } };
  const service = new AccessService({ context: { pluginId: 'web-access', storage, host: { transport: {
    describe: () => web.transport.describe(), open: input => web.transport.open(owner, input), revoke: id => web.transport.revoke(owner, id)
  } } }, platform: { loadEngine: async () => native } });
  let child;
  t.after(async () => {
    child?.kill();
    await service.stop();
    await web.close();
    await Promise.all([...storage.pending.values()]);
    await rm(root, { recursive: true, force: true });
  });
  await web.saveAccount('tester', 'testing-password');
  await web.configure({ enabled: true, port: 0 });
  await service.start();
  child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const messages = [];
  const lines = createInterface({ input: child.stdout });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(`Swift fixture exited ${code}: ${errors}`)));
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.type === 'broken-version') {
          writeFile(join(root, 'web/dist/shell-manifest.json'), JSON.stringify({ version: message.version, files: message.files })).catch(reject);
        }
        if (message.type === 'shell-local') { assert.equal(appRequests, 0); }
        if (message.type === 'shell-mismatch') { assert.equal(appRequests, 2); }
        if (message.type === 'shell-fallback') { assert.equal(appRequests, 4); }
        if (message.type === 'cache-reused') {
          assert.equal(counts.get('/' + resources.entry('index.html')), 1);
          assert.equal(counts.get('/__assets/' + resources.version + '/cached.css'), 1);
        }
        if (message.type === 'pending') { service.confirm(message.requestId).catch(reject); }
      } catch (error) { reject(error); }
    });
  });
  child.stdin.end(JSON.stringify(service.createInvitation()));
  await done;
  assert.equal(messages.at(-1).type, 'verified');
  assert.equal(service.status().devices.length, 1);
});
