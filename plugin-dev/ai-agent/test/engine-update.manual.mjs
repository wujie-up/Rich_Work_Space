// Exercise the real official update path exclusively in a temporary plugin-owned directory.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as tar from 'tar';
import { EngineManager } from '../src/main/common/engines.js';

const engineId = process.argv[3] || 'claude';
const root = await mkdtemp(join(tmpdir(), 'agent-update-native-'));
const manager = new EngineManager({ root, tar });
try {
  const old = await manager.runtime(engineId).install(process.argv[2]);
  const profile = await manager.providers.save({ name: 'Preservation fixture', engineId, protocol: engineId === 'codex' ? 'responses' : 'anthropic',
    baseUrl: 'https://example.invalid', model: 'fixture', apiKey: 'synthetic-update-key' });
  await manager.configure({ engines: { [engineId]: { providerId: profile.id, reuseRules: true } } });
  const history = join(root, 'history-fixture.json');
  await writeFile(history, '{"preserve":true}');
  const files = ['engines.json', 'providers.json', 'history-fixture.json'];
  const before = await Promise.all(files.map(file => readFile(join(root, file))));
  const versions = await manager.releases.list(engineId);
  const target = versions.find(version => version.version !== old.version);
  assert.ok(target, 'Official catalog must contain a different version for this update check');
  manager.install(engineId, undefined, target.version);
  const deadline = Date.now() + 360000;
  while (manager.installations.get(engineId).state === 'installing' && Date.now() < deadline) { await delay(500); }
  assert.deepEqual(manager.installations.get(engineId), { state: 'complete' });
  const active = await manager.runtime(engineId).status();
  assert.equal(active.version, target.version);
  assert.equal(active.sha256, target.sha256);
  assert.equal((await manager.runtime(engineId).status(old.runtimeId)).state, 'ready');
  for (let index = 0; index < files.length; index++) {
    assert.deepEqual(await readFile(join(root, files[index])), before[index]);
  }
  await manager.remove(engineId);
  assert.equal((await manager.runtime(engineId).status()).state, 'missing');
  assert.equal((await manager.runtime(engineId).status(old.runtimeId)).state, 'ready');
  console.log(JSON.stringify({ engine: engineId, from: old.version, to: active.version, officialDownloadAndNativeProbe: 'PASS',
    sha256: active.sha256, historyRuntimeAfterRemoval: 'PASS', preservedConfigSecretHistory: 'PASS' }, null, 2));
} finally {
  manager.stop();
  await rm(root, { recursive: true, force: true });
}
