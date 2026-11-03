import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as tar from 'tar';
import { ManagedRuntime, isolatedEnvironment } from '../src/main/common/managed-runtime.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-runtime-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'codex'), 'native-fixture', { mode: 0o700 });
  const archive = join(root, 'engine.tar.gz');
  await tar.c({ cwd: source, file: archive, gzip: true }, ['codex']);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const pin = { runtimeId: 'codex-test', version: '1.0.0', platform: 'test', entry: 'codex', sha256, url: 'https://example.invalid/engine' };
  return { root, archive, pin };
}

test('managed runtime validates archive and protocol before atomic publication, preserves ready runtime on failure', async t => {
  const { root, archive, pin } = await fixture(t);
  let probes = 0;
  const runtime = new ManagedRuntime({ root, pin, tar, probe: async () => { probes++; } });
  const installed = await runtime.install(archive);
  assert.equal(installed.runtimeId, pin.runtimeId);
  assert.equal(probes, 1);
  assert.equal((await runtime.status()).state, 'ready');
  await writeFile(archive, 'corrupt');
  await assert.rejects(runtime.install(archive), /校验/);
  assert.equal((await runtime.status()).state, 'ready');
  assert.equal(await readFile(installed.command, 'utf8'), 'native-fixture');
});

test('runtime rejects failed protocol without publishing', async t => {
  const { root, archive, pin } = await fixture(t);
  const runtime = new ManagedRuntime({ root, pin, tar, probe: async () => { throw Error('protocol mismatch'); } });
  await assert.rejects(runtime.install(archive), /protocol mismatch/);
  assert.equal((await runtime.status()).state, 'missing');
});

test('isolated environment does not inherit system credentials or user config', t => {
  const previousKey = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previousKey === undefined) { delete process.env.OPENAI_API_KEY; }
    else { process.env.OPENAI_API_KEY = previousKey; }
  });
  process.env.OPENAI_API_KEY = 'must-not-copy';
  const env = isolatedEnvironment('/managed/profile');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HOME, '/managed/profile/home');
  assert.equal(env.CODEX_HOME, '/managed/profile/codex');
  assert.equal(env.XDG_CONFIG_HOME, '/managed/profile/config');
});

test('managed tools can resolve local helpers without inheriting the host profile or credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ai-native-path-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) { delete process.env.PATH; }
    else { process.env.PATH = previousPath; }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'browser-helper'), '#!/bin/sh\nprintf NATIVE_HELPER_OK', { mode: 0o700 });
  process.env.PATH = `${root}:/usr/bin:/bin`;
  const { stdout } = await promisify(execFile)('browser-helper', [], { env: isolatedEnvironment(join(root, 'profile')) });
  assert.equal(stdout, 'NATIVE_HELPER_OK');
});

test('managed PATH retains standard package manager directories when launched outside a terminal', t => {
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) { delete process.env.PATH; }
    else { process.env.PATH = previousPath; }
  });
  process.env.PATH = '/usr/bin:/bin';
  const paths = isolatedEnvironment('/managed/profile').PATH.split(':');
  assert.ok(paths.includes('/usr/local/bin'));
  if (process.platform === 'darwin') {
    assert.ok(paths.includes('/opt/homebrew/bin'));
  }
});

test('runtime rejects an archive symlink even with an otherwise valid pinned digest', async t => {
  const { root, archive, pin } = await fixture(t);
  await symlink('/tmp/outside', join(root, 'source', 'link'));
  await tar.c({ cwd: join(root, 'source'), file: archive, gzip: true }, ['codex', 'link']);
  pin.sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const runtime = new ManagedRuntime({ root, pin, tar, probe: async () => assert.fail('must not execute unsafe package') });
  await assert.rejects(runtime.install(archive), /不安全路径/);
  assert.equal((await runtime.status()).state, 'missing');
});

test('updating active version retains the historical runtime and failed update leaves the active index intact', async t => {
  const { root, archive, pin } = await fixture(t);
  const old = new ManagedRuntime({ root, pin, tar, probe: async () => {} });
  await old.install(archive);
  const newer = new ManagedRuntime({ root, pin: { ...pin, runtimeId: 'codex-new', version: '2.0.0' }, tar, probe: async () => {} });
  await newer.install(archive);
  assert.equal((await old.status()).version, '2.0.0');
  assert.equal((await newer.launch('default', 'codex-test')).runtimeVersion, '1.0.0');
  const broken = new ManagedRuntime({ root, pin: { ...pin, runtimeId: 'codex-bad', version: '3.0.0' }, tar,
    probe: async () => { throw Error('bad protocol'); } });
  await assert.rejects(broken.install(archive), /bad protocol/);
  assert.equal((await newer.status()).version, '2.0.0');
});


test('explicit historical runtime remains launchable after removing the active index', async t => {
  const { root, archive, pin } = await fixture(t);
  const runtime = new ManagedRuntime({ root, pin, tar, probe: async () => {} });
  await runtime.install(archive);
  await rm(join(root, 'runtimes', 'index.json'));
  assert.equal((await runtime.status()).state, 'missing');
  assert.equal((await runtime.status(pin.runtimeId)).state, 'ready');
  assert.equal((await runtime.launch('default', pin.runtimeId)).runtimeVersion, pin.version);
});
