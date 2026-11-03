import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Storage } from '../../../../desk/src/main/common/storage.js';
import { fakePty } from '../../../../desk/test/helpers.js';

// An optional module path runs the same workload against an extracted older plugin package.
const { Sessions } = await import(process.argv[2] ? pathToFileURL(process.argv[2]) : new URL('../../src/main/common/sessions.js', import.meta.url));

const root = await mkdtemp(join(tmpdir(), 'agent-replay-bench-'));
try {
  const storage = new Storage(root);
  const pty = fakePty();
  const sessions = new Sessions({ storage, spawn: pty.spawn, guard: (_, work) => work(),
    adapter: () => ({ buildLaunch: () => ({ command: 'fixture', args: [], env: {} }) }) });
  for (let index = 0; index < 12; index++) {
    const record = await sessions.create('benchmark', { adapterId: 'fixture', cwd: root });
    sessions.bufferOutput(sessions.get('benchmark', record.id), 'x'.repeat(2 * 1024 * 1024));
  }
  global.gc();
  const initial = process.memoryUsage();
  let peakRss = initial.rss;
  let peakHeap = initial.heapUsed;
  const chunk = '中😀'.repeat(290) + '\x1b[Hredraw\r\n';
  const started = performance.now();
  for (let frame = 0; frame < 300; frame++) {
    for (const session of sessions.active.values()) {
      sessions.bufferOutput(session, chunk);
    }
    if (frame % 50 === 0) {
      for (const session of sessions.active.values()) {
        sessions.attach('benchmark', session.id);
      }
    }
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }
  const elapsedMs = performance.now() - started;
  const replayBytes = [...sessions.active.values()].map(session => Buffer.byteLength(sessions.attach('benchmark', session.id).data));
  global.gc();
  console.log(JSON.stringify({ sessions: sessions.active.size, frames: 300, incomingMiB: Buffer.byteLength(chunk) * 300 * 12 / 1048576,
    elapsedMs, initialRssMiB: initial.rss / 1048576, peakRssMiB: peakRss / 1048576,
    peakHeapMiB: peakHeap / 1048576, retainedHeapMiB: process.memoryUsage().heapUsed / 1048576,
    maxReplayBytes: Math.max(...replayBytes) }));
} finally {
  await rm(root, { recursive: true, force: true });
}
