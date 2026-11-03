import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desk-native-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, 'DeskPG.app/Contents/Resources');
  const native = join(resources, 'app.asar.unpacked/node_modules/node-pty');
  await mkdir(native, { recursive: true });
  return { native, context: { electronPlatformName: 'darwin', appOutDir: root,
    packager: { getResourcesDir: () => resources } } };
}

test('mac packaging repairs shipped spawn helpers before signing without changing other files', async t => {
  const { native, context } = await fixture(t);
  const helpers = ['build/Release/spawn-helper', 'prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper'];
  for (const relative of helpers) {
    const file = join(native, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '#!/bin/sh\nprintf pty-ready\n');
    await chmod(file, 0o640);
  }
  const module = join(native, 'build/Release/pty.node');
  await writeFile(module, 'native-module');
  await chmod(module, 0o644);
  await assert.rejects(run(join(native, helpers[0])), { code: 'EACCES' });
  const { default: prepareNativeRuntime } = await import('../build/prepare-native-runtime.mjs');
  await prepareNativeRuntime(context);
  await prepareNativeRuntime(context);
  for (const relative of helpers) {
    const file = join(native, relative);
    assert.equal((await stat(file)).mode & 0o777, 0o751);
    assert.equal((await run(file)).stdout, 'pty-ready');
  }
  assert.equal((await stat(module)).mode & 0o777, 0o644);
  assert.equal(await readFile(module, 'utf8'), 'native-module');
});

test('mac packaging fails when no spawn helper is shipped', async t => {
  const { context } = await fixture(t);
  const { default: prepareNativeRuntime } = await import('../build/prepare-native-runtime.mjs');
  await assert.rejects(prepareNativeRuntime(context), /spawn-helper/);
});

test('non-mac packaging does not require a mac native runtime', async () => {
  const { default: prepareNativeRuntime } = await import('../build/prepare-native-runtime.mjs');
  await prepareNativeRuntime({ electronPlatformName: 'win32' });
});
