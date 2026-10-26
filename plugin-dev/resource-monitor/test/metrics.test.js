import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../src/main/common/metrics.js';

const owners = [{ pluginId: 'one', name: 'One', instanceId: 'a', pid: 10, ownedPids: [11] },
  { pluginId: 'two', name: 'Two', instanceId: 'b', pid: 20, ownedPids: [] }];
const processRow = (pid, ppid, cpuMs, rss = 1000, start = 'first') => ({ pid, ppid, cpuMs, rss, start });
const sample = (time, cpuMs, network = new Map([[11, { received: time * 2, sent: time }]])) => ({ time, cores: 4,
  processes: [processRow(10, 1, cpuMs), processRow(11, 10, cpuMs), processRow(12, 11, cpuMs), processRow(20, 1, 0)], network });

test('deduplicates overlapping process roots and computes whole-machine CPU and bytes per second', () => {
  const previous = aggregate(owners, sample(1000, 0));
  assert.equal(previous.rows[0].cpu, null);
  const value = aggregate(owners, sample(3000, 1000), previous.baseline);
  assert.equal(value.rows[0].processCount, 3);
  assert.equal(value.rows[0].memory, 3000);
  assert.equal(value.rows[0].cpu, 37.5);
  assert.equal(value.rows[0].received, 2000);
  assert.equal(value.rows[0].sent, 1000);
  assert.equal(value.total.memory, 4000);
});

test('a nested plugin root owns its descendants once, reused PIDs and instances reset CPU baselines', () => {
  const first = sample(1000, 100);
  first.processes[1].ppid = 20;
  const value = aggregate([{ ...owners[0], ownedPids: [] }, owners[1]], first);
  assert.equal(value.rows[0].processCount, 1);
  assert.equal(value.rows[1].processCount, 3);
  const next = sample(3000, 200);
  next.processes[0].start = 'reused';
  const updated = aggregate(owners, next, value.baseline);
  assert.equal(updated.rows[0].cpu, null);
  assert.equal(aggregate([{ ...owners[0], instanceId: 'new' }], next, updated.baseline).rows[0].cpu, null);
});

test('network failure leaves CPU and RSS usable; lost counters, process failures and backwards time are not fake zeros', () => {
  const previous = aggregate(owners, sample(1000, 0));
  const value = aggregate(owners, { ...sample(3000, 1000), network: null, networkError: 'permission denied' }, previous.baseline);
  assert.equal(value.rows[0].cpu, 37.5);
  assert.equal(value.rows[0].received, null);
  assert.equal(value.networkError, 'permission denied');
  assert.equal(aggregate(owners, sample(3000, 1000, new Map([[11, { received: 1, sent: 1 }]])),
    previous.baseline).rows[0].received, null);
  assert.equal(aggregate(owners, { time: 5000, cores: 4, processes: null, processError: 'failed', network: null }).total.memory, null);
  assert.equal(aggregate(owners, sample(500, 100), previous.baseline).rows[0].cpu, null);
});

test('registered roots that disappear or change start identity are retired instead of attributing unrelated reused PIDs', () => {
  const first = aggregate(owners, sample(1000, 0));
  const reused = sample(3000, 1000);
  reused.processes[1] = processRow(11, 1, 1000, 900000, 'unrelated');
  reused.processes = reused.processes.filter(row => row.pid !== 12);
  const next = aggregate(owners, reused, first.baseline);
  assert.equal(next.rows[0].memory, 1000);
  assert.equal(next.rows[0].processCount, 1);
  const again = aggregate(owners, { ...reused, time: 5000 }, next.baseline);
  assert.equal(again.rows[0].memory, 1000);
  const vanished = aggregate(owners, { ...sample(3000, 1000), processes: [processRow(10, 1, 1000), processRow(20, 1, 0)] }, first.baseline);
  assert.equal(aggregate(owners, reused, vanished.baseline).rows[0].memory, 1000);
});
