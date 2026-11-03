import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPackage } from '../../src/main/common/plugin-package.js';
const root = await mkdtemp(join(tmpdir(), 'deckpg-hash-bench-'));
try {
  const manifest = JSON.stringify({ id: 'hash-bench', name: 'Hash bench', version: '1', apiVersion: 2, dataVersion: 1, main: 'index.mjs' });
  const files = { 'plugin.json': createHash('sha256').update(manifest).digest('hex') };
  await writeFile(join(root, 'plugin.json'), manifest);
  let payload = Buffer.alloc(16 * 1024 * 1024, 42);
  for (let i = 0; i < 8; i += 1) {
    const name = i === 0 ? 'index.mjs' : `payload-${i}.bin`;
    files[name] = createHash('sha256').update(payload).digest('hex');
    await writeFile(join(root, name), payload);
  }
  payload = null;
  await writeFile(join(root, 'integrity.json'), JSON.stringify({ algorithm: 'sha256', files }));
  global.gc();
  const baseline = process.memoryUsage().arrayBuffers;
  let peak = baseline;
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 1);
  const start = performance.now();
  await inspectPackage(root);
  clearInterval(sample);
  console.log(JSON.stringify({ payloadMiB: 128, peakAdditionalBuffersMiB: (peak - baseline) / 1048576, elapsedMs: performance.now() - start }));
} finally { await rm(root, { recursive: true, force: true }); }
