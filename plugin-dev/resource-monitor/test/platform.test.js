import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcesses, parseNetwork, createPlatform } from '../src/main/os/mac/index.js';

test('macOS process snapshot parses start identity, cumulative CPU and RSS including long running processes', () => {
  const rows = parseProcesses('   10 1 Mon Oct 26 14:13:41 2026  103:17.81 2048\n11 10 Mon Oct 26 14:13:42 2026 01:02:03.20 512\n');
  assert.equal(rows[0].cpuMs, 6197810);
  assert.equal(rows[0].rss, 2097152);
  assert.equal(rows[1].cpuMs, 3723200);
  assert.notEqual(rows[0].start, rows[1].start);
  assert.throws(() => parseProcesses('invalid output'), /进程/);
});

test('nettop parser uses header names and final PID suffix, rejects malformed metrics', () => {
  const rows = parseNetwork(',bytes_out,bytes_in,\nA process.name.10,42,128,\nworker.11,0,10,\n');
  assert.deepEqual(rows.get(10), { received: 128, sent: 42 });
  assert.equal(parseNetwork(',bytes_in,bytes_out,\n').size, 0);
  assert.throws(() => parseNetwork('permission denied'), /网络/);
  assert.throws(() => parseNetwork(',bytes_in,bytes_out,\nworker.10,no,2,\n'), /网络/);
});

test('macOS sampler excludes its own short-lived collectors so they do not invalidate every CPU delta',
  { skip: process.platform !== 'darwin' }, async () => {
    const registrations = [];
    const platform = createPlatform({ ownProcesses: pids => registrations.push(pids) });
    try {
      const snapshot = await platform.sample({ signal: new AbortController().signal });
      assert.equal(snapshot.processError, null);
      assert.ok(snapshot.processes.every(row => row.ppid !== process.pid), 'collector children must not appear as monitored work');
      assert.ok(registrations.some(pids => pids.length === 2), 'only live collectors are registered for crash cleanup');
      assert.deepEqual(registrations.at(-1), []);
    } finally {
      await platform.close();
    }
  });
