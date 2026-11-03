// Explicit network smoke test; never included in the offline domain test suite.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { Storage } from '../../../desk/src/main/common/storage.js';
import { Plugins } from '../../../desk/src/main/common/plugins.js';

const root = await mkdtemp(join(tmpdir(), 'ai-browser-install-'));
const plugins = new Plugins({ storage: new Storage(root) });
const server = createServer((req, res) => res.end('<title>Installed Chromium</title><h1>Ready</h1>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const started = Date.now();
try {
  await plugins.load();
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
  await plugins.install(fileURLToPath(new URL(`../../dist/ai-browser-${manifest.version}.plg`, import.meta.url)));
  await plugins.enable('ai-browser');
  await plugins.invoke('ai-browser', 'browser.install', [], { origin: 'native', chain: ['ai-browser'], deadline: Date.now() + 30000 });
  let status;
  const deadline = Date.now() + 150000;
  do {
    await delay(1000);
    status = await plugins.invoke('ai-browser', 'browser.status');
    if (Date.now() > deadline) {
      throw Error('Chromium installation exceeded the 150-second network smoke budget');
    }
  } while (status.installation.state === 'running');
  assert.equal(status.installation.state, 'succeeded');
  assert.equal(status.ready, true);
  const opened = await plugins.invoke('ai-browser', 'browser.open', [{ url: `http://127.0.0.1:${server.address().port}` }]);
  assert.equal(opened.completed, 1);
  const result = { engine: status.engine, installation: status.installation.state, opened: true, elapsedMs: Date.now() - started };
  const artifacts = fileURLToPath(new URL('../dist/verification/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'installation.json'), JSON.stringify(result, null, 2));
  console.info(result);
  await plugins.invoke('ai-browser', 'browser.close');
} finally {
  await plugins.forceQuit();
  await plugins.capabilities.flush();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
