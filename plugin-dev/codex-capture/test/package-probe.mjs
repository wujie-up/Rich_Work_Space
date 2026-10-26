import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withPackageSource } from '../../../desk/src/main/common/plugin-package.js';

const root = await mkdtemp(join(tmpdir(), 'capture-worker-probe-'));
const workers = [];
function worker() {
  const child = fork(resolve('desk/src/main/common/plugin-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  workers.push(child);
  let sequence = 0;
  return { child, call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { child.off('message', listener); reject(Error(`Worker timeout: ${method}`)); }, 5000);
      const listener = message => {
        if (message.id !== id) { return; }
        clearTimeout(timer);
        child.off('message', listener);
        if (message.error) { reject(Error(message.error.message)); } else { resolve(message.value); }
      };
      child.on('message', listener);
      child.send({ id, method, args, deadline: Date.now() + 5000 });
    });
  } };
}

try {
  await withPackageSource('plugin-dev/dist/codex-capture-0.2.0.plg', async directory => {
    let capture = worker();
    const sibling = worker();
    const fixture = join(root, 'sibling');
    await mkdir(fixture);
    await writeFile(join(fixture, 'plugin.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(join(fixture, 'index.mjs'), 'export function activate(c) { c.methods.register("echo.value", v => v); } export function deactivate() {}');
    await sibling.call('$activate', { id: 'sibling', directory: fixture, root });
    await capture.call('$activate', { id: 'codex-capture', directory, root });
    const status = await capture.call('capture.status');
    assert.equal(status.state, 'unselected');
    await capture.call('$stop', 'disable');
    await capture.call('$deactivate');
    assert.equal(await sibling.call('echo.value', 'after graceful close'), 'after graceful close');
    capture = worker();
    await capture.call('$activate', { id: 'codex-capture', directory, root });
    const exit = once(capture.child, 'exit');
    capture.child.kill('SIGKILL');
    await exit;
    assert.equal(await sibling.call('echo.value', 'after capture crash'), 'after capture crash');
    console.log('PASS: package integrity, isolated worker activation, OS adapter, graceful viewer shutdown and sibling survival after crash');
  });
} finally {
  await Promise.all(workers.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) { return; }
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
  }));
  await rm(root, { recursive: true, force: true });
}
