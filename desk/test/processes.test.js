import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { stopProcessGroups } from '../src/main/os/posix/processes.js';

async function childProcess(t, source, options = {}) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], ...options });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGCONT');
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  return { child, value: (await once(child, 'message'))[0] };
}

async function waitUntil(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) {
      return;
    }
    await delay(20);
  }
  assert.fail('owned test processes did not reach the expected state');
}

const state = pid => execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).trim().split('\n')
  .map(line => line.trim().split(/\s+/)).find(row => Number(row[0]) === pid)?.[1];

test('zombie-only group does not fail cleanup or leave another group running', async t => {
  const parent = await childProcess(t, `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, stdio: 'ignore' });
    child.on('spawn', () => process.send(child.pid));
    setInterval(()=>{},1000);
  `);
  parent.child.kill('SIGSTOP');
  await waitUntil(() => state(parent.child.pid)?.includes('T'));
  process.kill(parent.value, 'SIGKILL');
  await waitUntil(() => state(parent.value)?.startsWith('Z'));
  const live = await childProcess(t, "process.send(process.pid);setInterval(()=>{},1000)", { detached: true });
  await stopProcessGroups([parent.value, live.value]);
  await waitUntil(() => !state(live.value));
});

test('a real permission error remains visible while other owned groups are still cleaned', async t => {
  const denied = await childProcess(t, "process.send(process.pid);setInterval(()=>{},1000)", { detached: true });
  const live = await childProcess(t, "process.send(process.pid);setInterval(()=>{},1000)", { detached: true });
  const kill = process.kill;
  const mock = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -denied.value) {
      throw Object.assign(Error('kill EPERM'), { code: 'EPERM' });
    }
    return kill(pid, signal);
  });
  try {
    await assert.rejects(stopProcessGroups([denied.value, live.value]), /EPERM/);
    await waitUntil(() => !state(live.value));
    assert.ok(state(denied.value));
  } finally {
    mock.mock.restore();
  }
});

test('EPERM during an already-started exit is resolved only after the group has stopped', async t => {
  const live = await childProcess(t,
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(),100));process.send(process.pid);setInterval(()=>{},1000)",
    { detached: true });
  const kill = process.kill;
  const mock = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -live.value && signal === 'SIGTERM') {
      kill(live.value, 'SIGTERM');
      throw Object.assign(Error('kill EPERM'), { code: 'EPERM' });
    }
    return kill(pid, signal);
  });
  try {
    await stopProcessGroups([live.value]);
    assert.equal(state(live.value), undefined);
  } finally {
    mock.mock.restore();
  }
});

test('cleanup escalates to SIGKILL for an owned process ignoring SIGTERM', async t => {
  const live = await childProcess(t,
    "process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>{},1000)", { detached: true });
  await stopProcessGroups([live.value]);
  await waitUntil(() => !state(live.value));
  assert.equal(live.child.signalCode, 'SIGKILL');
});

test('SIGKILL is still attempted when SIGTERM fails for a live group', async t => {
  const live = await childProcess(t, "process.send(process.pid);setInterval(()=>{},1000)", { detached: true });
  const kill = process.kill;
  const mock = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -live.value && signal === 'SIGTERM') {
      throw Object.assign(Error('kill EPERM'), { code: 'EPERM' });
    }
    return kill(pid, signal);
  });
  try {
    await stopProcessGroups([live.value]);
    await waitUntil(() => !state(live.value));
    assert.equal(live.child.signalCode, 'SIGKILL');
  } finally {
    mock.mock.restore();
  }
});
