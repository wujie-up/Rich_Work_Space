import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Capabilities } from '../../src/main/common/capabilities.js';
import { Storage } from '../../src/main/common/storage.js';

// Benchmark a private copy: recovery must never rewrite the user's live invocation history.
const source = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'deckpg-recovery-benchmark-'));
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
try {
  await cp(join(source, 'capability-invocations'), join(root, 'capability-invocations'), { recursive: true });
  const storage = new Storage(root);
  const names = (await readdir(join(root, 'capability-invocations'))).filter(name => /^[\w-]+\.json$/.test(name));
  const started = performance.now();
  let unfinished = 0;
  for (const name of names) {
    const record = await storage.readJson(`capability-invocations/${name}`);
    unfinished += Number(!terminal.has(record.state));
  }
  const baselineMs = performance.now() - started;
  const create = () => new Capabilities({ storage, loaded: new Map(), usable: () => true });
  const migrationStarted = performance.now();
  await create().load();
  const migrationMs = performance.now() - migrationStarted;
  const readJson = storage.readJson.bind(storage);
  let historyReads = 0;
  storage.readJson = (key, ...args) => {
    historyReads += Number(key.startsWith('capability-invocations/'));
    return readJson(key, ...args);
  };
  const optimizedMs = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const loadStarted = performance.now();
    await create().load();
    optimizedMs.push(Number((performance.now() - loadStarted).toFixed(2)));
  }
  assert.equal(historyReads, 0);
  assert.equal((await readdir(join(root, 'capability-invocations'))).length, names.length);
  console.info(JSON.stringify({ records: names.length, unfinished, baselineMs: Math.round(baselineMs),
    migrationMs: Math.round(migrationMs), optimizedMs, historyReads }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
