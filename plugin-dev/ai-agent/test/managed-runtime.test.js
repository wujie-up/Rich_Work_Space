import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

test('isolated environment does not inherit system credentials or user config and uses native OS path', () => {
  process.env.OPENAI_API_KEY = 'must-not-copy';
  const env = isolatedEnvironment('/managed/profile');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HOME, '/managed/profile/home');
  assert.equal(env.CODEX_HOME, '/managed/profile/codex');
  assert.equal(env.PATH.includes('/usr/local'), false);
  delete process.env.OPENAI_API_KEY;
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
