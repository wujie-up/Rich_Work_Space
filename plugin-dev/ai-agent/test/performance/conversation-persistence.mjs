import { Conversations } from '../../src/main/common/conversations.js';
let release;
let writes = 0;
let bytes = 0;
const gate = new Promise(resolve => { release = resolve; });
const service = new Conversations({ pluginId: 'benchmark', storage: { async writeJson(key, value) {
  await gate;
  const json = JSON.stringify(value);
  bytes += Buffer.byteLength(json);
  writes += 1;
} }, emit() {} });
const record = { id: '00000000-0000-4000-8000-000000000001', events: [] };
global.gc();
const startHeap = process.memoryUsage().heapUsed;
const start = performance.now();
for (let i = 0; i < 600; i += 1) {
  service.event(record, { method: 'item/agentMessage/delta', params: { delta: `${i}:` + 'x'.repeat(1024) } });
}
global.gc();
const queuedHeapMiB = (process.memoryUsage().heapUsed - startHeap) / 1048576;
const enqueueMs = performance.now() - start;
release();
await service.writes;
console.log(JSON.stringify({ events: record.events.length, writes, serializedMiB: bytes / 1048576, queuedHeapMiB, enqueueMs, totalMs: performance.now() - start }));
