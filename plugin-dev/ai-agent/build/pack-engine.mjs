import { copyFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { ManagedRuntime } from '../src/main/common/managed-runtime.js';
import { ENGINE_PIN } from '../src/main/common/engine-pin.js';

const root = await mkdtemp(join(tmpdir(), 'rws-engine-pack-'));
try {
  const runtime = new ManagedRuntime({ root, tar });
  const source = process.argv[2];
  if (!source) {
    throw Error('Usage: node build/pack-engine.mjs /path/to/official-package.tar.gz');
  }
  await runtime.verifyArchive(resolve(source));
  const output = fileURLToPath(new URL('../../../plugin-dev/dist/', import.meta.url));
  await mkdir(output, { recursive: true });
  const name = `${ENGINE_PIN.runtimeId}.engine.tar.gz`;
  await copyFile(resolve(source), join(output, name));
  await writeFile(join(output, `${name}.json`), JSON.stringify({ ...ENGINE_PIN, archive: name,
    format: 'official-full-native-package', verifiedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(JSON.stringify({ archive: join(output, name), sha256: ENGINE_PIN.sha256, version: ENGINE_PIN.version }));
} finally {
  await rm(root, { recursive: true, force: true });
}
