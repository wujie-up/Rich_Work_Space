import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceMonitor } from '../src/main/common/monitor.js';

function setup(options = {}) {
  const scheduled = [];
  const writes = [];
  let time = 0;
  const monitor = new ResourceMonitor({
    directory: async () => ({ version: 1, plugins: [{ pluginId: 'test', name: 'Test', instanceId: 'a', pid: 10, ownedPids: [] }] }),
    platform: { sample: async () => ({ time: time += 2000, cores: 1,
      processes: [{ pid: 10, ppid: 1, start: 'a', cpuMs: time / 2, rss: 1000 }], network: new Map() }), close: async () => {} },
    readSettings: async () => ({ interval: 5, defaultCollapsed: true }), writeSettings: async value => writes.push(value),
    schedule: fn => { scheduled.push(fn); return 1; }, cancel: () => {}, ...options
  });
  return { monitor, scheduled, writes };
}

test('one sampler shares a bounded history, persisted settings and current data across views', async () => {
  const { monitor, scheduled, writes } = setup();
  await monitor.start();
  await monitor.start();
  assert.equal(scheduled.length, 1);
  for (let i = 0; i < 125; i++) {
    await scheduled.shift()();
  }
  assert.equal(monitor.snapshot().history.length, 120);
  assert.equal(monitor.snapshot().latest.total.cpu, 50);
  assert.equal(monitor.snapshot().settings.defaultCollapsed, true);
  await monitor.updateSettings({ interval: 2 });
  assert.deepEqual(writes[0], { interval: 2, defaultCollapsed: true });
  await assert.rejects(monitor.updateSettings({ interval: 1 }), /间隔/);
  await monitor.stop();
});

test('stop aborts in-flight commands, prevents new samples, and awaits collector cleanup', async () => {
  let started;
  let closed = false;
  const began = new Promise(resolve => { started = resolve; });
  const { monitor, scheduled } = setup({ platform: { sample: ({ signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }), close: async () => { closed = true; } } });
  await monitor.start();
  const sample = scheduled.shift()();
  await began;
  assert.equal(scheduled.length, 0);
  await monitor.stop();
  await sample;
  assert.equal(closed, true);
  assert.equal(scheduled.length, 0);
  assert.equal(monitor.snapshot().running, false);
});

test('directory failures mark old data stale and recover on the next scheduled sample', async () => {
  let fail = true;
  const { monitor, scheduled } = setup({ directory: async () => {
    if (fail) {
      throw Error('directory unavailable');
    }
    return { version: 1, plugins: [] };
  } });
  await monitor.start();
  await scheduled.shift()();
  assert.match(monitor.snapshot().error, /directory unavailable/);
  fail = false;
  await scheduled.shift()();
  assert.equal(monitor.snapshot().error, null);
  assert.deepEqual(monitor.snapshot().latest.rows, []);
  await monitor.stop();
});
