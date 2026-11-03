import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { macPlatform } from '../src/main/os/mac/index.js';

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') { return false; }
    throw error;
  }
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wd-bundled-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'DeskLinkMac');
  await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o755 });
  const reports = [];
  const platform = macPlatform({ pluginId: 'web-access', ownProcesses: pids => reports.push(pids) });
  assert.equal(typeof platform.createAssistant, 'function', 'macOS platform must provide the bundled assistant');
  const assistant = platform.createAssistant(executable);
  t.after(async () => {
    await assistant.stop();
  });
  return { assistant, reports, executable };
}

test('bundled helper starts once, registers its live PID and stops only its child', async t => {
  const { assistant, reports } = await fixture(t);
  assert.equal(assistant.running, false);
  await Promise.all([assistant.open(), assistant.open()]);
  assert.equal(reports.length, 1);
  const pid = reports[0][0];
  assert.equal(alive(pid), true);
  assert.equal(assistant.running, true);
  await assistant.open();
  assert.equal(reports.length, 1);
  await assistant.stop();
  assert.equal(alive(pid), false);
  assert.equal(assistant.running, false);
  assert.deepEqual(reports.at(-1), []);
  assert.equal(alive(process.pid), true);
  await assert.rejects(assistant.open(), /停止/);
});

test('helper crash clears owned PID and permits reopening; stop races cannot orphan a launch', async t => {
  const { assistant, reports } = await fixture(t);
  await assistant.open();
  process.kill(reports[0][0], 'SIGKILL');
  for (let attempt = 0; assistant.running && attempt < 100; attempt++) { await delay(10); }
  assert.equal(assistant.running, false);
  assert.deepEqual(reports.at(-1), []);
  const opening = assistant.open();
  const stopping = assistant.stop();
  await Promise.allSettled([opening, stopping]);
  assert.equal(assistant.running, false);
  for (const pids of reports) {
    for (const pid of pids) { assert.equal(alive(pid), false); }
  }
});

test('missing helper fails with no owned PID and can be retried', async t => {
  const { assistant, reports, executable } = await fixture(t);
  await rm(executable);
  await assert.rejects(assistant.open(), /ENOENT/);
  assert.equal(assistant.running, false);
  assert.equal(reports.some(pids => pids.length), false);
  await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o755 });
  await assistant.open();
  assert.equal(assistant.running, true);
});

test('registration failure kills the launched child instead of leaving an untracked helper', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wd-assistant-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'DeskLinkMac');
  await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o755 });
  let pid;
  const assistant = macPlatform({ pluginId: 'web-access', ownProcesses: pids => {
    if (pids.length) {
      [pid] = pids;
      throw Error('进程登记失败');
    }
  } }).createAssistant(executable);
  t.after(() => assistant.stop());
  await assert.rejects(assistant.open(), /进程登记失败/);
  assert.equal(alive(pid), false);
  assert.equal(assistant.running, false);
});
