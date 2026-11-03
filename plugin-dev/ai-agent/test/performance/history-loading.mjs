import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Storage } from '../../../../desk/src/main/common/storage.js';
import { Conversations } from '../../src/main/common/conversations.js';
const root = await mkdtemp(join(tmpdir(), 'deckpg-history-bench-'));
try {
  const storage = new Storage(root);
  const pluginId = 'history-benchmark';
  const ids = [];
  for (let i = 0; i < 100; i++) {
    const id = randomUUID();
    ids.push(id);
    await storage.writeJson(`plugin-data/${pluginId}/conversations/${id}.json`, { id, name: `history-${i}`, state: 'idle',
      updatedAt: new Date().toISOString(), events: [{ method: 'item/agentMessage/delta', params: { delta: 'x'.repeat(256 * 1024) } }] });
  }
  // Build any disposable index before measuring the repeat-start path.
  await new Conversations({ storage, pluginId }).load();
  global.gc();
  const startHeap = process.memoryUsage().heapUsed;
  let bodyReads = 0;
  const readJson = storage.readJson.bind(storage);
  storage.readJson = (key, fallback) => {
    if (key.includes('/conversations/')) { bodyReads++; }
    return readJson(key, fallback);
  };
  const service = new Conversations({ storage, pluginId });
  const start = performance.now();
  await service.load();
  global.gc();
  const startupHeapMiB = (process.memoryUsage().heapUsed - startHeap) / 1048576;
  const startupMs = performance.now() - start;
  const startupBodyReads = bodyReads;
  for (const id of ids) { await service.read(id); }
  global.gc();
  console.log(JSON.stringify({ records: service.list().length, startupBodyReads, startupHeapMiB, startupMs,
    afterBrowseHeapMiB: (process.memoryUsage().heapUsed - startHeap) / 1048576,
    retainedBodies: [...service.records.values()].filter(value => value.events).length }));
} finally {
  await rm(root, { recursive: true, force: true });
}
